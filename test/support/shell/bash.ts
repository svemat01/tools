/**
 * Invoke a bash completion function non-interactively (no readline, no pty).
 *
 * This is the standard technique: split the line into COMP_WORDS the way bash
 * does (splitCompWords), set COMP_WORDS/COMP_CWORD/COMP_LINE/COMP_POINT, call
 * the function registered via `complete -F <fn> <name>` and read COMPREPLY.
 * See bash-driver.bash for the shell side.
 *
 * What this does NOT model (readline does it after the function returns):
 *  - quoting/escaping of COMPREPLY entries and the trailing space / `/`
 *    (`-o filenames`, `-o nospace`): COMPREPLY is returned verbatim; the
 *    effective `-o` options are reported in `options` instead;
 *  - readline's own filename completion when COMPREPLY is empty and
 *    `-o default` is in effect: reported as `fallsBackToDefault`;
 *  - the common-prefix insertion and the listing.
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** bash's default COMP_WORDBREAKS (whitespace is always a delimiter as well). */
export const DEFAULT_COMP_WORDBREAKS = `"'><=;|&(:`;

export const BASH_COMPLETION_CANDIDATES = [
  "/usr/share/bash-completion/bash_completion",
  "/opt/homebrew/share/bash-completion/bash_completion",
  "/opt/homebrew/etc/profile.d/bash_completion.sh",
  "/usr/local/share/bash-completion/bash_completion",
  "/usr/local/etc/profile.d/bash_completion.sh",
  "/etc/bash_completion",
];

export interface BashAvailability {
  ok: boolean;
  reason?: string | undefined;
  bashPath?: string | undefined;
  bashVersion?: string | undefined;
  bashCompletionPath?: string | undefined;
}

let availabilityCache: BashAvailability | undefined;

/**
 * Bash ≥ 4 (Tab's script uses `compopt`) plus a bash-completion that defines
 * `_get_comp_words_by_ref`. `BASH_COMPLETION_PATH` in the environment, if set,
 * is tried before the common install locations.
 */
export function bashAvailable(): BashAvailability {
  if (availabilityCache) return availabilityCache;
  return (availabilityCache = detect());
}

function detect(): BashAvailability {
  const bashPath = Bun.which("bash");
  if (!bashPath) return { ok: false, reason: "bash not found on PATH" };
  const v = Bun.spawnSync([bashPath, "--noprofile", "--norc", "-c", 'printf %s "$BASH_VERSION"'], {
    stdout: "pipe",
    stderr: "ignore",
  });
  const bashVersion = v.stdout.toString();
  const major = Number(bashVersion.split(".")[0]);
  if (!(major >= 4)) {
    return {
      ok: false,
      reason: `bash ${bashVersion || "?"} at ${bashPath} is older than 4 (no compopt)`,
      bashPath,
      bashVersion,
    };
  }
  const env = process.env.BASH_COMPLETION_PATH;
  for (const path of env ? [env, ...BASH_COMPLETION_CANDIDATES] : BASH_COMPLETION_CANDIDATES) {
    if (!Bun.file(path).size) continue; // missing (size 0) or empty
    const r = Bun.spawnSync(
      [
        bashPath,
        "--noprofile",
        "--norc",
        "-c",
        'PS1="$ "; . "$1" >/dev/null 2>&1; declare -F _get_comp_words_by_ref >/dev/null',
        "_",
        path,
      ],
      { stdout: "ignore", stderr: "ignore" },
    );
    if (r.exitCode === 0) return { ok: true, bashPath, bashVersion, bashCompletionPath: path };
  }
  return {
    ok: false,
    reason: `no bash-completion providing _get_comp_words_by_ref found (tried ${BASH_COMPLETION_CANDIDATES.join(", ")})`,
    bashPath,
    bashVersion,
  };
}

export interface BashCompletionOptions {
  /** The generated completion script text (e.g. output of `cli complete bash`). */
  script: string;
  /** Command name the script registers with `complete -F`. */
  commandName: string;
  /** Absolute path of an executable that `commandName` resolves to via PATH. */
  commandPath: string;
  /** Text before the cursor, e.g. `"demo media web "` (cursor at the end). */
  line: string;
  cwd?: string | undefined;
  env?: Record<string, string> | undefined;
  /** Default 10000. */
  timeoutMs?: number | undefined;
  /** Override the bash binary (default: from bashAvailable()). */
  bashPath?: string | undefined;
  /** Override the bash-completion script; `""` = source none. */
  bashCompletionPath?: string | undefined;
  /** COMP_WORDBREAKS used to split the line (default: bash's default). */
  wordbreaks?: string | undefined;
}

