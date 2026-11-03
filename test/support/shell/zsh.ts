/**
 * Drive REAL zsh tab-completion non-interactively.
 *
 * How it works (see zsh-driver.zsh / zsh-init.zsh for the shell side):
 *  1. A scratch dir is created with a `bin/<commandName>` wrapper exec-ing commandPath (prepended
 *     to PATH), the completion script, the line to type and a `.zshrc`.
 *  2. `zsh -f zsh-driver.zsh` starts an interactive `zsh -d -i` inside a
 *     pseudo-terminal (zsh/zpty) with HOME=ZDOTDIR=<scratch>/home, so no user or
 *     global rc files are read. That shell runs `compinit`, sources the script
 *     and shadows `compadd` with a recorder that logs every match completers
 *     really add (after zsh's own matching against the current word), then
 *     calls the builtin so completion proceeds unchanged.
 *  3. The driver types `line` + TAB. TAB is bound to a widget that runs the
 *     normal `complete-word` and then records the resulting BUFFER.
 *  4. Results are exchanged through files (never parsed from the terminal),
 *     using \x1f / \x1e separators, so escape sequences cannot corrupt them.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface ZshCompletionOptions {
  /** The generated completion script text (e.g. output of `cli complete zsh`). */
  script: string;
  /** Command name the script registers (`compdef _<name> <name>`) and that is typed. */
  commandName: string;
  /** Absolute path of an executable that `commandName` resolves to via PATH. */
  commandPath: string;
  /** Text typed before TAB, cursor at the end, e.g. `"demo media web "`. */
  line: string;
  /** Working directory of the interactive shell (file completion); default: an empty dir. */
  cwd?: string;
  /** Extra environment for the shell (and therefore the CLI it invokes). */
  env?: Record<string, string>;
  /** Overall deadline in ms (default 10000). */
  timeoutMs?: number;
  /** Keep the scratch directory (its path is returned in `tempDir`). */
  keepTemp?: boolean;
}

/** One match as added to zsh's completion list by some `compadd` call. */
export interface ZshMatch {
  /** The word given to compadd (already shell-quoted when `flags` has `Q`). */
  word: string;
  /** What zsh inserts for it: IPREFIX + -P + -p + (quoted) word + -s. */
  insertion: string;
  /** `insertion` unquoted, i.e. the argument value the shell would produce. */
  value: string;
  /** Display string (-d), e.g. `"web   -- Optimise images"` for _describe. */
  display: string;
  /** Description parsed from a `_describe`-style display string, if any. */
  description?: string | undefined;
  /** compadd flag letters without arguments, e.g. `"lQa"` or `"Qf"`. */
  flags: string;
  /** compadd -f (file match). */
  isFile: boolean;
  /** File match that is a directory (zsh shows/inserts it with a `/`). */
  isDir: boolean;
  iprefix: string;
  /** -P (shown prefix) */
  prefix: string;
  /** -p (hidden prefix) */
  hiddenPrefix: string;
  /** -s (hidden suffix) */
  hiddenSuffix: string;
  /** -S (auto-removable suffix); undefined when -S was not passed. `""` = NoSpace. */
  suffix?: string | undefined;
  /** -W (directory file matches are relative to) */
  fileDir?: string | undefined;
}

export interface ZshCompletionResult {
  /**
   * Unquoted values of all distinct matches (deduplicated by insertion; see
   * `matches` for every individual compadd record), in the order added. Directory
   * file matches get a trailing `/` (as zsh displays them). For a nested path
   * the full path is given, e.g. `"sub dir/c.png"`.
   */
  candidates: string[];
  /** Command-line form of each match (what would be inserted), same order. */
  insertions: string[];
  matches: ZshMatch[];
  /** BUFFER after the TAB press (i.e. what zsh actually inserted). */
  buffer: string;
  cursor: number;
  /** compstate[nmatches] at the end of completion (cross-check for matches.length). */
  nmatches: number;
  /** compstate snapshot, e.g. `{ insert: "automenu-unambiguous", ... }`. */
  state: Record<string, string>;
  /** Human-readable dump of everything captured (for debugging / snapshots). */
  raw: string;
  /** Raw pty transcript (contains terminal escape sequences). */
  transcript: string;
  tempDir?: string | undefined;
}

