/**
 * Tab integration: generates a native `@bomb.sh/tab` command tree from Router
 * metadata and answers completion requests with Tab's own parser.
 *
 * What this module adds on top of Tab, and why:
 *
 * 1. A fresh `RootCommand` per request — never Tab's global default export —
 *    so independent apps (and tests) cannot leak completion state.
 * 2. Native path completion. Tab ends every response with the `NoFileComp`
 *    directive (`:4`), which disables the shell's own file completion. A
 *    `files()`/`directories()` completion records its intent during Tab's
 *    parse; we then rewrite the directive line of the documented protocol
 *    output. No Tab internals are patched.
 * 3. Two input normalizations Tab's parser needs (see `normalize()`).
 *
 * Everything else (which command is active, which option expects a value,
 * prefix filtering, `--opt=value` value completion) is Tab's own logic.
 */

import type { RoutePath } from "@bomb.sh/router";
import {
  type Command as TabCommand,
  type Completion,
  Option,
  type OptionHandler,
  RootCommand,
  ShellCompDirective,
} from "@bomb.sh/tab";

import {
  completionOf,
  type CompletionSource,
  isPathCompletion,
  type PathCompletion,
  type TabHandler,
} from "./complete.ts";
import { flattenRoutes, type OptionMeta, type RouteMeta } from "./router-meta.ts";
import { patchScript } from "./scripts.ts";

export const shells = ["zsh", "bash", "fish", "powershell"] as const;
export type Shell = (typeof shells)[number];

export function isShell(value: string | undefined): value is Shell {
  return shells.some((shell) => shell === value);
}

/** Native Tab objects generated for one app. */
export interface TabTree<P extends RoutePath = RoutePath> {
  readonly root: RootCommand;
  /** The native Tab command for a route (`"/"` is the root itself). */
  command(path: P): TabCommand;
}

export interface TabHooks {
  /** Called for every route after its command has been generated. */
  readonly route?: (meta: RouteMeta, command: TabCommand, root: RootCommand) => void;
  /** Called once with the finished tree. */
  readonly tree?: (tree: TabTree) => void;
}

export interface CompletionResult {
  readonly candidates: readonly Completion[];
  readonly directive: number;
  /** The exact protocol text for the shell script (`value\tdescription` lines, then `:directive`). */
  readonly output: string;
}

/** Mutable state for one completion request; populated by generated handlers. */
interface Request {
  path?: PathCompletion;
}

export function buildTab(meta: RouteMeta, hooks: TabHooks = {}, request: Request = {}): TabTree {
  const root = new RootCommand();
  const commands = new Map<RoutePath, TabCommand>();
  for (const route of flattenRoutes(meta)) {
    const command =
      route.segments.length === 0 ? root : root.command(route.segments.join(" "), route.description ?? "");
    register(command, route, request);
    commands.set(route.path, command);
  }
  const tree: TabTree = {
    root,
    command(path) {
      const command = commands.get(path);
      if (!command) throw new Error(`No Tab command for route ${JSON.stringify(path)}`);
      return command;
    },
  };
  for (const route of flattenRoutes(meta)) hooks.route?.(route, tree.command(route.path), root);
  hooks.tree?.(tree);
  return tree;
}

function register(command: TabCommand, meta: RouteMeta, request: Request): void {
  for (const param of meta.params) {
    const handler = handlerFor(completionOf(param.param), request);
    if (param.kind === "argument") command.argument(param.name, handler, param.multiple);
    if (param.kind === "option") registerOption(command, param, handler);
  }
  // Router claims these anywhere on the line (see `parse()`); mirror them so
  // Tab knows they take no value.
  command.option("help", "Print help", "h");
  if (meta.methods.includes("version")) command.option("version", "Print version", "v");
}

function registerOption(command: TabCommand, meta: OptionMeta, handler: OptionHandler | undefined): void {
  const longs = meta.flags.filter((flag) => flag.long);
  const [short] = meta.flags.filter((flag) => !flag.long);
  // Tab models one optional single-dash alias per option. With no long flag we
  // still register the short one so Tab knows whether it consumes a value.
  const entries = longs.length > 0 ? longs : short ? [short] : [];
  const primary = longs.find((flag) => flag.sets !== false) ?? entries[0];
  for (const flag of entries) {
    const key = flag.text.replace(/^--?/, "");
    const description =
      flag.sets === false && primary && primary !== flag
        ? `Turn off ${primary.text}`
        : (meta.description ?? "");
    const alias = flag === primary ? short?.text.slice(1) : undefined;
    const option = new Option(
      command,
      key,
      description,
      flag.takesValue ? handler : undefined,
      alias,
      !flag.takesValue,
    );
    command.options.set(key, option);
  }
}

