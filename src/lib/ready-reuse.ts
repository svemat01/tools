/** Receipt-backed reuse. A recipe identity alone is never evidence of valid output bytes. */
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import sharp from "sharp";

import { renderImageReview } from "./image-review.ts";
import { contentHash, type OperationOptions, type OperationReceipt, readHistory } from "./operations.ts";
import { assertNoSymlinks } from "./project.ts";

export interface ReuseEvidence {
  readonly path: string;
  readonly bytes: Buffer;
  readonly outputHash: string;
  readonly recordId: string;
}

/** Include encoder/settings/source/destination identity. Bump the recipe revision when transform defaults change. */
export function readyRecipe(input: {
  source: string;
  sourceHash: string;
  outDir: string;
  width: number;
  quality: number;
  explicitQuality: boolean;
  format: "webp" | "avif";
}) {
  return contentHash(
    Buffer.from(JSON.stringify({ recipe: "sv-ready-image-v1", ...input, encoder: sharp.versions })),
  );
}
export function reviewRecipe(imageRecipe: string, outputHash: string, filename: string) {
  return contentHash(
    Buffer.from(
      JSON.stringify({
        recipe: "sv-ready-review-v2",
        renderer: renderImageReview.toString(),
        imageRecipe,
        outputHash,
        filename,
      }),
    ),
  );
}

/** Bound cache reads across the plan; absent or modified outputs simply miss reuse. */
export class ReadyReuse {
  private remaining = 64 * 1024 * 1024;
  private constructor(
    private readonly receipts: OperationReceipt[],
    private readonly options: OperationOptions,
  ) {}
  static async load(options: OperationOptions) {
    const receipts = await readHistory(options, { limit: 200, maxBytes: 16 * 1024 * 1024 });
    return new ReadyReuse(receipts, options);
  }
  async find(
    recipeHash: string,
    source: string,
    sourceHash: string,
    outDir: string,
    reserved: ReadonlySet<string>,
  ): Promise<ReuseEvidence | undefined> {
    for (const receipt of this.receipts) {
      if (
        !["applied", "partial"].includes(receipt.status) ||
        receipt.files.some((file) => file.status === "undoing")
      )
        continue;
      for (const file of receipt.files) {
        if (
          file.status !== "applied" ||
          file.kind !== "create" ||
          file.recipeHash !== recipeHash ||
          reserved.has(file.path)
        )
          continue;
        if (
          resolve(dirname(file.path)) !== resolve(outDir) ||
          file.inputs.length !== 1 ||
          file.inputs[0]?.path !== source ||
          file.inputs[0].hash !== sourceHash
        )
          continue;
        this.options.signal?.throwIfAborted();
        try {
          await assertNoSymlinks(file.path);
          const bytes = await readBoundedRegular(file.path, this.remaining);
          this.remaining -= bytes.length;
          if (contentHash(bytes) !== file.afterHash) continue;
          return { path: file.path, bytes, outputHash: file.afterHash, recordId: receipt.id };
        } catch (error) {
          this.options.signal?.throwIfAborted();
          if (
            error instanceof Error &&
            "code" in error &&
            !["ENOENT", "ELOOP", "ENOTDIR"].includes(String(error.code))
          )
            throw error;
          // Missing, edited or non-regular outputs never grant overwrite permission.
        }
      }
    }
    return undefined;
  }
}

export async function readBoundedRegular(path: string, maxBytes: number): Promise<Buffer> {
  if (!(await lstat(path)).isFile()) throw new Error(`Not a regular reuse input: ${path}`);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maxBytes)
      throw new Error(`Reuse verification budget exceeded: ${path}`);
    const data = Buffer.alloc(stat.size + 1);
    let length = 0;
    while (length < data.length) {
      const { bytesRead } = await handle.read(data, length, data.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length !== stat.size) throw new Error(`File changed during reuse verification: ${path}`);
    return data.subarray(0, length);
  } finally {
    await handle.close();
  }
}
