/**
 * Unicode / text-anomaly scanning and safe fixing.
 *
 * The rules are deliberately split into categories:
 *
 * - invisible/bidi/control characters are safe to remove with `--fix`;
 * - typography (curly quotes, en dashes) is only changed with the explicit
 *   `--fix-typography` opt-in, because it can be intentional prose.
 *
 * Scanning and fixing are separate operations. Fixing re-reads each file and
 * refuses to write if it changed after the scan, preserving the user's edits.
 */

import {
  discoverFiles,
  encodeTextFile,
  fileSize,
  readTextFile,
  type TextFile,
  writeFileAtomic,
} from "./fs.ts";

export type Severity = "error" | "warn" | "info";
export type RuleCategory = "invisible" | "bidi" | "control" | "typography" | "separator";

export interface UnicodeRule {
  readonly codePoint: number;
  readonly severity: Severity;
  readonly category: RuleCategory;
  readonly description: string;
  /** Replacement used by `--fix`; absent means report only. */
  readonly replacement?: string;
}

const rule = (
  codePoint: number,
  severity: Severity,
  category: RuleCategory,
  description: string,
  replacement?: string,
): UnicodeRule => ({
  codePoint,
  severity,
  category,
  description,
  ...(replacement === undefined ? {} : { replacement }),
});

function buildRules(): ReadonlyMap<number, UnicodeRule> {
  const entries: UnicodeRule[] = [
    rule(0x0003, "warn", "control", "End-of-text control character", ""),
    rule(0x000b, "warn", "control", "Vertical tab", ""),
    rule(0x000c, "warn", "control", "Form feed", ""),
    rule(0x0085, "warn", "separator", "Next line (NEL) separator", "\n"),
    rule(0x00a0, "info", "invisible", "Non-breaking space", " "),
    rule(0x00ad, "info", "invisible", "Soft hyphen", ""),
    rule(0x061c, "error", "bidi", "Arabic letter mark", ""),
    rule(0x180e, "warn", "invisible", "Mongolian vowel separator", ""),
    rule(0x200b, "error", "invisible", "Zero-width space", ""),
    rule(0x200c, "warn", "invisible", "Zero-width non-joiner"),
    rule(0x200d, "warn", "invisible", "Zero-width joiner"),
    rule(0x200e, "error", "bidi", "Left-to-right mark", ""),
    rule(0x200f, "error", "bidi", "Right-to-left mark", ""),
    rule(0x2013, "warn", "typography", "En dash", "-"),
    rule(0x2014, "info", "typography", "Em dash"),
    rule(0x2018, "warn", "typography", "Left single quotation mark", "'"),
    rule(0x2019, "warn", "typography", "Right single quotation mark", "'"),
    rule(0x201a, "warn", "typography", "Single low-9 quotation mark", "'"),
    rule(0x201c, "warn", "typography", "Left double quotation mark", '"'),
    rule(0x201d, "warn", "typography", "Right double quotation mark", '"'),
    rule(0x201e, "warn", "typography", "Double low-9 quotation mark", '"'),
    rule(0x2028, "error", "separator", "Line separator", "\n"),
    rule(0x2029, "error", "separator", "Paragraph separator", "\n\n"),
    rule(0x202a, "error", "bidi", "Left-to-right embedding", ""),
    rule(0x202b, "error", "bidi", "Right-to-left embedding", ""),
    rule(0x202c, "error", "bidi", "Pop directional formatting", ""),
    rule(0x202d, "error", "bidi", "Left-to-right override", ""),
    rule(0x202e, "error", "bidi", "Right-to-left override", ""),
    rule(0x202f, "info", "invisible", "Narrow no-break space", " "),
    rule(0x205f, "info", "invisible", "Medium mathematical space", " "),
    rule(0x2060, "warn", "invisible", "Word joiner", ""),
    rule(0x2061, "warn", "invisible", "Function application", ""),
    rule(0x2062, "warn", "invisible", "Invisible times", ""),
    rule(0x2063, "warn", "invisible", "Invisible separator", ""),
    rule(0x2064, "warn", "invisible", "Invisible plus", ""),
    rule(0x2066, "error", "bidi", "Left-to-right isolate", ""),
    rule(0x2067, "error", "bidi", "Right-to-left isolate", ""),
    rule(0x2068, "error", "bidi", "First strong isolate", ""),
    rule(0x2069, "error", "bidi", "Pop directional isolate", ""),
    rule(0x3000, "info", "invisible", "Ideographic space", " "),
    rule(0xfeff, "error", "invisible", "Byte-order mark or zero-width no-break space", ""),
    rule(0xfffc, "error", "invisible", "Object replacement character"),
    rule(0xfffd, "error", "invisible", "Replacement character"),
  ];

  // Invisible spacing characters (U+2000..U+200A) are easy to introduce by
  // copy/paste and are safe to turn into a normal space.
  for (let cp = 0x2000; cp <= 0x200a; cp++) {
    entries.push(rule(cp, "info", "invisible", "Unicode spacing character", " "));
  }

  return new Map(entries.map((entry) => [entry.codePoint, entry]));
}

