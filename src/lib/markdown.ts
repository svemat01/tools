/**
 * Markdown/MDX analysis and conservative text edits.
 *
 * Parsing uses unified/remark, so links, images, definitions and MDX JSX are
 * found structurally. Rewrites are expressed as offset-based `TextEdit`s and
 * applied from the end, which preserves everything the edit does not target.
 */

import { parse as parseYaml } from "yaml";
import remarkFrontmatter from "remark-frontmatter";
import remarkGfm from "remark-gfm";
import remarkMdx from "remark-mdx";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { visit } from "unist-util-visit";
import type { Node } from "unist";

export interface MarkdownReference {
  readonly kind: "image" | "link" | "definition" | "html" | "jsx";
  readonly url: string;
  readonly alt?: string;
  readonly nodeStart: number;
  readonly nodeEnd: number;
  readonly line: number;
  readonly column: number;
  readonly raw: string;
}

export interface MarkdownParseResult {
  readonly references: readonly MarkdownReference[];
  readonly parseError?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function startOffset(node: Node): { start: number; end: number; line: number; column: number } | undefined {
  const position = node.position;
  if (position?.start.offset === undefined || position.end.offset === undefined) return undefined;
  return {
    start: position.start.offset,
    end: position.end.offset,
    line: position.start.line,
    column: position.start.column,
  };
}

export function parseMarkdown(source: string, path: string): MarkdownParseResult {
  const mdx = /\.mdx$/i.test(path);
  const make = () => unified().use(remarkParse).use(remarkGfm).use(remarkFrontmatter);

  try {
    const tree = mdx ? make().use(remarkMdx).parse(source) : make().parse(source);
    const references: MarkdownReference[] = [];
    visit(tree, (node) => {
      const position = startOffset(node);
      if (!position) return;
      const raw = source.slice(position.start, position.end);
      const base = {
        nodeStart: position.start,
        nodeEnd: position.end,
        line: position.line,
        column: position.column,
        raw,
      };

      if (node.type === "image" && isRecord(node) && typeof node.url === "string") {
        references.push({
          ...base,
          kind: "image",
          url: node.url,
          ...(typeof node.alt === "string" ? { alt: node.alt } : {}),
        });
        return;
      }
      if (node.type === "link" && isRecord(node) && typeof node.url === "string") {
        references.push({ ...base, kind: "link", url: node.url });
        return;
      }
      if (node.type === "definition" && isRecord(node) && typeof node.url === "string") {
        references.push({ ...base, kind: "definition", url: node.url });
        return;
      }
      if (node.type === "html") {
        for (const attribute of htmlAttributes(raw)) {
          references.push({
            ...base,
            kind: "html",
            url: attribute.url,
            ...(attribute.alt === undefined ? {} : { alt: attribute.alt }),
          });
        }
        return;
      }
      if (node.type === "mdxJsxFlowElement" || node.type === "mdxJsxTextElement") {
        const attributes = isRecord(node) && Array.isArray(node.attributes) ? node.attributes : [];
        let url: string | undefined;
        let alt: string | undefined;
        for (const attribute of attributes) {
          if (!isRecord(attribute) || typeof attribute.name !== "string") continue;
          const value = attribute.value;
          const text = typeof value === "string" ? value : undefined;
          if (text === undefined) continue;
          if (attribute.name === "src" || attribute.name === "href") url = text;
          if (attribute.name === "alt") alt = text;
        }
        if (url !== undefined) {
          references.push({ ...base, kind: "jsx", url, ...(alt === undefined ? {} : { alt }) });
        }
      }
    });
    return { references };
  } catch (error) {
    return {
      references: [],
      parseError: error instanceof Error ? error.message : String(error),
    };
  }
}

function htmlAttributes(raw: string): { url: string; alt?: string }[] {
  const found: { url: string; alt?: string }[] = [];
  const attribute = /\b(src|href)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
  let match;
  while ((match = attribute.exec(raw)) !== null) {
    const url = match[2] ?? match[3] ?? match[4] ?? "";
    if (!url) continue;
    const altMatch = /\balt\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(raw);
    const alt = altMatch ? (altMatch[1] ?? altMatch[2] ?? altMatch[3] ?? "") : undefined;
    found.push({ url, ...(alt === undefined ? {} : { alt }) });
  }
  return found;
}

export interface FrontmatterResult {
  readonly data: Readonly<Record<string, unknown>>;
  readonly body: string;
  readonly raw: string;
}

/** Parse a leading `--- ... ---` YAML frontmatter block. */
export function extractFrontmatter(source: string): FrontmatterResult {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(source);
  if (!match) return { data: {}, body: source, raw: "" };
  const raw = match[1] ?? "";
  let data: unknown;
  try {
    data = parseYaml(raw);
  } catch (error) {
    throw new Error(`Invalid YAML frontmatter: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (data === null || data === undefined) return { data: {}, body: source.slice(match[0].length), raw };
  if (!isRecord(data)) throw new Error("YAML frontmatter must be an object");
  return { data, body: source.slice(match[0].length), raw };
}

export interface TextEdit {
  readonly start: number;
  readonly end: number;
  readonly replacement: string;
  readonly reason: string;
}

export function applyEdits(source: string, edits: readonly TextEdit[]): string {
  const sorted = [...edits].sort((a, b) => b.start - a.start);
  let output = source;
  let boundary = source.length;
  for (const edit of sorted) {
    if (edit.start < 0 || edit.end > source.length || edit.start > edit.end) {
      throw new Error(`Invalid text edit at ${edit.start}..${edit.end}`);
    }
    if (edit.end > boundary) {
      throw new Error(`Overlapping text edits near offset ${edit.start}`);
    }
    output = `${output.slice(0, edit.start)}${edit.replacement}${output.slice(edit.end)}`;
    boundary = edit.start;
  }
  return output;
}

/** Replace an exact URL inside a node, preserving the rest of the node. */
export function urlEdit(source: string, reference: MarkdownReference, replacement: string): TextEdit | undefined {
  if (reference.url === replacement) return undefined;
  const raw = source.slice(reference.nodeStart, reference.nodeEnd);
  if (!raw.includes(reference.url)) return undefined;
  return {
    start: reference.nodeStart,
    end: reference.nodeEnd,
    replacement: raw.split(reference.url).join(replacement),
    reason: `rewrite ${reference.url} → ${replacement}`,
  };
}

const TRACKING_PARAMETERS = new Set([
  "source",
  "ref",
  "referrer",
  "fbclid",
  "gclid",
  "dclid",
  "msclkid",
  "mc_cid",
  "mc_eid",
  "igshid",
  "si",
  "s",
  "vero_id",
  "oly_anon_id",
  "oly_enc_id",
  "wickedid",
  "_hsenc",
  "_hsmi",
  "mkt_tok",
  "trk",
  "trkcampaign",
  "sc_campaign",
  "sc_channel",
  "sc_content",
  "sc_medium",
  "sc_outcome",
  "sc_geo",
  "sc_country",
]);

export function isExternalUrl(url: string): boolean {
  return /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(url);
}

export function isTrackingParameter(name: string): boolean {
  const lower = name.toLowerCase();
  return TRACKING_PARAMETERS.has(lower) || lower.startsWith("utm_");
}

export interface TrackingResult {
  readonly url: string;
  readonly removed: readonly string[];
}

/** Remove known tracking parameters without touching the path or fragment. */
export function stripTrackingParameters(url: string): TrackingResult {
  if (!url.includes("?")) return { url, removed: [] };
  const hashIndex = url.indexOf("#");
  const hash = hashIndex === -1 ? "" : url.slice(hashIndex);
  const beforeHash = hashIndex === -1 ? url : url.slice(0, hashIndex);
  const queryIndex = beforeHash.indexOf("?");
  if (queryIndex === -1) return { url, removed: [] };
  const path = beforeHash.slice(0, queryIndex);
  const query = beforeHash.slice(queryIndex + 1);
  const params = new URLSearchParams(query);
  const removed: string[] = [];
  for (const name of [...params.keys()]) {
    if (isTrackingParameter(name)) {
      params.delete(name);
      removed.push(name);
    }
  }
  if (removed.length === 0) return { url, removed: [] };
  const search = params.toString();
  return { url: `${path}${search ? `?${search}` : ""}${hash}`, removed };
}

/** Split `path?query#hash` into the filesystem path and the suffix. */
export function splitUrlSuffix(url: string): { readonly path: string; readonly suffix: string } {
  const match = /^([^?#]*)([?#].*)?$/.exec(url);
  return { path: match?.[1] ?? url, suffix: match?.[2] ?? "" };
}

/** Convert a filesystem path to a URL path with forward slashes. */
export function toUrlPath(path: string): string {
  return path.split("\\").join("/");
}

export interface NormalizeResult {
  readonly text: string;
  readonly changed: boolean;
  readonly collapsedBlankLines: number;
}

/**
 * Collapse runs of blank lines outside frontmatter and fenced code, and ensure
 * exactly one trailing newline. Existing line endings are reused.
 */
export function normalizeBlankLines(source: string): NormalizeResult {
  const lines = splitLines(source);
  const output: { text: string; ending: string }[] = [];
  let inFrontmatter = false;
  let fence: string | undefined;
  let previousBlank = false;
  let collapsed = 0;

  for (const [index, line] of lines.entries()) {
    const trimmed = line.text.trim();
    if (index === 0 && trimmed === "---") {
      inFrontmatter = true;
      output.push(line);
      previousBlank = false;
      continue;
    }
    if (inFrontmatter) {
      output.push(line);
      if (trimmed === "---") inFrontmatter = false;
      previousBlank = false;
      continue;
    }
    if (fence !== undefined) {
      output.push(line);
      if (trimmed.startsWith(fence)) fence = undefined;
      previousBlank = false;
      continue;
    }
    if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) {
      fence = trimmed.slice(0, 3);
      output.push(line);
      previousBlank = false;
      continue;
    }

    const blank = trimmed === "";
    if (blank) {
      if (previousBlank) {
        collapsed++;
        continue;
      }
      previousBlank = true;
      output.push(line);
    } else {
      previousBlank = false;
      output.push(line);
    }
  }

  // Drop trailing blank lines, then add one line ending.
  while (output.length > 0 && (output.at(-1)?.text.trim() ?? "") === "") output.pop();
  const ending = dominantEnding(lines);
  const text = `${output.map((line) => line.text + line.ending).join("").replace(/(?:\r\n|\n|\r)+$/, "")}${ending}`;
  return { text, changed: text !== source, collapsedBlankLines: collapsed };
}

function splitLines(source: string): { text: string; ending: string }[] {
  const lines: { text: string; ending: string }[] = [];
  const pattern = /([^\r\n]*)(\r\n|\n|\r|$)/g;
  let match;
  while ((match = pattern.exec(source)) !== null) {
    if (match[0] === "") break;
    lines.push({ text: match[1] ?? "", ending: match[2] ?? "" });
    if (match[2] === "") break;
  }
  return lines;
}

function dominantEnding(lines: readonly { ending: string }[]): string {
  const counts = new Map<string, number>();
  for (const line of lines) {
    if (!line.ending) continue;
    counts.set(line.ending, (counts.get(line.ending) ?? 0) + 1);
  }
  let best = "\n";
  let bestCount = 0;
  for (const [ending, count] of counts) {
    if (count > bestCount) {
      best = ending;
      bestCount = count;
    }
  }
  return best;
}
