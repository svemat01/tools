import { description, extend, name, option, schema } from "@bomb.sh/router";
import { z } from "zod";

/** Options of the `sv media` group, shared with its commands as an ancestor model. */
export const mediaOptions = extend(
  option(
    name("quality"),
    description("Default output quality for media commands (1-100)"),
    schema(z.number().int().min(1).max(100).default(80)),
  ),
);