export const UNICODE_RULES: ReadonlyMap<number, UnicodeRule> = buildRules();

export function unicodeName(codePoint: number): string {
  return `U+${codePoint.toString(16).toUpperCase().padStart(4, "0")}`;
}

export function isFixable(rule: UnicodeRule, typography = false): boolean {
  return rule.replacement !== undefined && (rule.category !== "typography" || typography);
}

export interface UnicodeFinding {
  readonly index: number;
  readonly line: number;
  readonly column: number;
  readonly codePoint: number;
  readonly rule: UnicodeRule;
  readonly preview: string;
}

export interface ScanTextResult {
  readonly findings: readonly UnicodeFinding[];
  readonly lineEnding: "\n" | "\r\n" | "\r" | "mixed";
}

export function scanText(text: string): ScanTextResult {
  const findings: UnicodeFinding[] = [];
  const starts: number[] = [0];
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char === "\r") {
      if (text[index + 1] === "\n") index++;
      starts.push(index + 1);
    } else if (char === "\n") {
      starts.push(index + 1);
    }
  }

  for (const [lineIndex, start] of starts.entries()) {
    const next = starts[lineIndex + 1];
    let end = next === undefined ? text.length : Math.max(start, next - 1);
    if (end > start && text[end - 1] === "\r") end--;
    const lineText = text.slice(start, end);
    let offset = 0;
    while (offset < lineText.length) {
      const codePoint = lineText.codePointAt(offset);
      if (codePoint === undefined) break;
      const character = String.fromCodePoint(codePoint);
      const rule = UNICODE_RULES.get(codePoint);
      if (rule) {
        findings.push({
          index: start + offset,
          line: lineIndex + 1,
          column: offset + 1,
          codePoint,
          rule,
          preview: previewLine(lineText, offset),
        });
      }
      offset += character.length;
    }
  }

  return { findings, lineEnding: detectLineEnding(text) };
}

export function detectLineEnding(text: string): "\n" | "\r\n" | "\r" | "mixed" {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lf = (text.match(/(?<!\r)\n/g) ?? []).length;
  const cr = (text.match(/\r(?!\n)/g) ?? []).length;
  const kinds = [crlf > 0, lf > 0, cr > 0].filter(Boolean).length;
  if (kinds > 1) return "mixed";
  if (crlf > 0) return "\r\n";
  if (cr > 0) return "\r";
  return "\n";
}

/** Render a line without printing dangerous characters raw. */
export function previewLine(line: string, columnIndex: number): string {
  const start = Math.max(0, columnIndex - 35);
  const end = Math.min(line.length, columnIndex + 40);
  let visible = "";
  let offset = start;
  while (offset < end) {
    const codePoint = line.codePointAt(offset);
    if (codePoint === undefined) break;
    const character = String.fromCodePoint(codePoint);
    const rule = UNICODE_RULES.get(codePoint);
    if (rule) {
      visible += `⟦${unicodeName(codePoint)}⟧`;
    } else if (character === "\t") {
      visible += "  ";
    } else if (/\p{C}/u.test(character)) {
      visible += `⟦${unicodeName(codePoint)}⟧`;
    } else {
      visible += character;
    }
    offset += character.length;
  }
  return `${start ? "…" : ""}${visible}${end < line.length ? "…" : ""}`;
}

export interface ScanFileResult {
  readonly path: string;
  readonly text: string;
  readonly file: TextFile;
  readonly findings: readonly UnicodeFinding[];
  readonly lineEnding: "\n" | "\r\n" | "\r" | "mixed";
  readonly bytes: number;
}

export async function scanFile(path: string): Promise<ScanFileResult> {
  const file = await readTextFile(path);
  const { findings, lineEnding } = scanText(file.text);
  return { path, text: file.text, file, findings, lineEnding, bytes: file.bytes.length };
}

export interface SkippedFile {
  readonly path: string;
  readonly reason: string;
}

export interface ScanSummary {
  readonly files: readonly ScanFileResult[];
  readonly skipped: readonly SkippedFile[];
  readonly errors: readonly SkippedFile[];
  readonly scanned: number;
  readonly totalFindings: number;
  readonly fixableFindings: number;
}

