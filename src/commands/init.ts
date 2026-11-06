import { join } from "node:path";

import { command, description, name, toggle } from "@bomb.sh/router";

import type { AppContext } from "../context.ts";
import { defineCommand } from "../kit/index.ts";
import { writeFileAtomic } from "../lib/fs.ts";
import { json } from "../lib/output.ts";
import { discoverProject, loadProjectConfig, ProjectConfigSchema } from "../lib/project.ts";

export const init = defineCommand(
  command(
    name("init"),
    description("Preview and create a minimal sv.config.json without overwriting"),
    toggle(name("dryRun"), description("Preview without writing")),
    toggle(name("yes"), description("Create without an interactive confirmation")),
    toggle(name("json"), description("Print machine-readable JSON; requires --yes to create")),
  ),
  {
    async run({ model }, context: AppContext) {
      context.signal.throwIfAborted();
      const discovered = await discoverProject(context.cwd);
      const root = discovered?.root ?? context.cwd;
      const loaded = await loadProjectConfig(root);
      const config = ProjectConfigSchema.parse({ schemaVersion: 1 });
      const path = join(root, "sv.config.json");
      if (loaded.source || loaded.blog) {
        const result = {
          command: "init",
          schemaVersion: 1,
          status: "existing",
          path: loaded.source ?? loaded.blog?.source,
          root,
        };
        context.stdout.write(
          model.json ? json(result) : `Existing configuration: ${result.path}; no changes.\n`,
        );
        return 0;
      }
      const content = `${JSON.stringify(config, null, 2)}\n`;
      context.stderr.write(`Create ${path}:\n${content}`);
      const approved =
        !model.dryRun &&
        (model.yes || (!model.json && (await context.confirm("Create this configuration?"))));
      let status: "planned" | "created" | "declined" = model.dryRun ? "planned" : "declined";
      if (approved) {
        context.signal.throwIfAborted();
        // Atomic no-clobber publication also protects against a config created after preview.
        await writeFileAtomic(path, Buffer.from(content));
        status = "created";
      }
      context.stdout.write(
        model.json
          ? json({ command: "init", schemaVersion: 1, status, path, root, config })
          : `${status}: ${path}${status === "declined" ? "; use --yes to create non-interactively" : ""}\n`,
      );
      return status === "declined" ? 1 : 0;
    },
  },
);
