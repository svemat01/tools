/**
 * `defineCommand()`: attach a handler to a native Router `command()`.
 *
 * The result is still a Router route (same runtime shape, same type plus one
 * symbol-keyed property), so it composes with `route()`, `command()` and
 * `extend()` exactly like any other route.
 *
 * Handlers receive Router's own execute intent, not a re-shaped copy. Its type
 * is narrowed to what the handler can know at definition time:
 *
 * - `intent.model` — this command's model, inferred from the definition.
 * - `intent.models[path]` — ancestor models the command *declares* through
 *   `ancestors`. A command cannot know where it will be mounted, so it states
 *   what it expects and `createApp()` proves, at compile time, that Router's
 *   real intent at the mount point satisfies it.
 */

import type { AnyRoute, Issue, Literal, MethodsOf, ModelOf, Path, route, RoutePath } from "@bomb.sh/router";
import type { Command as TabCommand, RootCommand } from "@bomb.sh/tab";

import type { BaseContext } from "./context.ts";

/** No declared ancestor models: `intent.models` has no readable keys. */
export type NoModels = Record<never, never>;

/** What a handler sees: Router's execute intent with the models it declared. */
export interface CommandIntent<Model, Models = NoModels> {
  readonly ok: true;
  readonly method: "execute";
  readonly route: RoutePath;
  readonly path: Path;
  readonly definition: AnyRoute;
  readonly literals: Iterable<Literal>;
  readonly issues: readonly Issue[];
  readonly model: Model;
  readonly models: Models;
}

export type ExitCode = number;
export type HandlerResult = void | ExitCode | Promise<void | ExitCode>;

/** Anything Router accepts as a pipeline element or child route. */
export type RouterInput = ((value: never) => unknown) | AnyRoute;

/**
 * The model contributed by a Router element (`option()`, `toggle()`,
 * `extend(...)`, ...) or the model of a route.
 */
export type ModelOfElement<E> = E extends AnyRoute
  ? ModelOf<E>
  : E extends RouterInput
    ? ReturnType<typeof route<"", readonly [E]>> extends infer R extends AnyRoute
      ? ModelOf<R>
      : never
    : never;

/** Ancestor route path → the Router element(s) that define its model. */
export type AncestorSources = { readonly [path: RoutePath]: RouterInput };

/** Rejects keys that are not absolute route paths (`media` instead of `/media`). */
type OnlyRoutePaths<A> = { readonly [K in keyof A as K extends RoutePath ? never : K]: never };

export type AncestorModels<A> = { readonly [K in keyof A]: ModelOfElement<A[K]> };

export interface TabHookInfo {
  readonly root: RootCommand;
  readonly path: RoutePath;
}

export interface CommandSpec<Intent, Context> {
  readonly ancestors?: AncestorSources;
  readonly run: (intent: Intent, context: Context) => HandlerResult;
  /** Customize the generated native Tab command for this route. */
  readonly tab?: (command: TabCommand, info: TabHookInfo) => void;
}

export const commandKey: unique symbol = Symbol("sv.command");

/** The type-level and runtime marker `defineCommand()` adds to a route. */
export interface Handled<Intent = never, Context = never> {
  readonly [commandKey]: CommandSpec<Intent, Context>;
}

type Precise<D extends AnyRoute> = AnyRoute extends D
  ? {
      readonly "~sv": "defineCommand(): the definition was widened to AnyRoute; pass the command() expression directly";
    }
  : "execute" extends MethodsOf<D>
    ? unknown
    : {
        readonly "~sv": "defineCommand(): only executable Router command() definitions take a handler; route() groups cannot execute";
      };

export function defineCommand<
  const D extends AnyRoute,
  const A extends AncestorSources = NoModels,
  C = BaseContext,
>(
  definition: D & Precise<D>,
  spec: {
    /** Ancestor models this handler reads, keyed by absolute route path. */
    readonly ancestors?: A & OnlyRoutePaths<A>;
    readonly run: (intent: CommandIntent<ModelOf<D>, AncestorModels<A>>, context: C) => HandlerResult;
    readonly tab?: (command: TabCommand, info: TabHookInfo) => void;
  },
): D & Handled<CommandIntent<ModelOf<D>, AncestorModels<A>>, C> {
  return { ...definition, [commandKey]: spec };
}

/** The handler attached to a route by `defineCommand()`, if any. */
export function handlerOf(route: AnyRoute): CommandSpec<never, never> | undefined {
  const spec: unknown = commandKey in route ? route[commandKey] : undefined;
  return isSpec(spec) ? spec : undefined;
}

function isSpec(value: unknown): value is CommandSpec<never, never> {
  return typeof value === "object" && value !== null && "run" in value && typeof value.run === "function";
}