export interface ScanPathsOptions {
  readonly cwd: string;
  readonly maxBytes?: number;
  readonly typography?: boolean;
  readonly includeHidden?: boolean;
  readonly respectGitIgnore?: boolean;
  readonly signal?: AbortSignal;
}

export async function scanPaths(paths: readonly string[], options: ScanPathsOptions): Promise<ScanSummary> {
  const discovered = await discoverFiles(paths, {
    cwd: options.cwd,
    respectGitIgnore: options.respectGitIgnore ?? true,
    ...(options.includeHidden === undefined ? {} : { includeHidden: options.includeHidden }),
  });

  const files: ScanFileResult[] = [];
  const skipped: SkippedFile[] = [];
  const errors: SkippedFile[] = [
    ...discovered.missing.map((path) => ({ path, reason: "path not found" })),
    ...discovered.unsupported.map((path) => ({ path, reason: "unsupported path" })),
    ...discovered.errors.map(({ path, error }) => ({ path, reason: error })),
  ];
  const maxBytes = options.maxBytes ?? 5 * 1024 * 1024;

  for (const path of discovered.files) {
    if (options.signal?.aborted) break;
    if ((await fileSize(path)) > maxBytes) {
      skipped.push({ path, reason: `larger than ${maxBytes} bytes` });
      continue;
    }
    try {
      const result = await scanFile(path);
      if (result.file.bytes.includes(0)) {
        skipped.push({ path, reason: "binary file" });
        continue;
      }
      files.push(result);
    } catch (error) {
      const entry = { path, reason: error instanceof Error ? error.message : String(error) };
      if (error instanceof TypeError)
        skipped.push(entry); // Non-UTF-8 input is intentionally excluded.
      else errors.push(entry);
    }
  }

  let totalFindings = 0;
  let fixableFindings = 0;
  for (const file of files) {
    totalFindings += file.findings.length;
    fixableFindings += file.findings.filter((finding) =>
      isFixable(finding.rule, options.typography ?? false),
    ).length;
  }

  return { files, skipped, errors, scanned: files.length, totalFindings, fixableFindings };
}

export interface FixOptions {
  readonly typography?: boolean;
  readonly dryRun?: boolean;
  readonly signal?: AbortSignal;
}

export interface FixedFile {
  readonly path: string;
  readonly changes: number;
  readonly before: number;
  readonly after: number;
}

export interface SkippedFix {
  readonly path: string;
  readonly reason: string;
}

export interface FixSummary {
  readonly changed: readonly FixedFile[];
  readonly skipped: readonly SkippedFix[];
  readonly replacements: number;
}

export function fixText(
  text: string,
  options: { readonly typography?: boolean } = {},
): { readonly text: string; readonly replacements: number } {
  let replacements = 0;
  let output = "";
  for (const character of text) {
    const codePoint = character.codePointAt(0);
    const rule = codePoint === undefined ? undefined : UNICODE_RULES.get(codePoint);
    if (rule && isFixable(rule, options.typography ?? false)) {
      output += rule.replacement ?? character;
      replacements++;
    } else {
      output += character;
    }
  }
  return { text: output, replacements };
}

export async function fixScans(
  scans: readonly ScanFileResult[],
  options: FixOptions = {},
): Promise<FixSummary> {
  const changed: FixedFile[] = [];
  const skipped: SkippedFix[] = [];
  let replacements = 0;

  for (const scan of scans) {
    if (options.signal?.aborted) break;
    if (scan.findings.length === 0) continue;
    const fixed = fixText(scan.text, { typography: options.typography ?? false });
    if (fixed.replacements === 0 || fixed.text === scan.text) continue;

    // Never clobber edits made after the scan.
    try {
      const current = await readTextFile(scan.path);
      if (!current.bytes.equals(scan.file.bytes)) {
        skipped.push({ path: scan.path, reason: "file changed after scanning" });
        continue;
      }
    } catch (error) {
      skipped.push({ path: scan.path, reason: error instanceof Error ? error.message : String(error) });
      continue;
    }

    const bytes = encodeTextFile(scan.file, fixed.text);
    if (!options.dryRun) {
      if (options.signal?.aborted) break;
      await writeFileAtomic(scan.path, bytes, { overwrite: true, expectedBytes: scan.file.bytes });
    }
    changed.push({
      path: scan.path,
      changes: fixed.replacements,
      before: scan.file.bytes.length,
      after: bytes.length,
    });
    replacements += fixed.replacements;
  }

  return { changed, skipped, replacements };
}
