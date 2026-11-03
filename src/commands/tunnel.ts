import { argument, command, description, name, option, schema, toggle } from "@bomb.sh/router";
import { z } from "zod";

import type { AppContext } from "../context.ts";
import { copyToClipboard } from "../lib/clipboard.ts";
import { startTunnel } from "../lib/tunnel.ts";
import { color, useColor } from "../lib/output.ts";
import { defineCommand } from "../kit/index.ts";

export const tunnel = defineCommand(
  command(
    name("tunnel"),
    description("Expose a local HTTP port through a Cloudflare Quick Tunnel"),
    argument(
      name("port"),
      description("Local port to expose (default: 3000)"),
      schema(z.coerce.number().int().min(1).max(65535).default(3000)),
    ),
    option(
      name("host"),
      description("Host cloudflared connects to locally"),
      schema(z.string().default("localhost")),
    ),
    option(name("name"), description("Label used in the exposure warning"), schema(z.string().optional())),
    toggle(name("copy"), description("Copy the public URL to the clipboard when it is ready")),
    toggle(name("json"), description("Print machine-readable JSON when the tunnel starts")),
  ),
  {
    async run({ model }, context: AppContext) {
      const result = await startTunnel({
        port: model.port,
        ...(model.name === undefined ? {} : { name: model.name }),
        copy: model.copy,
        json: model.json,
        cwd: context.cwd,
        env: context.env,
        signal: context.signal,
        stdout: context.stdout,
        stderr: context.stderr,
        copyUrl: (url) => copyToClipboard(url, context.env),
      });

      if (!model.json) {
        const useColour = useColor(context.stdout, context.env);
        context.stdout.write(`${color("Tunnel closed.", "gray", useColour)}\n`);
      }
      return result.code;
    },
  },
);