const HERE = import.meta.dir;
const FS = "\x1f";
const RS = "\x1e";

let zshCache: boolean | undefined;

/** True if a `zsh` binary with the zpty/zselect/datetime modules is on PATH. */
export function zshAvailable(): boolean {
  if (zshCache !== undefined) return zshCache;
  if (!Bun.which("zsh")) return (zshCache = false);
  const r = Bun.spawnSync(["zsh", "-fc", "zmodload zsh/zpty zsh/zselect zsh/datetime"], {
    stdout: "ignore",
    stderr: "ignore",
  });
  return (zshCache = r.exitCode === 0);
}

const DRIVER_ERRORS: Record<number, string> = {
  2: "driver setup failed",
  3: "timed out waiting for the interactive shell to become ready",
  4: "timed out waiting for completion to finish",
  5: "the interactive shell exited unexpectedly",
};

export async function completeZsh(options: ZshCompletionOptions): Promise<ZshCompletionResult> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const dir = mkdtempSync(join(tmpdir(), "zsh-complete-"));
  try {
    const home = join(dir, "home");
    const bin = join(dir, "bin");
    mkdirSync(home);
    mkdirSync(bin);
    mkdirSync(join(dir, "cwd")); // empty default cwd, so file completion is predictable
    // A wrapper rather than a symlink, so `$0`-sensitive CLIs behave normally.
    await Bun.write(join(bin, options.commandName), `#!/bin/sh\nexec ${shQuote(options.commandPath)} "$@"\n`);
    chmodSync(join(bin, options.commandName), 0o755); // Bun.write ignores `mode` here
    await Bun.write(join(dir, "script.zsh"), options.script);
    await Bun.write(join(dir, "line"), options.line);
    await Bun.write(join(home, ".zshrc"), `source ${shQuote(join(HERE, "zsh-init.zsh"))}\n`);

    const env: Record<string, string | undefined> = { ...process.env };
    // Anything that could leak user configuration into the test shell.
    for (const k of ["ZDOTDIR", "FPATH", "ENV", "BASH_ENV", "PROMPT_COMMAND", "BASH_COMP_DEBUG_FILE"])
      delete env[k];
    Object.assign(env, options.env);
    Object.assign(env, {
      PATH: `${bin}:${options.env?.PATH ?? process.env.PATH ?? "/usr/bin:/bin"}`,
      HOME: home,
      ZDOTDIR: home,
      TERM: "xterm",
      CAP_DIR: dir,
      CAP_SCRIPT: join(dir, "script.zsh"),
      CAP_CWD: options.cwd ?? join(dir, "cwd"),
      CAP_TIMEOUT_MS: String(timeoutMs),
    });

    const proc = Bun.spawn(["zsh", "-f", join(HERE, "zsh-driver.zsh")], {
      env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    // Backstop in case the driver itself wedges; it normally enforces the deadline.
    const killer = setTimeout(() => proc.kill("SIGKILL"), timeoutMs + 3000);
    const [exitCode, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
    clearTimeout(killer);
    if (exitCode !== 0) await killInnerShell(dir);

    const transcript = await readIfExists(join(dir, "transcript"));
    if (existsSync(join(dir, "init-error"))) {
      throw new Error(`zsh: sourcing the completion script failed\n${transcript}`);
    }
    if (exitCode !== 0) {
      const why = DRIVER_ERRORS[exitCode] ?? `driver exited with ${exitCode}`;
      throw new Error(
        `completeZsh(${JSON.stringify(options.line)}): ${why}\n${stderr}\n--- transcript ---\n${transcript}`,
      );
    }

    const matches = parseRecords(await readIfExists(join(dir, "matches")));
    const result = Object.fromEntries(
      (await readIfExists(join(dir, "result"))).split(RS).filter(Boolean).map(splitKv),
    );
    const state = Object.fromEntries(
      (await readIfExists(join(dir, "state"))).split("\n").filter(Boolean).map(splitKv),
    );

    // Completers sometimes add the same match more than once (e.g. `_files -/`
    // adds directories under two tags); zsh merges those, so dedupe here too.
    const slash = (m: ZshMatch, s: string) => (m.isDir && !s.endsWith("/") ? `${s}/` : s);
    const unique = [...new Map(matches.map((m) => [slash(m, m.insertion), m] as const)).values()];
    const candidates = unique.map((m) => slash(m, m.value));
    const insertions = unique.map((m) => slash(m, m.insertion));
    const raw = [
      `line: ${JSON.stringify(options.line)}`,
      `buffer: ${JSON.stringify(result.BUFFER ?? "")}`,
      `state: ${JSON.stringify(state)}`,
      ...matches.map(
        (m) =>
          `match: ${JSON.stringify(m.value)} insert=${JSON.stringify(m.insertion)} flags=${m.flags}` +
          (m.description !== undefined ? ` desc=${JSON.stringify(m.description)}` : "") +
          (m.isDir ? " dir" : ""),
      ),
    ].join("\n");

    return {
      candidates,
      insertions,
      matches,
      buffer: result.BUFFER ?? "",
      cursor: Number(result.CURSOR ?? 0),
      nmatches: Number(state.nmatches ?? 0),
      state,
      raw,
      transcript,
      tempDir: options.keepTemp ? dir : undefined,
    };
  } finally {
    if (!options.keepTemp) rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Last-resort cleanup if the driver died without tearing down the pty: the
 * interactive shell leads its own process group (job control), which also
 * holds any CLI process it is waiting on.
 */
async function killInnerShell(dir: string): Promise<void> {
  const pid = Number((await readIfExists(join(dir, "pid"))).trim());
  if (!Number.isInteger(pid) || pid <= 1) return;
  for (const target of [-pid, pid]) {
    try {
      process.kill(target, "SIGKILL");
    } catch {
      // already gone
    }
  }
}

/** Parse records written by `__cap_record` in zsh-init.zsh. */
function parseRecords(text: string): ZshMatch[] {
  const out: ZshMatch[] = [];
  for (const rec of text.split(RS)) {
    if (!rec) continue;
    const [
      kind,
      flags = "",
      iprefix = "",
      prefix = "",
      hiddenPrefix = "",
      word = "",
      hiddenSuffix = "",
      suffixField = "",
      fileDir = "",
      display = "",
      isDir = "",
      insertion = "",
      value = "",
    ] = rec.split(FS);
    if (kind !== "M") continue;
    const desc = /^.*? +-- (.*)$/s.exec(display);
    out.push({
      word,
      insertion,
      value,
      display,
      description: desc?.[1],
      flags,
      isFile: flags.includes("f"),
      isDir: isDir === "1",
      iprefix,
      prefix,
      hiddenPrefix,
      hiddenSuffix,
      // "0" = no -S given, "1<suffix>" = -S <suffix> (possibly empty: NoSpace)
      suffix: suffixField.startsWith("1") ? suffixField.slice(1) : undefined,
      fileDir: fileDir || undefined,
    });
  }
  return out;
}

function splitKv(s: string): [string, string] {
  const i = s.indexOf("=");
  return i < 0 ? [s, ""] : [s.slice(0, i), s.slice(i + 1)];
}

async function readIfExists(path: string): Promise<string> {
  const f = Bun.file(path);
  return (await f.exists()) ? await f.text() : "";
}

function shQuote(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}
