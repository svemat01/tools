/**
 * Compile-time tests: handler input inference. Checked by `bun check`; never
 * executed. Each `@ts-expect-error` is a negative test — if the error goes
 * away, the check fails as an unused directive.
 */
import { expectTypeOf } from "bun:test";

import {
  argument,
  cli,
  command,
  extend,
  multiple,
  name,
  option,
  route,
  schema,
  toggle,
  transform,
} from "@bomb.sh/router";
import { z } from "zod";

import { type BaseContext, defineCommand, type ModelOfElement } from "../../src/kit/index.ts";

// --- Own model: every parameter kind --------------------------------------

defineCommand(
  command(
    name("all"),
    option(name("plain")),
    option(name("text"), schema(z.string())),
    option(name("maybe"), schema(z.string().optional())),
    option(name("count"), schema(z.number().default(3))),
    option(name("format"), schema(z.enum(["webp", "avif"]).default("webp"))),
    option(name("size"), schema(z.string().transform((value) => value.length))),
    option(name("repository"), cli(["--repo", "-R"]), schema(z.string())),
    option(name("label"), multiple(), schema(z.array(z.string()).default([]))),
    toggle(name("dryRun")),
    argument(name("input"), schema(z.string())),
    argument(name("rest"), multiple(), schema(z.array(z.string()))),
  ),
  {
    run({ model, models }, context) {
      expectTypeOf(model).toEqualTypeOf<{
        plain: unknown;
        text: string;
        maybe: string | undefined;
        count: number;
        format: "webp" | "avif";
        size: number;
        // `cli()` renames the flag, not the model field.
        repository: string;
        label: string[];
        dryRun: boolean;
        input: string;
        rest: string[];
      }>();
      expectTypeOf(context).toEqualTypeOf<BaseContext>();
      // Nothing declared, nothing readable.
      // @ts-expect-error no ancestors were declared
      void models["/"];
      // @ts-expect-error not a field of the model
      void model.missing;
    },
  },
);

// --- transform() changes model fields ----------------------------------------

defineCommand(
  command(
    name("shaped"),
    option(name("first"), schema(z.string())),
    option(name("last"), schema(z.string())),
    transform(
      z.object({ first: z.string(), last: z.string() }).transform((v) => ({ full: `${v.first} ${v.last}` })),
    ),
  ),
  {
    run({ model }) {
      expectTypeOf(model).toEqualTypeOf<{ full: string }>();
    },
  },
);

// --- Ancestor models: declared by referencing the ancestors' elements ------

const rootOptions = extend(toggle(name("verbose")), option(name("name"), schema(z.string().optional())));
const groupOptions = extend(option(name("name"), schema(z.number().default(1))));

expectTypeOf<ModelOfElement<typeof rootOptions>>().toEqualTypeOf<{
  verbose: boolean;
  name: string | undefined;
}>();
expectTypeOf<ModelOfElement<typeof groupOptions>>().toEqualTypeOf<{ name: number }>();
// A single element works too.
expectTypeOf<ModelOfElement<ReturnType<typeof toggle<"x", []>>>>().toEqualTypeOf<{ x: boolean }>();

defineCommand(command(name("leaf"), option(name("name"), schema(z.boolean().default(false)))), {
  ancestors: { "/": rootOptions, "/group": groupOptions },
  run({ model, models }) {
    // Same parameter name at three levels: three namespaces, three types.
    expectTypeOf(model.name).toEqualTypeOf<boolean>();
    expectTypeOf(models["/"].name).toEqualTypeOf<string | undefined>();
    expectTypeOf(models["/group"].name).toEqualTypeOf<number>();
    // @ts-expect-error "/other" was not declared
    void models["/other"];
  },
});

// --- Application context: declared by annotating the second parameter ------

interface Database {
  query(sql: string): string[];
}
type WithDatabase = BaseContext & { readonly db: Database };

defineCommand(command(name("db")), {
  run(_intent, context: WithDatabase) {
    expectTypeOf(context.db.query("")).toEqualTypeOf<string[]>();
  },
});

// --- Invalid definitions and handlers ----------------------------------------

// @ts-expect-error route() groups cannot execute, so they take no handler
defineCommand(route(name("group")), { run() {} });

// @ts-expect-error ancestor keys are absolute route paths
defineCommand(command(name("x")), { ancestors: { group: groupOptions }, run() {} });

defineCommand(command(name("x")), {
  // @ts-expect-error handlers return nothing or an exit code
  run: () => "done",
});

defineCommand(command(name("x"), option(name("n"), schema(z.number()))), {
  run({ model }) {
    // @ts-expect-error validated model types are precise
    const text: string = model.n;
    void text;
  },
});
