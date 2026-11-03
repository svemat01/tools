/**
 * `createApp()`: turn a composed Router tree into a runnable CLI.
 *
 * Responsibilities, in order of a `run()`:
 *
 * 1. `complete …` requests (the Tab protocol) are answered from static route
 *    metadata. They never parse with Router, never build the application
 *    context and never call handlers.
 * 2. Everything else is parsed by Router. Checkpoints/dynamic phases are
 *    driven by the app's `checkpoint` driver until Router settles an intent.
 * 3. Help and version are printed with Router's printers; failures with
 *    Router's `printErrors()` plus a hint for misplaced ancestor options.
 * 4. Execute intents are dispatched to the handler stored on
 *    `intent.definition` by `defineCommand()`.
 */
import {
  type AnyIntent,
  type AnyRoute,
  type EnvSource,
  type IntentsOf,
  type MethodNotAllowed,
  parse,
  printErrors,
  printHelp,
  printVersion,
  type RoutePath,
  type UnprocessableContent,
  type ValueSource,
} from "@bomb.sh/router";

import { type ExitCode, handlerOf, type HandlerResult, type InheritSources } from "./command.ts";
import { type BaseContext, baseContext, type RunOptions } from "./context.ts";
import {
  describeRoute,
  findApplier,
  flattenRoutes,
  paramsOf,
  type RouteMeta,
  toPath,
} from "./router-meta.ts";
import {
  buildTab,
  completeWords,
  type CompletionResult,
  completionScript,
  isShell,
  type Shell,
  shells,
  type TabHooks,
  type TabTree,
} from "./tab.ts";
import type { ContextOf, ExecuteAt, RoutePaths, Verify } from "./verify.ts";

/** Router's settled outcomes for a tree: every reachable intent, or a failure. */
export type Settled<R extends AnyRoute> = IntentsOf<R> | MethodNotAllowed | UnprocessableContent;

type Parsed<R extends AnyRoute> = ReturnType<typeof parse<R>>;
type Increments<T> = T extends { readonly resume: (value: never) => infer Next }
  ? T | Increments<Next>
  : never;

/** A paused parse (`checkpoint()` / `dynamic()`), as produced by Router for this tree. */
export type Step<R extends AnyRoute> = Increments<Parsed<R>>;

type Resumed<S> = S extends { readonly resume: (value: never) => infer Next } ? Next : never;

export interface Sources {
  readonly values?: readonly ValueSource[];
  readonly envs?: readonly EnvSource[];
}

interface CommonOptions<R extends AnyRoute> {
  /**
   * Router value/environment sources for each parse. Not bound by default:
   * Router derives env keys from route path + name (a root `path` option reads
   * `$PATH`), so opting in should be a deliberate choice.
   */
  readonly sources?: (base: BaseContext) => Sources;
  /** Customize the generated native Tab tree (runs for every completion request). */
  readonly tab?: (tree: TabTree<RoutePaths<R>>) => void;
}

/**
 * Drives paused parses. Narrow `step.route`, do the I/O, and return
 * `step.resume(value)`. Runs for help/version/completion-free parses too
 * (Router needs the full route graph to know what help targets), so it must
 * not have command side effects.
 */
type CheckpointOption<R extends AnyRoute> = [Step<R>] extends [never]
  ? { readonly checkpoint?: never }
  : {
      readonly checkpoint: (step: Step<R>, base: BaseContext) => Resumed<Step<R>> | Promise<Resumed<Step<R>>>;
    };

export type AppOptions<R extends AnyRoute> = CommonOptions<R> & CheckpointOption<R>;

export type AppOptionsWithContext<R extends AnyRoute, C> = AppOptions<R> & {
  /**
   * Build the application context once per executed command (never for help,
   * version, errors or completion). Receives the execute intent so validated
   * configuration such as a root `--verbose` can configure services.
   */
  readonly context: (base: BaseContext, intent: ExecuteIntent<R>) => C | Promise<C>;
};

