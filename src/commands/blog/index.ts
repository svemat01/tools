import { description, name, route } from "@bomb.sh/router";

import { check } from "./check.ts";
import { prepare } from "./prepare.ts";

/** Configurable blog validation and preparation. No project layout is built in. */
export const blog = route(
  name("blog"),
  description("Check and prepare Markdown/MDX blog posts using a configurable layout"),
  check,
  prepare,
);
