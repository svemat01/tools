import { description, name, route } from "@bomb.sh/router";

import { compare } from "./compare.ts";
import { info } from "./info.ts";
import { og } from "./og.ts";
import { resize } from "./resize.ts";
import { web } from "./web.ts";

/** Image utilities: one shared Sharp implementation behind each command. */
export const img = route(
  name("img"),
  description("Image conversion, resizing, comparison and inspection"),
  web,
  og,
  resize,
  compare,
  info,
);