export interface App<R extends AnyRoute, C> {
  /** The composed Router definition. */
  readonly definition: R;
  /** Static route metadata used for completion and validation. */
  readonly meta: RouteMeta;
  /** Parse with Router and drive checkpoints, without printing or executing. */
  parse(argv: readonly string[], options?: RunOptions): Promise<Settled<R>>;
  /** Execute a Router execute intent with its handler. */
  execute(intent: ExecuteIntent<R>, options?: RunOptions): Promise<ExitCode>;
  /** The full CLI: completion, help, version, errors and execution. Returns the exit code. */
  run(argv: readonly string[], options?: RunOptions): Promise<ExitCode>;
  /** Answer a completion request (the words after `complete --`). */
  complete(words: readonly string[]): CompletionResult;
  /** The shell script that wires completion to `<program> complete`. */
  script(shell: Shell): string;
  /** A fresh native Tab tree for this app (with all hooks applied). */
  tab(): TabTree<RoutePaths<R>>;
  /** Phantom: the application context type handlers receive. */
  readonly "~context"?: C;
}

export type ExecuteIntent<R extends AnyRoute> = ExecuteAt<R, RoutePaths<R>>;

export class AppDefinitionError extends Error {
  readonly problems: readonly string[];
  constructor(problems: readonly string[]) {
    super(`Invalid command tree:\n${problems.map((problem) => `  - ${problem}`).join("\n")}`);
    this.name = "AppDefinitionError";
    this.problems = problems;
  }
}

export function createApp<const R extends AnyRoute>(
  root: R & Verify<R, ContextOf<R>>,
  options: AppOptionsWithContext<R, ContextOf<R>>,
): App<R, ContextOf<R>>;
export function createApp<const R extends AnyRoute>(
  root: R & Verify<R, BaseContext>,
  ...options: [Step<R>] extends [never] ? [options?: AppOptions<R>] : [options: AppOptions<R>]
): App<R, BaseContext>;
export function createApp(root: AnyRoute, options: InternalOptions = {}): Runtime {
  return createRuntime(root, options);
}

/** The untyped runtime behind the typed `createApp()` overloads. */
interface InternalOptions {
  readonly sources?: (base: BaseContext) => Sources;
  readonly tab?: (tree: TabTree) => void;
  readonly checkpoint?: (step: never, base: BaseContext) => unknown;
  readonly context?: (base: BaseContext, intent: never) => unknown;
}

type Outcome = AnyIntent | MethodNotAllowed | UnprocessableContent;

/**
 * The runtime is written against Router's untyped shapes (`AnyRoute`,
 * `AnyIntent`). The overloads above re-attach the precise types: `parse()`
 * returns what Router's `parse(root)` returns for that exact `root`, and
 * `execute()` accepts only that tree's execute intents.
 */
interface Runtime extends Omit<App<AnyRoute, unknown>, "parse" | "execute" | "tab"> {
  parse(argv: readonly string[], options?: RunOptions): Promise<Outcome>;
  execute(intent: AnyIntent, options?: RunOptions): Promise<ExitCode>;
  tab(): TabTree;
}
interface Paused {
  readonly ok: true;
  readonly route: string;
  resume(value: never): unknown;
}

