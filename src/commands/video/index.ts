import { description, name, route } from "@bomb.sh/router";

import { webm } from "./webm.ts";

/** Video utilities. A single, predictable conversion pipeline. */
export const video = route(
  name("video"),
  description("Video conversion utilities"),
  webm,
);