export interface BashCompletionResult {
  /** COMPREPLY, verbatim. */
  candidates: string[];
  /** Human-readable dump for debugging. */
  raw: string;
  /** COMP_WORDS / COMP_CWORD that were passed. */
  words: string[];
  cword: number;
  /** `complete -p <name>` output, e.g. `complete -F __demo_complete demo`. */
  spec: string;
  /** Argument strings of every `compopt` call made by the function. */
  compopt: string[];
  /** Effective `-o` options: from `spec`, then +o/-o from compopt calls. */
  options: string[];
  /** COMPREPLY empty and `-o default` effective: readline would complete file names. */
  fallsBackToDefault: boolean;
  /** Exit status of the completion function. */
  status: number;
}

const HERE = import.meta.dir;

export async function completeBash(options: BashCompletionOptions): Promise<BashCompletionResult> {
  let { bashPath, bashCompletionPath } = options;
  if (bashPath === undefined || bashCompletionPath === undefined) {
    const avail = bashAvailable();
    if (!avail.ok) throw new Error(`completeBash: bash completion unavailable: ${avail.reason}`);
    bashPath ??= avail.bashPath ?? "bash";
    bashCompletionPath ??= avail.bashCompletionPath ?? "";
  }
  const timeoutMs = options.timeoutMs ?? 10_000;
  const { words, cword } = splitCompWords(options.line, options.wordbreaks);

  const dir = mkdtempSync(join(tmpdir(), "bash-complete-"));
  try {
    const bin = join(dir, "bin");
    mkdirSync(bin);
    mkdirSync(join(dir, "cwd"));
    // A wrapper rather than a symlink, so `$0`-sensitive CLIs behave normally.
    await Bun.write(join(bin, options.commandName), `#!/bin/sh\nexec ${shQuote(options.commandPath)} "$@"\n`);
    chmodSync(join(bin, options.commandName), 0o755); // Bun.write ignores `mode` here
    await Bun.write(join(dir, "script.bash"), options.script);
    await Bun.write(join(dir, "words"), words.map((w) => `${w}\0`).join(""));
    await Bun.write(join(dir, "cword"), String(cword));
    await Bun.write(join(dir, "line"), options.line);
    await Bun.write(join(dir, "point"), String(Buffer.byteLength(options.line)));

    const env: Record<string, string | undefined> = { ...process.env };
    for (const k of ["BASH_ENV", "ENV", "PROMPT_COMMAND", "BASH_COMP_DEBUG_FILE", "COMP_WORDBREAKS"])
      delete env[k];
    Object.assign(env, options.env, {
      PATH: `${bin}:${options.env?.PATH ?? process.env.PATH ?? "/usr/bin:/bin"}`,
      HOME: join(dir, "cwd"),
      CAP_DIR: dir,
      CAP_SCRIPT: join(dir, "script.bash"),
      CAP_NAME: options.commandName,
      CAP_BASH_COMPLETION: bashCompletionPath,
      CAP_CWD: options.cwd ?? join(dir, "cwd"),
    });

    // detached: own process group, so a hanging CLI can be killed with it.
    const proc = Bun.spawn([bashPath, "--noprofile", "--norc", join(HERE, "bash-driver.bash")], {
      env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      detached: true,
    });
    let timedOut = false;
    const killer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-proc.pid, "SIGKILL");
      } catch {
        proc.kill("SIGKILL");
      }
    }, timeoutMs);
    const [exitCode, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
    clearTimeout(killer);
    if (timedOut)
      throw new Error(`completeBash(${JSON.stringify(options.line)}): timed out after ${timeoutMs}ms`);
    if (exitCode === 6)
      throw new Error(`completeBash: no completion registered for ${options.commandName}\n${stderr}`);
    if (exitCode !== 0) throw new Error(`completeBash: driver exited with ${exitCode}\n${stderr}`);

    const read = async (name: string) => {
      const f = Bun.file(join(dir, name));
      return (await f.exists()) ? await f.text() : "";
    };
    const nulList = (s: string) => (s ? s.slice(0, s.endsWith("\0") ? -1 : undefined).split("\0") : []);
    const candidates = nulList(await read("reply"));
    const compopt = nulList(await read("compopt"));
    const spec = (await read("spec")).trim();
    const status = Number(await read("status"));
    const opts = effectiveOptions(spec, compopt);
    const fallsBackToDefault = candidates.length === 0 && opts.includes("default");

    const raw = [
      `line: ${JSON.stringify(options.line)}`,
      `words: ${JSON.stringify(words)} cword=${cword}`,
      `spec: ${spec}`,
      `compopt: ${JSON.stringify(compopt)}`,
      `status: ${status}`,
      `COMPREPLY: ${JSON.stringify(candidates)}`,
      ...(stderr ? [`stderr: ${stderr.trimEnd()}`] : []),
    ].join("\n");
    return { candidates, raw, words, cword, spec, compopt, options: opts, fallsBackToDefault, status };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** `-o name` options from `complete -p` output, updated by compopt -o/+o calls. */
function effectiveOptions(spec: string, compoptCalls: string[]): string[] {
  const set = new Set<string>();
  const specTokens = spec.split(/\s+/);
  specTokens.forEach((t, i) => {
    const next = specTokens[i + 1];
    if (t === "-o" && next) set.add(next);
  });
  for (const call of compoptCalls) {
    const t = call.split(/\s+/);
    t.forEach((tok, i) => {
      const next = t[i + 1];
      if (!next) return;
      if (tok === "-o") set.add(next);
      else if (tok === "+o") set.delete(next);
    });
  }
  return [...set];
}

/**
 * Split a command line into COMP_WORDS like bash does for programmable
 * completion (bash's split_at_delims with SD_NOQUOTEDELIM|SD_COMPLETE):
 *  - unquoted whitespace separates words and is dropped;
 *  - a run of unquoted non-whitespace COMP_WORDBREAKS characters (except
 *    quotes, which quote) forms a word of its own: `--format=webp` ->
 *    `--format`, `=`, `webp`;
 *  - quotes and backslashes are kept verbatim (`my\ file` is one word);
 *    an unterminated quote extends to the end of the line.
 * The cursor is assumed at the end of `line`. If the line ends in whitespace,
 * an empty current word is appended; if it ends in a delimiter word such as
 * `=`, that word is the current one (as in real bash).
 */
export function splitCompWords(
  line: string,
  wordbreaks: string = DEFAULT_COMP_WORDBREAKS,
): { words: string[]; cword: number } {
  const isWs = (c: string | undefined) => c === " " || c === "\t" || c === "\n";
  const delim = (c: string | undefined) =>
    c !== undefined && (isWs(c) || wordbreaks.includes(c)) && c !== `"` && c !== "'";
  const nonWsDelim = (c: string | undefined) => delim(c) && !isWs(c);

  const skipToDelim = (start: number): number => {
    let i = start;
    while (i < line.length) {
      const c = line[i];
      if (c === "\\") i += 2;
      else if (c === "'") {
        const end = line.indexOf("'", i + 1);
        if (end < 0) return line.length;
        i = end + 1;
      } else if (c === `"` || (c === "$" && line[i + 1] === "'")) {
        // double quotes / $'...' : backslash escapes, ends at the matching quote
        const q = c === "$" ? "'" : `"`;
        i += c === "$" ? 2 : 1;
        while (i < line.length && line[i] !== q) i += line[i] === "\\" ? 2 : 1;
        if (i >= line.length) return line.length;
        i++;
      } else if (c === "`") {
        const end = line.indexOf("`", i + 1);
        if (end < 0) return line.length;
        i = end + 1;
      } else if (c === "$" && line[i + 1] === "(") {
        let depth = 0;
        for (i += 1; i < line.length; i++) {
          if (line[i] === "(") depth++;
          else if (line[i] === ")" && --depth === 0) break;
        }
        if (i >= line.length) return line.length;
        i++;
      } else if (delim(c)) return i;
      else i++;
    }
    return Math.min(i, line.length);
  };

  const words: string[] = [];
  const point = line.length;
  let cword = -1;
  let i = 0;
  let lastEnd = 0;
  while (isWs(line[i])) i++;
  while (i < line.length) {
    const ts = i;
    let te = skipToDelim(ts);
    if (te === ts && nonWsDelim(line[ts])) {
      te = ts + 1;
      while (nonWsDelim(line[te])) te++;
    }
    words.push(line.slice(ts, te));
    if (cword < 0 && point >= ts && point <= te) cword = words.length - 1;
    lastEnd = te;
    i = te;
    while (isWs(line[i])) i++;
  }
  if (cword < 0 && point >= lastEnd) {
    if (point === 0 || isWs(line[point - 1])) words.push("");
    cword = words.length - 1;
  }
  return { words, cword };
}

function shQuote(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}
