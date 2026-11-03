/**
 * Router introspection: the ONLY module that reads `@bomb.sh/router`'s runtime
 * route and parameter structures.
 *
 * Router documents its definitions as immutable data ("composition pipelines")
 * and exposes `intent.definition`, but it does not promise a stable API for
 * walking a route tree. Everything here depends on the shape of Router 0.8:
 *
 * - `route.name`, `route.description`, `route.methods`, `route.version`
 * - `route.phases[].routes` (children) and `route.phases[].model.params`
 * - `route.phases[].resolver` (present on phases that pause for `dynamic()`)
 * - `param.name`, `param.description`, `param.cardinality`, `param.cli`
 *
 * Flag names are not stored as data: a parameter only carries an opaque
 * `cli.read(tokens)` function plus a human-readable `cli.syntax.label`. We
 * therefore treat the label (and Router's default naming rules) as a source of
 * *candidate* flags and keep only the candidates that the parameter's real
 * reader claims when probed with synthetic tokens. Completion metadata is thus
 * derived from Router's own parsing behaviour, not from guesses.
 *
 * `test/router-meta.test.ts` pins this behaviour against the installed Router
 * version; if an upgrade changes these structures, those tests fail first.
 */
import { name, route } from "@bomb.sh/router";
import type { AnyRoute, CLIRead, CLISymbol, Method, ReadCLI, RoutePath } from "@bomb.sh/router";

/** A Router parameter object as stored in `phase.model.params`. */
export type RouterParam = AnyRoute["phases"][number]["model"]["params"][string];

export interface RouteMeta {
  /** Application-relative route id, as used by Router intents (`/`, `/media/web`). */
  readonly path: RoutePath;
  /** Route names below the root (`["media", "web"]`). */
  readonly segments: readonly string[];
  readonly name: string;
  readonly description: string | undefined;
  readonly methods: readonly Method[];
  readonly version: string | undefined;
  readonly params: readonly ParamMeta[];
  readonly children: readonly RouteMeta[];
  /**
   * True when a phase pauses for `checkpoint()`/`dynamic()`. Routes added by a
   * dynamic extension only exist after `resume()`, so they are not listed here.
   */
  readonly dynamic: boolean;
  /** The original Router route object. */
  readonly route: AnyRoute;
}

export type ParamMeta = OptionMeta | ArgumentMeta | UnboundMeta;

interface ParamMetaBase {
  /** Router parameter name (the `name()` passed to option/toggle/argument). */
  readonly name: string;
  readonly description: string | undefined;
  /** `multiple()` was applied. */
  readonly multiple: boolean;
  /** The original Router parameter object. */
  readonly param: RouterParam;
}

export interface OptionMeta extends ParamMetaBase {
  readonly kind: "option";
  readonly flags: readonly FlagMeta[];
}

export interface ArgumentMeta extends ParamMetaBase {
  readonly kind: "argument";
}

/** A parameter with no command-line binding (e.g. values/env only). */
export interface UnboundMeta extends ParamMetaBase {
  readonly kind: "unbound";
}

export interface FlagMeta {
  /** The literal flag, e.g. `--format`, `--no-verbose`, `-o`. */
  readonly text: string;
  readonly long: boolean;
  /** Whether the flag consumes the following word (`--format webp`). */
  readonly takesValue: boolean;
  /** For switches: the value the flag sets (`false` for `--no-x`). */
  readonly sets: boolean | undefined;
}

export function describeRoute(route: AnyRoute): RouteMeta {
  return walk(route, []);
}

/** Depth-first list of every statically known route, root first. */
export function flattenRoutes(meta: RouteMeta): RouteMeta[] {
  return [meta, ...meta.children.flatMap(flattenRoutes)];
}

function walk(route: AnyRoute, segments: readonly string[]): RouteMeta {
  const params = route.phases.flatMap((phase) => Object.values(phase.model.params));
  return {
    path: toPath(segments),
    segments,
    name: route.name,
    description: route.description,
    methods: route.methods,
    version: route.version,
    params: params.map(describeParam),
    children: route.phases
      .flatMap((phase) => phase.routes)
      .map((child) => walk(child, [...segments, child.name])),
    dynamic: route.phases.some((phase) => phase.resolver !== undefined),
    route,
  };
}

export function toPath(segments: readonly string[]): RoutePath {
  return `/${segments.join("/")}`;
}

function describeParam(param: RouterParam): ParamMeta {
  const base = {
    name: param.name,
    description: param.description,
    multiple: param.cardinality === "many",
    param,
  };
  const syntax = param.cli.syntax;
  if (syntax?.type === "argument" || (!syntax && claimsWord(param.cli.read))) {
    return { ...base, kind: "argument" };
  }
  const flags = probeFlags(param.cli.read, candidateFlags(param.name, syntax?.label));
  return flags.length > 0 ? { ...base, kind: "option", flags } : { ...base, kind: "unbound" };
}

/**
 * Candidate flags: everything flag-shaped in the help label, plus Router's
 * default names (`--kebab-name`, and `--no-kebab-name` for toggles).
 */
