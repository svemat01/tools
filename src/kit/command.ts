/**
 * `defineCommand()`: attach a handler to a native Router `command()`.
 *
 * The result is still a Router route (same runtime shape, same type plus one
 * symbol-keyed property), so it composes with `route()`, `command()` and
 * `extend()` exactly like any other route.
 *
 * A handler receives three things:
 *
 * - `intent`: Router's own execute intent (not a copy), with `intent.model`
 *   inferred from the definition.
 * - `context`: the application context (`BaseContext` unless annotated).
 * - `inherited`: models of option bundles applied by routes above it, under
 *   local names the command picks (`inherit: { media: mediaOptions }`).
 *
 * A command cannot know where it will be mounted, so it names the *bundles* it
 * reads rather than paths. At runtime each bundle is found on the nearest
 * route of the invoked path that applied it (by parameter identity). At
 * compile time `createApp()` proves that some route on the mount path
 * provides a compatible model.
 */

import type { AnyRoute, Issue, Literal, MethodsOf, ModelOf, Path, route, RoutePath } from "@bomb.sh/router";
import type { Command as TabCommand, RootCommand } from "@bomb.sh/tab";

import type { BaseContext } from "./context.ts";

/**
 * What a handler sees: Router's execute intent. `models` is Router's object
 * too, but its entries are untyped here; read parent options with `inherit`.
 */
export interface CommandIntent<Model> {
  readonly ok: true;
  readonly method: "execute";
  readonly route: RoutePath;
  readonly path: Path;
  readonly definition: AnyRoute;
  readonly literals: Iterable<Literal>;
  readonly issues: readonly Issue[];
  readonly model: Model;
  readonly models: { readonly [path: RoutePath]: unknown };
}

export type ExitCode = number;
export type HandlerResult = void | ExitCode | Promise<void | ExitCode>;

/** Anything Router accepts as a pipeline element or child route. */
export type RouterInput = ((value: never) => unknown) | AnyRoute;

/** A Router element that adds parameters: `option()`, `toggle()`, `argument()`, `extend(...)`. */
export type Bundle = (value: never) => unknown;

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

/** Local name → option bundle applied by a route above (or at) the command. */
export type InheritSources = { readonly [name: string]: Bundle };

/** The models a handler receives for its `inherit` declaration. */
export type Inherited<I> = { readonly [K in keyof I]: ModelOfElement<I[K]> };

export type NoInherit = Record<never, never>;

export interface TabHookInfo {
  readonly root: RootCommand;
  readonly path: RoutePath;
}

export interface CommandSpec<Intent, Context, Inherit = InheritSources> {
  readonly inherit?: Inherit;
  readonly run: (intent: Intent, context: Context, inherited: Inherited<Inherit>) => HandlerResult;
  /** Customize the generated native Tab command for this route. */
  readonly tab?: (command: TabCommand, info: TabHookInfo) => void;
}

export const commandKey: unique symbol = Symbol("sv.command");

/** The type-level and runtime marker `defineCommand()` adds to a route. */
export interface Handled<Intent = never, Context = never, Inherit = InheritSources> {
  readonly [commandKey]: CommandSpec<Intent, Context, Inherit>;
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
  const I extends InheritSources = NoInherit,
  C = BaseContext,
>(
  definition: D & Precise<D>,
  spec: {
    /** Option bundles of routes above this command, under local names. */
    readonly inherit?: I;
    readonly run: (intent: CommandIntent<ModelOf<D>>, context: C, inherited: Inherited<I>) => HandlerResult;
    readonly tab?: (command: TabCommand, info: TabHookInfo) => void;
  },
): D & Handled<CommandIntent<ModelOf<D>>, C, I> {
  return { ...definition, [commandKey]: spec };
}

/** The handler attached to a route by `defineCommand()`, if any. */
export function handlerOf(route: AnyRoute): CommandSpec<never, never, InheritSources> | undefined {
  const spec: unknown = commandKey in route ? route[commandKey] : undefined;
  return isSpec(spec) ? spec : undefined;
}

function isSpec(value: unknown): value is CommandSpec<never, never, InheritSources> {
  return typeof value === "object" && value !== null && "run" in value && typeof value.run === "function";
}
