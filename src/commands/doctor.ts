import { command, description, name, toggle } from "@bomb.sh/router";

import { defineCommand } from "../kit/index.ts";
import { doctor as checkDoctor } from "../lib/doctor.ts";
import { json } from "../lib/output.ts";

export const doctor = defineCommand(
  command(
    name("doctor"),
    description("Check runtime, optional tools and project configuration"),
    toggle(name("json"), description("Print machine-readable JSON")),
  ),
  {
    async run({ model }, context) {
      context.signal.throwIfAborted();
      const result = await checkDoctor(context.cwd, context.env);
      if (model.json) context.stdout.write(json(result));
      else
        for (const check of result.checks)
          context.stdout.write(`${check.status}: ${check.name}: ${check.message}\n`);
      return result.ok ? 0 : 1;
    },
  },
);