function handlerFor(source: CompletionSource | undefined, request: Request): TabHandler | undefined {
  if (source === undefined) return undefined;
  if (typeof source === "function") return source;
  if (isPathCompletion(source)) {
    return () => {
      request.path = source;
    };
  }
  return (complete) => {
    for (const choice of source) {
      if (typeof choice === "string") complete(choice, "");
      else complete(choice.value, choice.description ?? "");
    }
  };
}

/**
 * Answer one completion request: `words` are the arguments after
 * `<program> complete --`, where the last word is the one being completed
 * (empty when the cursor follows a space).
 */
export function completeWords(meta: RouteMeta, words: readonly string[], hooks?: TabHooks): CompletionResult {
  const previous = words.slice(0, -1);
  const current = words.at(-1) ?? "";
  // After `--`, Router treats everything as literals: no options, commands or
  // arguments are bound there, so defer to the shell's path completion.
  if (previous.includes("--")) return result([], ShellCompDirective.ShellCompDirectiveDefault);

  const request: Request = {};
  let lines: string[];
  try {
    const { root } = buildTab(meta, hooks, request);
    lines = captureLines(() => root.parse([...normalize(previous), current]));
  } catch {
    return result([], ShellCompDirective.ShellCompDirectiveError);
  }

  const last = lines.at(-1);
  const tabDirective = last?.startsWith(":")
    ? Number(last.slice(1))
    : ShellCompDirective.ShellCompDirectiveNoFileComp;
  const candidates = (last?.startsWith(":") ? lines.slice(0, -1) : lines).map(parseLine);
  return request.path ? pathResult(candidates, request.path) : result(candidates, tabDirective);
}

function pathResult(candidates: readonly Completion[], path: PathCompletion): CompletionResult {
  // Other candidates (e.g. subcommands) win; when none match the shell falls
  // back to path completion because the directive no longer forbids it.
  if (candidates.length > 0) return result(candidates, ShellCompDirective.ShellCompDirectiveDefault);
  if (path.kind === "directories") return result([], ShellCompDirective.ShellCompDirectiveFilterDirs);
  if (path.extensions?.length) {
    return result(
      path.extensions.map((value) => ({ value })),
      ShellCompDirective.ShellCompDirectiveFilterFileExt,
    );
  }
  return result([], ShellCompDirective.ShellCompDirectiveDefault);
}

/**
 * Tab's parser decides option arity by looking options up by exact text, so a
 * previous `--name=value` word is unknown to it and swallows the following
 * word as a value. Splitting it into `--name value` is equivalent for Router
 * and lets Tab resolve the command and positional index correctly.
 */
function normalize(previous: readonly string[]): string[] {
  return previous.flatMap((word) => {
    const setter = /^(--[^-=\s][^=\s]*)=([\s\S]*)$/.exec(word);
    return setter?.[1] !== undefined && setter[2] !== undefined ? [setter[1], setter[2]] : [word];
  });
}

function parseLine(line: string): Completion {
  const tab = line.indexOf("\t");
  if (tab === -1) return { value: line };
  const description = line.slice(tab + 1);
  return description ? { value: line.slice(0, tab), description } : { value: line.slice(0, tab) };
}

function result(candidates: readonly Completion[], directive: number): CompletionResult {
  // Extension lines must be bare: zsh turns `\t` into `:` and would glob `*.png:`.
  const line = (candidate: Completion) =>
    directive === ShellCompDirective.ShellCompDirectiveFilterFileExt
      ? `${candidate.value}\n`
      : `${candidate.value}\t${candidate.description ?? ""}\n`;
  const body = candidates.map(line).join("");
  return { candidates, directive, output: `${body}:${directive}\n` };
}

/** Generate the shell script that calls `<program> complete -- ...`. */
export function completionScript(program: string, shell: Shell): string {
  const lines = captureLines(() => new RootCommand().setup(program, program, shell));
  return patchScript(shell, program, `${lines.join("\n")}\n`);
}

/**
 * Tab writes protocol output with `console.log`. Capture it for the duration
 * of a synchronous call so we can post-process it and route it to the app's
 * own output instead of the global console.
 */
function captureLines(run: () => void): string[] {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...values: unknown[]) => {
    lines.push(...values.map(String).join(" ").split("\n"));
  };
  try {
    run();
  } finally {
    console.log = original;
  }
  return lines;
}
