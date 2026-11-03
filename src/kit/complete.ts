/**
 * Completion metadata attached directly to Router parameters.
 *
 * `complete()` is an ordinary Router parameter element, used exactly like
 * `schema()` or `cli()`:
 *
 *   option(name("format"), schema(z.enum(["webp", "avif"])), complete(["webp", "avif"]))
 *
 * Because the completion lives on the parameter itself, there is no second
 * registry keyed by names: renaming a flag with `cli()`, reshaping the model
 * with `transform()`, or moving the command elsewhere cannot break the link.
 */

import { mark, type Param, type Transform } from "@bomb.sh/router";
import type { Argument, Completion, Option as TabOption, OptionsMap } from "@bomb.sh/tab";

/** Tab's native handler signature (shared by option and argument handlers). */
export type TabHandler = (
  this: TabOption | Argument,
  complete: (value: string, description: string) => void,
  options: OptionsMap,
) => void;

/** Ask the shell to complete file system paths natively. */
export interface PathCompletion {
  readonly kind: "files" | "directories";
  /** Only offer files with these extensions (directories stay traversable). */
  readonly extensions?: readonly string[];
}

export type CompletionSource =
  /** Static candidates. */
  | readonly (string | Completion)[]
  /** A native Tab handler, called with Tab's `this`, `complete` and options map. */
  | TabHandler
  /** Native shell path completion (see `files()` / `directories()`). */
  | PathCompletion;

const completionKey: unique symbol = Symbol("sv.completion");

type AnyParam = Param<string, unknown, "one"> | Param<string, unknown, "many">;

/** A Router transform that leaves the parameter's type untouched. */
interface Unchanged extends Transform {
  readonly input: AnyParam;
  readonly output: this["input"];
}

/**
 * Attach completion candidates to a Router `option()`, `toggle()` or
 * `argument()`. Never inferred from the schema: validation and discovery are
 * different concerns.
 */
export function complete(source: CompletionSource) {
  return mark<Unchanged>((param: object) => ({ ...param, [completionKey]: source }));
}

/** Native shell file completion, optionally filtered by extension. */
export function files(options: { readonly extensions?: readonly string[] } = {}): PathCompletion {
  const extensions = options.extensions?.map((extension) => extension.replace(/^\*?\./, ""));
  return extensions ? { kind: "files", extensions } : { kind: "files" };
}

/** Native shell directory completion. */
export function directories(): PathCompletion {
  return { kind: "directories" };
}

/** Read the completion source attached by `complete()`, if any. */
export function completionOf(param: object): CompletionSource | undefined {
  const source: unknown = completionKey in param ? param[completionKey] : undefined;
  return isCompletionSource(source) ? source : undefined;
}

function isCompletionSource(value: unknown): value is CompletionSource {
  return (
    typeof value === "function" ||
    Array.isArray(value) ||
    (typeof value === "object" && value !== null && "kind" in value)
  );
}

export function isPathCompletion(source: CompletionSource): source is PathCompletion {
  return typeof source === "object" && "kind" in source;
}