function createRuntime(root: AnyRoute, options: InternalOptions): Runtime {
  const meta = describeRoute(root);
  const problems = validate(meta);
  if (problems.length > 0) throw new AppDefinitionError(problems);
  const program = meta.name;
  const routes = new Map(flattenRoutes(meta).map((route) => [route.path, route]));

  const tabHooks: TabHooks = {
    route: (route, command, tabRoot) =>
      handlerOf(route.route)?.tab?.(command, { root: tabRoot, path: route.path }),
    ...(options.tab ? { tree: options.tab } : {}),
  };

  async function parseArgv(argv: readonly string[], base: BaseContext): Promise<Outcome> {
    const sources = options.sources?.(base) ?? {};
    let result: Outcome | Paused = parse(root, { argv: [...argv], ...sources });
    while (isPaused(result)) {
      if (!options.checkpoint) {
        throw new Error(
          `Route ${result.route} pauses at a checkpoint, but createApp() has no checkpoint driver`,
        );
      }
      // `checkpoint` is typed by the createApp() overloads as accepting
      // exactly the steps Router produces for this tree.
      const next: unknown = await options.checkpoint(result as never, base);
      if (!isOutcome(next)) throw new Error("The checkpoint driver must return step.resume(...)");
      result = next;
    }
    return result;
  }

  /** Resolve each inherited bundle to the model of the nearest route on the path that applied it. */
  function inherit(
    sources: InheritSources,
    path: readonly string[],
    models: Readonly<Record<string, unknown>>,
  ): Record<string, unknown> {
    // Root first; routes added by dynamic() have no static metadata and are skipped.
    const candidates = [meta, ...path.map((_, depth) => routes.get(toPath(path.slice(0, depth + 1))))].filter(
      (route): route is RouteMeta => route !== undefined,
    );
    return Object.fromEntries(
      Object.entries(sources).map(([alias, bundle]) => {
        const applier = findApplier(bundle, candidates);
        if (!applier) throw new Error(`${toPath(path)}: inherited "${alias}" is not applied on this path`);
        return [alias, models[applier.path]];
      }),
    );
  }

  async function execute(intent: AnyIntent, base: BaseContext): Promise<ExitCode> {
    if (intent.method !== "execute") throw new Error(`Expected an execute intent, got ${intent.method}`);
    const spec = handlerOf(intent.definition);
    if (!spec) throw new Error(`No handler for ${intent.route}`);
    // The deliberate widening points of the integration. `createApp()` has
    // proven at compile time (Verify) that Router's intent at this route and
    // the app context are assignable to what this handler declared, and the
    // context factory is typed to accept this tree's execute intents.
    const build = options.context as ((base: BaseContext, intent: unknown) => unknown) | undefined;
    const inherited = inherit(spec.inherit ?? {}, intent.path, intent.models);
    const context = build ? await build(base, intent) : base;
    const run = spec.run as (intent: unknown, context: unknown, inherited: unknown) => HandlerResult;
    const code = await run(intent, context, inherited);
    return typeof code === "number" ? code : 0;
  }

  function respond(result: Outcome, base: BaseContext): Promise<ExitCode> | ExitCode {
    if (!result.ok) {
      if (result.code === "method-not-allowed" && result.method === "execute" && isRoutePath(result.route)) {
        // A group without a handler: show what it contains.
        const help = {
          ok: true,
          method: "help",
          route: result.route,
          definition: result.definition,
          path: result.path,
          literals: [],
        } as const;
        base.stderr.write(`${printHelp(help)}\n`);
        return 2;
      }
      base.stderr.write(`${printErrors(result)}\n${hints(result)}`);
      return 2;
    }
    switch (result.method) {
      case "help":
        base.stdout.write(`${printHelp(result)}\n`);
        return 0;
      case "version":
        base.stdout.write(`${printVersion(result)}\n`);
        return 0;
      case "execute":
        return execute(result, base);
    }
  }

  function hints(failure: MethodNotAllowed | UnprocessableContent): string {
    const lines: string[] = [];
    if (failure.code === "unprocessable-content" && isRoutePath(failure.route)) {
      for (const issue of failure.issues) {
        const token = /^unexpected (".*")$/.exec(issue.message)?.[1];
        const text = token ? String(JSON.parse(token)).split("=")[0] : undefined;
        const owner = text ? ancestorDeclaring(failure.route, text) : undefined;
        if (text && owner) {
          const child = failure.path[owner.segments.length];
          lines.push(
            `hint: ${text} is an option of \`${[program, ...owner.segments].join(" ")}\`; put it before \`${child}\``,
          );
        }
      }
    }
    const usage = [program, ...failure.path, "--help"].join(" ");
    lines.push(`Run \`${usage}\` for usage.`);
    return `${lines.join("\n")}\n`;
  }

  function ancestorDeclaring(path: RoutePath, flag: string): RouteMeta | undefined {
    const segments = routes.get(path)?.segments ?? [];
    for (let depth = segments.length - 1; depth >= 0; depth--) {
      const ancestor = routes.get(`/${segments.slice(0, depth).join("/")}`);
      const declares = ancestor?.params.some(
        (param) => param.kind === "option" && param.flags.some((f) => f.text === flag),
      );
      if (declares) return ancestor;
    }
    return undefined;
  }

  function completion(args: readonly string[], base: BaseContext): ExitCode {
    const [first] = args;
    if (first === "--") {
      base.stdout.write(completeWords(meta, args.slice(1), tabHooks).output);
      return 0;
    }
    if (isShell(first) && args.length === 1) {
      base.stdout.write(completionScript(program, first));
      return 0;
    }
    base.stderr.write(
      `Usage: ${program} complete <${shells.join("|")}>\n       ${program} complete -- <words...>\n`,
    );
    return 2;
  }

  return {
    definition: root,
    meta,
    parse: (argv, runOptions) => parseArgv(argv, baseContext(program, runOptions)),
    execute: (intent, runOptions) => execute(intent, baseContext(program, runOptions)),
    async run(argv, runOptions) {
      const base = baseContext(program, runOptions);
      try {
        if (argv[0] === "complete") return completion(argv.slice(1), base);
        return await respond(await parseArgv(argv, base), base);
      } catch (error) {
        base.stderr.write(`${program}: ${error instanceof Error ? error.message : String(error)}\n`);
        return 1;
      }
    },
    complete: (words) => completeWords(meta, words, tabHooks),
    script: (shell) => completionScript(program, shell),
    tab: () => buildTab(meta, tabHooks),
  };
}

