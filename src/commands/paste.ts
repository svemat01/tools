import { extname, resolve } from "node:path";

import { command, description, name, option, schema, toggle } from "@bomb.sh/router";
import { z } from "zod";

import type { AppContext } from "../context.ts";
import { complete, defineCommand, files } from "../kit/index.ts";
import { readClipboard } from "../lib/clipboard.ts";
import { writeFileAtomic } from "../lib/fs.ts";
import { json, shellCommand } from "../lib/output.ts";
import { summarizeClipboard } from "../lib/paste.ts";

export const paste = defineCommand(
  command(
    name("paste"),
    description("Summarize clipboard content privately; explicitly save with --out"),
    option(
      name("out"),
      description("Save exact clipboard bytes to a new file; PNG requires .png"),
      schema(z.string().optional()),
      complete(files()),
    ),
    toggle(name("yes"), description("Approve saving without prompting")),
    toggle(name("json"), description("Print metadata only; saving requires --yes")),
  ),
  {
    async run({ model }, context: AppContext) {
      const payload = await readClipboard({ env: context.env, signal: context.signal });
      const summary = await summarizeClipboard(payload, context.cwd);
      const destination = model.out === undefined ? undefined : resolve(context.cwd, model.out);
      let status: "summary" | "saved" | "declined" = "summary";
      if (destination !== undefined) {
        if (payload.kind === "text" && /\.(png|jpe?g|webp|gif|avif|tiff?|bmp|heic|svg)$/i.test(destination)) {
          throw new Error(
            "Clipboard reader returned text, not image bytes; choose a text destination or use wl-paste/xclip with a PNG selection.",
          );
        }
        if (payload.kind === "image" && extname(destination).toLowerCase() !== ".png") {
          throw new Error(
            "Clipboard contains PNG bytes; choose an --out path ending in .png (no conversion is performed).",
          );
        }
        context.stderr.write(
          `Save ${summary.kind} clipboard content (${summary.bytes} bytes) to ${JSON.stringify(destination)}; refuse overwrite.\n`,
        );
        const approved = model.yes || (!model.json && (await context.confirm("Save clipboard content?")));
        if (approved) {
          context.signal.throwIfAborted();
          await writeFileAtomic(destination, payload.bytes, { mode: 0o600 });
          status = "saved";
        } else status = "declined";
      }
      const program = [
        context.program,
        ...(resolve(context.cwd) === process.cwd() ? [] : ["--cwd", context.cwd]),
      ];
      const command = (...argv: string[]) => shellCommand([...program, ...argv]);
      const suggestions =
        status === "saved" && destination !== undefined
          ? [
              command("inspect", destination),
              ...(summary.kind === "image"
                ? [command("img", "tune", destination)]
                : summary.kind === "jwt"
                  ? [command("jwt", "decode", "--file", destination)]
                  : []),
            ]
          : summary.kind === "image"
            ? [command("paste", "--out", "clipboard.png", "--yes")]
            : summary.kind === "paths"
              ? [command("inspect", "--help")]
              : summary.kind === "jwt"
                ? [command("jwt", "decode", "--help"), command("jwt", "verify", "--help")]
                : [command("paste", "--out", "clipboard.txt", "--yes")];
      const result = {
        command: "paste",
        ...summary,
        status,
        ...(destination === undefined ? {} : { destination }),
        suggestions,
      };
      context.stdout.write(
        model.json
          ? json(result)
          : `${summary.kind}: ${summary.bytes} bytes${payload.kind === "image" ? `, PNG ${payload.width}×${payload.height}` : ""}; ${status}.\n${suggestions.join("\n")}\n${status === "declined" ? "Use --yes to save non-interactively.\n" : ""}`,
      );
      return status === "declined" ? 1 : 0;
    },
  },
);
