/**
 * Compile-time verification of a composed command tree.
 *
 * `createApp(root)` intersects its parameter with `Verify<typeof root, C>`. When
 * the tree is sound this is `unknown` (a no-op); otherwise it demands a
 * `"~sv problems"` property whose type lists every problem, so the compiler
 * error names the offending route paths.
 *
 * The central check is assignability: for every executable route, Router's
 * real execute intent at that path (`IntentsOf<Root>`) must be assignable to
 * the intent type the handler was written against. That is exactly the
 * condition under which `createApp` may pass Router's intent to the handler.
 */
import type { AnyRoute, IntentsOf, MethodsOf, RoutePath } from "@bomb.sh/router";

import type { commandKey, CommandSpec, ModelOfElement } from "./command.ts";
import type { BaseContext } from "./context.ts";

/** Names reserved at the root (the Tab completion protocol uses `complete`). */
export type ReservedRootName = "complete";

type Join<P extends RoutePath, N extends string> = P extends "/" ? `/${N}` : `${P}/${N}`;

/** Children in declaration order, across all phases. */
export type ChildrenOf<R extends AnyRoute> = RoutesOf<R["phases"]>;

type RoutesOf<P> = P extends readonly [infer Head, ...infer Tail]
  ? Head extends { readonly routes: infer Routes extends readonly AnyRoute[] }
    ? readonly [...Routes, ...RoutesOf<Tail>]
    : RoutesOf<Tail>
  : readonly [];

export interface Entry<P extends RoutePath = RoutePath, R extends AnyRoute = AnyRoute> {
  readonly path: P;
  readonly route: R;
}

/** Every route in the tree, paired with its absolute path. */
export type Entries<R extends AnyRoute, P extends RoutePath = "/"> =
  Entry<P, R> | (AnyRoute extends R ? never : ChildEntries<ChildrenOf<R>[number], P>);

type ChildEntries<C, P extends RoutePath> = C extends AnyRoute ? Entries<C, Join<P, C["name"]>> : never;

/** Union of every route path in the tree (`"/" | "/media" | "/media/web"`). */
export type RoutePaths<R extends AnyRoute> = Entries<R>["path"];

/** Router's execute intent for a path. */
export type ExecuteAt<Root extends AnyRoute, P extends RoutePath> = Extract<
  IntentsOf<Root>,
  { readonly method: "execute"; readonly route: P }
>;

export type Problems<Root extends AnyRoute, Context> =
  Entries<Root> extends infer E
    ? E extends Entry<infer P, infer R>
      ? RouteProblems<Root, P, R, Context>
      : never
    : never;

type RouteProblems<
  Root extends AnyRoute,
  P extends RoutePath,
  R extends AnyRoute,
  Context,
> = AnyRoute extends R
  ? `${P}: the route type was widened to AnyRoute, so it cannot be verified (keep child routes in tuples, e.g. \`as const\`, not AnyRoute[])`
  : | DuplicateNames<P, ChildrenOf<R>>
    | ReservedNames<P, ChildrenOf<R>[number]["name"]>
    | HandlerProblems<Root, P, R, Context>;

type DuplicateNames<P extends RoutePath, C, Seen extends string = never> = C extends readonly [
  infer Head extends AnyRoute,
  ...infer Tail,
]
  ? | (string extends Head["name"]
        ? `${P}: a child route name was widened to string`
        : Head["name"] extends Seen
          ? `${Join<P, Head["name"]>}: duplicate route name`
          : never)
    | DuplicateNames<P, Tail, Seen | Head["name"]>
  : never;

type ReservedNames<P extends RoutePath, Names> = P extends "/"
  ? Names extends ReservedRootName
    ? `/${Names}: "${Names}" is reserved at the root for shell completion requests`
    : never
  : never;

type HandlerProblems<Root extends AnyRoute, P extends RoutePath, R extends AnyRoute, Context> =
  "execute" extends MethodsOf<R>
    ? R extends { readonly [commandKey]: CommandSpec<infer Intent, infer Needs, infer Inherit> }
      ? | IntentProblems<P, ExecuteAt<Root, P>, Intent>
        | ContextProblems<P, Context, Needs>
        | InheritProblems<P, ExecuteAt<Root, P>, Inherit>
      : `${P}: executable command has no handler (wrap it with defineCommand())`
    : never;

type IntentProblems<P extends RoutePath, Actual, Expected> = [Actual] extends [never]
  ? `${P}: Router has no execute intent for this route`
  : [Actual] extends [Expected]
    ? never
    : `${P}: the handler does not accept Router's execute intent`;

/** The models of every route on the path of an execute intent (self included). */
type ModelsOnPath<Actual> = Actual extends { readonly models: infer Models } ? Models[keyof Models] : never;

/**
 * Each inherited bundle must be satisfiable by some route on the path. (At
 * runtime the kit finds the exact route that applied the bundle; see app.ts.)
 */
type InheritProblems<P extends RoutePath, Actual, Inherit> = {
  [K in keyof Inherit]: [Extract<ModelsOnPath<Actual>, ModelOfElement<Inherit[K]>>] extends [never]
    ? `${P}: inherits "${K & string}", but no route on this path provides that bundle's options`
    : never;
}[keyof Inherit];

type ContextProblems<P extends RoutePath, Context, Needs> = [Context] extends [Needs]
  ? never
  : `${P}: the handler needs application context that createApp() does not provide`;

/** Context types declared by handlers in the tree (one per handler). */
type HandlerContexts<Root extends AnyRoute> =
  Entries<Root> extends infer E
    ? E extends Entry<RoutePath, infer R>
      ? R extends { readonly [commandKey]: CommandSpec<infer _Intent, infer Needs> }
        ? Needs
        : never
      : never
    : never;

type Intersect<U> = (U extends unknown ? (value: U) => void : never) extends (value: infer I) => void
  ? I
  : never;

/**
 * Everything the tree's handlers need from the application context: the
 * intersection of their declared context types. A `context` factory must
 * return this.
 */
export type ContextOf<Root extends AnyRoute> = [HandlerContexts<Root>] extends [never]
  ? BaseContext
  : Intersect<HandlerContexts<Root>>;

export type Verify<Root extends AnyRoute, Context> = [Problems<Root, Context>] extends [never]
  ? unknown
  : { readonly "~sv problems": Problems<Root, Context> };
