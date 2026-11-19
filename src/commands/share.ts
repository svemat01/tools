import { resolve } from "node:path";

import { argument, command, description, name, option, schema, toggle } from "@bomb.sh/router";
import { z } from "zod";

import type { AppContext } from "../context.ts";
import { complete, defineCommand, directories } from "../kit/index.ts";
import { copyToClipboard } from "../lib/clipboard.ts";
import { formatBytes, plural, shellCommand } from "../lib/output.ts";
import { inspectShareDirectory, parseShareService, shareDuration, shareHandler } from "../lib/share.ts";
import { startTunnel } from "../lib/tunnel.ts";

export const share = defineCommand(
  command(
    name("share"),
    description("Start a deliberate local sharing session; --public opts into a Quick Tunnel"),
    argument(
      name("target"),
      description("Static directory, local port, or loopback HTTP(S) URL"),
      schema(z.string()),
      complete(directories()),
    ),
    option(
      name("port"),
      description("Static server port; 0 selects a free port"),
      schema(z.coerce.number().int().min(0).max(65535).default(0)),
    ),
    option(
      name("timeout"),
      description("Stop after a duration, e.g. 30s or 5m"),
      schema(z.string().optional()),
    ),
    toggle(name("public"), description("Expose the target publicly via cloudflared")),
    toggle(name("copy"), description("Copy the ready URL")),
    toggle(name("dryRun"), description("Inspect only; never bind or start a tunnel")),
    toggle(name("preview"), description("Alias for --dry-run")),
    toggle(name("yes"), description("Approve starting without an interactive prompt")),
    toggle(name("json"), description("Emit readiness JSON immediately, then stay alive")),
  ),
  {
    async run({ model }, context: AppContext) {
      context.signal.throwIfAborted();
      const duration = model.timeout === undefined ? undefined : shareDuration(model.timeout);
      const service = parseShareService(model.target);
      if (service && model.port !== 0) throw new Error("--port applies only to static directories");
      const manifest = service
        ? undefined
        : await inspectShareDirectory(resolve(context.cwd, model.target), context.signal);
      const mode = model.public ? "public" : "local";
      const plan = {
        command: "share",
        schemaVersion: 1,
        event: "planned",
        mode,
        target: service ?? manifest!.root,
        ...(manifest
          ? { files: [...manifest.files.keys()], bytes: manifest.bytes, bind: "127.0.0.1", port: model.port }
          : {}),
      };
      const preview = model.dryRun || model.preview;
      const output = preview && !model.json ? context.stdout : context.stderr;
      output.write(
        `${model.public ? "Public sharing: anyone with the URL can access the selected content" : "Local sharing: loopback only"}\nTarget: ${plan.target}\n`,
      );
      if (manifest) {
        output.write(
          `${manifest.files.size} ${plural(manifest.files.size, "file")} · ${formatBytes(manifest.bytes)} · static snapshot\n`,
        );
        for (const name of manifest.files.keys()) output.write(`  ${name}\n`);
      }
      if (service)
        context.stderr.write(
          "The existing service controls its responses and redirects; all of its routes may be exposed. No service request has been made.\n",
        );
      if (preview) {
        if (model.json) context.stdout.write(`${JSON.stringify(plan)}\n`);
        else {
          const command = [
            context.program,
            ...(resolve(context.cwd) === process.cwd() ? [] : ["--cwd", context.cwd]),
            "share",
            model.target,
            ...(model.public ? ["--public"] : []),
            ...(model.port ? ["--port", String(model.port)] : []),
            ...(model.timeout ? ["--timeout", model.timeout] : []),
            ...(model.copy ? ["--copy"] : []),
            "--yes",
          ];
          context.stdout.write(
            `Preview only; no server or tunnel started.\nStart: ${shellCommand(command)}\n`,
          );
        }
        return 0;
      }
      if (!model.yes && (model.json || !(await context.confirm(`Start ${mode} sharing?`)))) {
        context.stderr.write("Sharing not started. Use --yes to approve noninteractively.\n");
        return 1;
      }
      context.signal.throwIfAborted();
      const session = new AbortController();
      const abort = () => session.abort();
      context.signal.addEventListener("abort", abort, { once: true });
      if (context.signal.aborted) abort();
      let server: ReturnType<typeof Bun.serve> | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const ready = (url: string) => {
        context.stdout.write(
          model.json
            ? `${JSON.stringify({ command: "share", schemaVersion: 1, event: "ready", url, mode, target: plan.target })}\n`
            : `${mode === "public" ? "Public" : "Local"} sharing: ${url}\nStop with Ctrl+C${model.timeout ? `; expires after ${model.timeout}` : ""}.\n`,
        );
      };
      try {
        session.signal.throwIfAborted();
        if (duration !== undefined) timer = setTimeout(abort, duration);
        if (manifest)
          server = Bun.serve({ hostname: "127.0.0.1", port: model.port, fetch: shareHandler(manifest) });
        const localUrl = service ?? server!.url.href;
        if (model.public) {
          const result = await startTunnel({
            port: Number(new URL(localUrl).port) || (localUrl.startsWith("https:") ? 443 : 80),
            targetUrl: localUrl,
            onReady: ready,
            cwd: context.cwd,
            env: context.env,
            signal: session.signal,
            stdout: context.stdout,
            stderr: context.stderr,
            json: model.json,
            copy: model.copy,
            copyUrl: (url) => copyToClipboard(url, context.env, { signal: session.signal }),
          });
          return result.code;
        }
        ready(localUrl);
        if (model.copy) {
          const copied = await copyToClipboard(localUrl, context.env, { signal: session.signal });
          if (!session.signal.aborted)
            context.stderr.write(copied ? "Copied the local URL.\n" : "Could not copy to the clipboard.\n");
        }
        if (!session.signal.aborted)
          await new Promise<void>((done) =>
            session.signal.addEventListener("abort", () => done(), { once: true }),
          );
        return 0;
      } finally {
        abort();
        if (timer) clearTimeout(timer);
        context.signal.removeEventListener("abort", abort);
        await server?.stop(true);
      }
    },
  },
);
