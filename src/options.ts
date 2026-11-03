/**
 * Options of the root `sv` route.
 *
 * Kept in their own module so commands can declare them as an ancestor
 * (`ancestors: { "/": globalOptions }`) without importing the root, which
 * imports them.
 */
import { description, extend, name, option, schema, toggle } from "@bomb.sh/router";
import { z } from "zod";

import { complete, directories } from "./kit/index.ts";

export const globalOptions = extend(
  toggle(name("verbose"), description("Print debug output to stderr")),
  option(
    name("cwd"),
    description("Run as if started in this directory"),
    schema(z.string().optional()),
    complete(directories()),
  ),
);
