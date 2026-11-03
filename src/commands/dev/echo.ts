import { argument, command, description, multiple, name, option, schema, toggle } from "@bomb.sh/router";
import { z } from "zod";

import { defineCommand } from "../../kit/index.ts";

export const echo = defineCommand(
  command(
    name("echo"),
    description("Print the given words"),
    argument(name("words"), multiple(), schema(z.array(z.string()).default([]))),
    toggle(name("upper"), description("Upper-case the output")),
    option(name("repeat"), description("Print this many times"), schema(z.number().int().min(1).default(1))),
  ),
  {
    run({ model }, context) {
      const line = model.words.join(" ");
      const text = model.upper ? line.toUpperCase() : line;
      for (let i = 0; i < model.repeat; i++) context.stdout.write(`${text}\n`);
    },
  },
);