function candidateFlags(name: string, label: string | undefined): string[] {
  const fromLabel = (label ?? "").split(/[\s,]+/).filter((word) => FLAG.test(word));
  const stem = dasherize(name);
  return [...new Set([...fromLabel, `--${stem}`, `--no-${stem}`])];
}

const FLAG = /^--?[^-=\s<>[\]][^=\s<>[\]]*$/;

function probeFlags(read: ReadCLI, candidates: readonly string[]): FlagMeta[] {
  const flags: FlagMeta[] = [];
  for (const text of candidates) {
    const long = text.startsWith("--");
    const flag: CLISymbol = {
      type: "flag",
      index: 0,
      text,
      flagText: text.replace(/^--?/, ""),
      flagType: long ? "long" : "short",
    };
    const withValue = read(new ProbeTokens([flag, { type: "word", index: 1, text: PROBE }]));
    if (withValue.claim.tokens.length === 2) {
      flags.push({ text, long, takesValue: true, sets: undefined });
      continue;
    }
    const alone = read(new ProbeTokens([flag]));
    if (alone.claim.tokens.length === 1 && alone.result.ok) {
      const value = alone.result.value;
      flags.push({
        text,
        long,
        takesValue: false,
        sets: value.exists && typeof value.value === "boolean" ? value.value : undefined,
      });
    } else if (alone.claim.tokens.length === 1) {
      // Claimed but rejected without a value: a value-taking flag.
      flags.push({ text, long, takesValue: true, sets: undefined });
    }
  }
  return flags;
}

function claimsWord(read: ReadCLI): boolean {
  return read(new ProbeTokens([{ type: "word", index: 0, text: PROBE }])).claim.tokens.length > 0;
}

const PROBE = "\u0000probe";

/** Router's own flag naming rule (`dryRun` → `dry-run`). */
export function dasherize(name: string): string {
  return name
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2")
    .replace(/([a-z\d])([A-Z])/g, "$1-$2")
    .replace(/[\s_]+/g, "-")
    .toLowerCase();
}

type TokenInput = Parameters<ReadCLI>[0];
type Claim = CLIRead["claim"];

/**
 * A minimal, side-effect-free implementation of Router's token input used to
 * probe parameter readers. Mirrors the semantics of Router's `Tokenizer`.
 */
class ProbeTokens implements TokenInput {
  readonly tokens: readonly CLISymbol[];
  readonly claimed: ReadonlySet<number>;

  constructor(tokens: readonly CLISymbol[], claimed: ReadonlySet<number> = new Set()) {
    this.tokens = tokens;
    this.claimed = claimed;
  }

  *[Symbol.iterator](): Generator<CLISymbol, void, unknown> {
    for (const token of this.tokens) {
      if (!this.claimed.has(token.index)) yield token;
    }
  }

  claimNext(): Claim {
    return this.claimOne(() => true);
  }

  claimOne<S extends CLISymbol>(match: (token: CLISymbol) => token is S): { tokens: S[]; rest: ProbeTokens };
  claimOne(match: (token: CLISymbol) => boolean): Claim;
  claimOne(match: (token: CLISymbol) => boolean): Claim {
    for (const token of this) {
      if (match(token)) return { tokens: [token], rest: this.without([token.index]) };
    }
    return { tokens: [], rest: this };
  }

  claimPair(match: (a: CLISymbol, b: CLISymbol) => boolean): Claim {
    let previous: CLISymbol | undefined;
    for (const token of this) {
      if (previous && token.index === previous.index + 1 && match(previous, token)) {
        return { tokens: [previous, token], rest: this.without([previous.index, token.index]) };
      }
      previous = token;
    }
    return { tokens: [], rest: this };
  }

  claimAll<S extends CLISymbol>(match: (token: CLISymbol) => token is S): { tokens: S[]; rest: ProbeTokens };
  claimAll(match: (token: CLISymbol) => boolean): Claim;
  claimAll(match: (token: CLISymbol) => boolean): Claim {
    const tokens = [...this].filter(match);
    return { tokens, rest: tokens.length > 0 ? this.without(tokens.map((t) => t.index)) : this };
  }

  view(): TokenInput {
    return this;
  }

  private without(indices: readonly number[]): ProbeTokens {
    return new ProbeTokens(this.tokens, new Set([...this.claimed, ...indices]));
  }
}

/**
 * The parameter objects a bundle (`option()`, `toggle()`, `extend(...)`)
 * contributes. Router stores these exact objects on every route that applies
 * the bundle, so identity tells which route applied it.
 */
export function paramsOf(bundle: (value: never) => unknown): readonly RouterParam[] {
  // Typed as `never`: Router's pipeline types cannot express "some element";
  // at runtime every element is a route => route function.
  return describeRoute(route(name("~bundle"), bundle as never)).params.map((meta) => meta.param);
}

/** The deepest route among `candidates` that applied every parameter of `bundle`. */
export function findApplier(
  bundle: (value: never) => unknown,
  candidates: readonly RouteMeta[],
): RouteMeta | undefined {
  const params = paramsOf(bundle);
  if (params.length === 0) return undefined;
  return candidates.findLast((meta) =>
    params.every((param) => meta.params.some((own) => own.param === param)),
  );
}
