import { description, name, route } from "@bomb.sh/router";

import { inspect } from "./inspect.ts";
import { mediaOptions } from "./options.ts";
import { web } from "./web.ts";

/** A non-executable group: `sv media` alone prints its help. */
export const media = route(
  name("media"),
  description("Image and video utilities"),
  mediaOptions,
  web,
  inspect,
);
