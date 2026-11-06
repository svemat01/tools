/**
 * Filesystem discovery, output planning and safe writes.
 *
 * Commands never overwrite an existing file unless `overwrite` is explicitly
 * true. When an output already exists the planner picks `name-1.ext`,
 * `name-2.ext`, ... instead of clobbering it.
 */

import { existsSync } from "node:fs";
import { chmod, link, lstat, mkdir, open, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { runCommand } from "./process.ts";

export const IGNORE_DIRECTORIES = new Set([
  ".git",
  ".hg",
  ".svn",
  ".next",
  ".nuxt",
  ".output",
  ".turbo",
  ".cache",
  ".venv",
  ".yarn",
  "node_modules",
  "bower_components",
  "dist",
  "build",
  "coverage",
  "out",
  "vendor",
  "venv",
]);

export interface DiscoverOptions {
  readonly cwd: string;
  /** Extensions without a leading dot; case-insensitive. */
  readonly extensions?: readonly string[];
  /** Defaults to true for directories. */
  readonly recursive?: boolean;
  /** Skip files larger than this many bytes. */
  readonly maxBytes?: number;
  /** Use `git ls-files` for directories when available, respecting .gitignore. */
  readonly respectGitIgnore?: boolean;
  /** Include dot-directories when walking (they are skipped by default). */
  readonly includeHidden?: boolean;
}

export interface DiscoveryResult {
  /** Absolute paths, sorted and de-duplicated. */
  readonly files: readonly string[];
  readonly missing: readonly string[];
  readonly unsupported: readonly string[];
  readonly errors: readonly { readonly path: string; readonly error: string }[];
}

/** Resolve `~`, relative paths and `.` against a command's cwd. */
export function resolvePath(cwd: string, value: string): string {
  if (value === "~") return process.env.HOME ?? value;
  if (value.startsWith("~/")) return join(process.env.HOME ?? "~", value.slice(2));
  return isAbsolute(value) ? resolve(value) : resolve(cwd, value);
}

export function extensionOf(path: string): string {
  return extname(path).replace(/^\./, "").toLowerCase();
}

export function hasExtension(path: string, extensions: readonly string[]): boolean {
  const extension = extensionOf(path);
  return extensions.some((candidate) => candidate.replace(/^\./, "").toLowerCase() === extension);
}

export function displayPath(cwd: string, path: string): string {
  const rel = relative(cwd, path);
  if (!rel) return ".";
  return rel.startsWith(`..${sep}`) || rel === ".." ? path : rel;
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

export async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

export async function ensureDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}

/** `name.ext` -> `name-1.ext`, then `name-2.ext`, ... */
export function nextAvailablePath(desired: string): string {
  if (!existsSync(desired)) return desired;
  const directory = dirname(desired);
  const base = basename(desired);
  const extension = extname(base);
  const stem = extension ? base.slice(0, -extension.length) : base;
  for (let counter = 1; counter < 10_000; counter++) {
    const candidate = join(directory, `${stem}-${counter}${extension}`);
    if (!existsSync(candidate)) return candidate;
  }
  throw new Error(`Could not find an available output name for ${desired}`);
}

export interface PlanOutputOptions {
  readonly input: string;
  /** Base directory for relative `out`/`outDir` values. */
  readonly cwd: string;
  /** Output extension without the dot. Defaults to the input extension. */
  readonly extension?: string;
  /** Inserted before the extension, e.g. `_resized`. */
  readonly suffix?: string;
  /** Explicit output file (single-input commands only). */
  readonly out?: string;
  /** Output directory for batch commands. */
  readonly outDir?: string;
  readonly overwrite?: boolean;
  /** Destinations reserved by this batch, including during dry runs. */
  readonly reserved?: Set<string>;
}

/**
 * Choose an output path without touching the filesystem beyond existence
 * checks. Existing files are never selected unless `overwrite` is true.
 */
export async function planOutputPath(options: PlanOutputOptions): Promise<string> {
  const { input, overwrite = false } = options;
  const inputExtension = extname(input);
  const extension = options.extension ?? inputExtension.replace(/^\./, "");
  const suffix = options.suffix ?? "";
  const stem = basename(input, inputExtension);

  let target: string;
  if (options.out !== undefined) {
    const explicit = resolve(options.cwd, options.out);
    // An existing directory (or a trailing separator) means "put it here".
    if (options.out.endsWith(sep) || (await isDirectory(explicit))) {
      target = join(explicit, `${stem}${suffix}.${extension}`);
    } else {
      target = explicit;
    }
  } else if (options.outDir !== undefined) {
    target = join(resolve(options.cwd, options.outDir), `${stem}${suffix}.${extension}`);
  } else {
    target = join(dirname(input), `${stem}${suffix}.${extension}`);
  }

  if (!overwrite) {
    // Writing the source back onto itself is an overwrite even when the path
    // was not named explicitly.
    if (resolve(target) === resolve(input)) {
      target = join(dirname(input), `${stem}${suffix || "-optimized"}.${extension}`);
    }
    target = nextAvailablePath(target);
  }
  if (options.reserved) {
    const directory = dirname(target);
    const extension = extname(target);
    const stem = basename(target, extension);
    const desired = target;
    let counter = 1;
    while (options.reserved.has(target)) {
      if (counter >= 10_000) throw new Error(`Could not reserve an output name for ${desired}`);
      target = join(directory, `${stem}-${counter++}${extension}`);
      if (!overwrite) target = nextAvailablePath(target);
    }
    options.reserved.add(target);
  }
  return target;
}

export interface WriteOptions {
  /** Replacement must be explicit; otherwise publication fails if the destination exists. */
  readonly overwrite?: boolean;
  /** Refuse replacement if the destination no longer has these bytes. */
  readonly expectedBytes?: Uint8Array;
}

/** Publish a completed sibling temporary file. Hard-link creation atomically refuses clobbering. */
export async function publishFileAtomic(
  temporary: string,
  path: string,
  options: WriteOptions = {},
): Promise<void> {
  if (!options.overwrite) {
    await chmod(temporary, 0o666 & ~process.umask());
    await link(temporary, path);
    await rm(temporary);
    return;
  }
  let existing;
  try {
    existing = await lstat(path);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  if (existing && !existing.isFile()) throw new Error(`Refusing to replace a non-regular file: ${path}`);
  if (options.expectedBytes !== undefined) {
    if (!existing || !Buffer.from(await readFile(path)).equals(options.expectedBytes)) {
      throw new Error(`${path} changed before writing; re-run the command`);
    }
  }
  await chmod(temporary, existing ? existing.mode & 0o7777 : 0o666 & ~process.umask());
  await rename(temporary, path);
}

/** Write complete bytes before publication, preserving permissions on explicit replacement. */
export async function writeFileAtomic(
  path: string,
  data: Uint8Array,
  options: WriteOptions = {},
): Promise<void> {
  await ensureDirectory(dirname(path));
  const temporary = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`,
  );
  try {
    // Keep staged contents private, even when replacing a restricted file.
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(data);
    } finally {
      await handle.close();
    }
    await publishFileAtomic(temporary, path, options);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function readFileBytes(path: string): Promise<Buffer> {
  return readFile(path);
}

export async function fileSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}

/**
 * Resolve a list of files/directories into image/video/text candidates.
 * Missing paths and unsupported extensions are reported, not thrown, so a
 * batch can continue and the command can exit non-zero at the end.
 */
export async function discoverFiles(
  paths: readonly string[],
  options: DiscoverOptions,
): Promise<DiscoveryResult> {
  const files = new Set<string>();
  const missing: string[] = [];
  const unsupported: string[] = [];
  const errors: { path: string; error: string }[] = [];
  const extensions = options.extensions?.map((value) => value.replace(/^\./, "").toLowerCase());

  for (const value of paths) {
    const target = resolvePath(options.cwd, value);
    let info;
    try {
      info = await stat(target);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") missing.push(target);
      else errors.push({ path: target, error: error instanceof Error ? error.message : String(error) });
      continue;
    }

    if (info.isFile()) {
      if (extensions && !hasExtension(target, extensions)) {
        unsupported.push(target);
      } else if (options.maxBytes === undefined || info.size <= options.maxBytes) {
        files.add(target);
      }
      continue;
    }

    if (!info.isDirectory()) {
      unsupported.push(target);
      continue;
    }

    if (options.recursive === false) {
      unsupported.push(target);
      continue;
    }

    const found = options.respectGitIgnore
      ? ((await gitFiles(target, options, errors)) ?? (await walkFiles(target, options, errors)))
      : await walkFiles(target, options, errors);

    for (const file of found) {
      if (extensions && !hasExtension(file, extensions)) continue;
      const size = await fileSize(file);
      if (options.maxBytes !== undefined && size > options.maxBytes) continue;
      files.add(file);
    }
  }

  return {
    files: [...files].sort((a, b) => a.localeCompare(b)),
    missing,
    unsupported,
    errors,
  };
}

async function walkFiles(
  root: string,
  options: DiscoverOptions,
  errors: { path: string; error: string }[],
): Promise<string[]> {
  const found: string[] = [];
  const extensions = options.extensions?.map((value) => value.replace(/^\./, "").toLowerCase());

  async function visit(directory: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      errors.push({ path: directory, error: error instanceof Error ? error.message : String(error) });
      return;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (IGNORE_DIRECTORIES.has(entry.name)) continue;
        if (!options.includeHidden && entry.name.startsWith(".")) continue;
        await visit(path);
        continue;
      }
      if (!entry.isFile()) continue;
      if (extensions && !hasExtension(path, extensions)) continue;
      found.push(path);
    }
  }

  await visit(root);
  return found;
}

/** `git ls-files` is the most accurate .gitignore implementation available. */
async function gitFiles(
  directory: string,
  options: DiscoverOptions,
  errors: { path: string; error: string }[],
): Promise<string[] | undefined> {
  const top = await runCommand("git", ["-C", directory, "rev-parse", "--show-toplevel"]);
  if (top.code !== 0) return undefined;
  const root = top.stdout.trim();
  if (!root) return undefined;

  const relativeRoot = relative(root, directory) || ".";
  const listed = await runCommand("git", [
    "-C",
    root,
    "ls-files",
    "-z",
    "--cached",
    "--others",
    "--exclude-standard",
    "--",
    relativeRoot,
  ]);
  if (listed.code !== 0) return undefined;

  const files: string[] = [];
  for (const entry of listed.stdout.split("\0")) {
    if (!entry) continue;
    const path = join(root, entry);
    const directories = relative(directory, path).split(sep).slice(0, -1);
    if (
      directories.some(
        (part) => IGNORE_DIRECTORIES.has(part) || (!options.includeHidden && part.startsWith(".")),
      )
    )
      continue;
    try {
      if ((await lstat(path)).isFile()) files.push(path);
    } catch (error) {
      errors.push({ path, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return files;
}

/** Read a text file and detect its byte-order mark, for byte-preserving fixes. */
export interface TextFile {
  readonly path: string;
  readonly bytes: Buffer;
  readonly text: string;
  readonly bom: boolean;
}

export async function readTextFile(path: string): Promise<TextFile> {
  const bytes = await readFile(path);
  const bom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  const body = bom ? bytes.subarray(3) : bytes;
  const text = new TextDecoder("utf-8", { fatal: true }).decode(body);
  return { path, bytes, text, bom };
}

export function encodeTextFile(file: TextFile, text: string): Uint8Array {
  const body = Buffer.from(text, "utf8");
  if (!file.bom) return body;
  return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), body]);
}