function isPaused(result: Outcome | Paused): result is Paused {
  return result.ok && "resume" in result;
}

function isOutcome(value: unknown): value is Outcome | Paused {
  return typeof value === "object" && value !== null && "ok" in value;
}

function isRoutePath(path: string): path is RoutePath {
  return path.startsWith("/");
}

const RESERVED_FLAGS = new Set(["-h", "--help", "-v", "--version"]);

/** Runtime checks for problems the type system cannot see (or that were bypassed). */
export function validate(meta: RouteMeta): string[] {
  const problems: string[] = [];
  if (!/^[A-Za-z0-9][\w.-]*$/.test(meta.name)) {
    problems.push(
      `/: program name ${JSON.stringify(meta.name)} must be a plain word (it names shell functions)`,
    );
  }
  for (const route of flattenRoutes(meta)) {
    const spec = handlerOf(route.route);
    const executable = route.methods.includes("execute");
    if (executable && !spec)
      problems.push(`${route.path}: executable command has no handler (wrap it with defineCommand())`);
    if (!executable && spec) problems.push(`${route.path}: has a handler but is not executable`);
    const onPath = flattenRoutes(meta).filter(
      (candidate) =>
        candidate.path === "/" ||
        candidate.path === route.path ||
        route.path.startsWith(`${candidate.path}/`),
    );
    for (const [alias, bundle] of Object.entries(spec?.inherit ?? {})) {
      if (paramsOf(bundle).length === 0) {
        problems.push(`${route.path}: inherits "${alias}", which declares no parameters`);
      } else if (!findApplier(bundle, onPath)) {
        problems.push(`${route.path}: inherits "${alias}", but no route on this path applies that bundle`);
      }
    }

    const names = new Set<string>();
    for (const child of route.children) {
      if (!/^[^\s/-][^\s/]*$/.test(child.name)) {
        problems.push(
          `${child.path}: route name ${JSON.stringify(child.name)} must be a single word that does not start with "-"`,
        );
      }
      if (names.has(child.name)) problems.push(`${child.path}: duplicate route name`);
      names.add(child.name);
      if (route.path === "/" && child.name === "complete") {
        problems.push(`/complete: "complete" is reserved at the root for shell completion requests`);
      }
    }

    const flags = new Map<string, string>();
    let variadic: string | undefined;
    for (const param of route.params) {
      if (param.kind === "argument") {
        if (variadic)
          problems.push(
            `${route.path}: argument "${param.name}" follows variadic argument "${variadic}" and can never receive a value`,
          );
        if (param.multiple) variadic = param.name;
      }
      if (param.kind !== "option") continue;
      for (const flag of param.flags) {
        if (RESERVED_FLAGS.has(flag.text)) {
          problems.push(
            `${route.path}: option "${param.name}" uses ${flag.text}, which Router reserves for help/version`,
          );
        }
        const owner = flags.get(flag.text);
        if (owner)
          problems.push(`${route.path}: ${flag.text} is bound by both "${owner}" and "${param.name}"`);
        flags.set(flag.text, param.name);
      }
    }
  }
  return problems;
}
