/**
 * Markdown/MDX analysis and conservative text edits.
 *
 * Parsing uses unified/remark, so links, images, definitions and MDX JSX are
 * found structurally. Rewrites are expressed as offset-based `TextEdit`s and
 * applied from the end, which preserves everything the edit does not target.
 */

import remarkFrontmatter from "remark-frontmatter";
import remarkGfm from "remark-gfm";
import remarkMdx from "remark-mdx";
import remarkParse from "remark-parse";
import { unified } from "unified";
import type { Node } from "unist";
import { visit } from "unist-util-visit";
import { parse as parseYaml } from "yaml";

export interface MarkdownReference {
  readonly kind: "image" | "link" | "definition" | "html" | "jsx";
  readonly url: string;
  readonly alt?: string;
  readonly nodeStart: number;
  readonly nodeEnd: number;
  readonly line: number;
  readonly column: number;
  readonly raw: string;
  /** Exact source span, absent when the decoded destination cannot be safely located. */
  readonly urlStart?: number;
  readonly urlEnd?: number;
  readonly urlSyntax?: "markdown" | "angle" | "double" | "single" | "unquoted";
}

export interface MarkdownParseResult {
  readonly references: readonly MarkdownReference[];
  readonly parseError?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
          ...markdownDestination(raw, position.start, node.url, false),
          ...(typeof node.alt === "string" ? { alt: node.alt } : {}),
        });
        return;
      }
      if (node.type === "link" && isRecord(node) && typeof node.url === "string") {
        references.push({
          ...base,
          kind: "link",
          url: node.url,
          ...markdownDestination(raw, position.start, node.url, false),
        });
        return;
      }
      if (node.type === "definition" && isRecord(node) && typeof node.url === "string") {
        references.push({
          ...base,
          kind: "definition",
          url: node.url,
          ...markdownDestination(raw, position.start, node.url, true),
        });
        return;
      }
      if (node.type === "html") {
        for (const attribute of htmlAttributes(raw)) {
          references.push({
            ...base,
            kind: "html",
            url: attribute.url,
            urlStart: position.start + attribute.start,
            urlEnd: position.start + attribute.end,
            urlSyntax: attribute.syntax,
            ...(attribute.alt === undefined ? {} : { alt: attribute.alt }),
          });
        }
        return;
      }
      if (node.type === "mdxJsxFlowElement" || node.type === "mdxJsxTextElement") {
        const attributes = isRecord(node) && Array.isArray(node.attributes) ? node.attributes : [];
        const alt = attributes.find((attribute) => isRecord(attribute) && attribute.name === "alt");
        for (const attribute of attributes) {
          if (!isRecord(attribute) || !["src", "href"].includes(String(attribute.name))) continue;
          if (typeof attribute.value !== "string") continue;
          const span = startOffset(attribute as unknown as Node);
          const attributeSource = span ? source.slice(span.start, span.end) : "";
          const match = /^(?:src|href)\s*=\s*(["'])([\s\S]*)\1$/.exec(attributeSource);
          const exact = span && match && match[2] === attribute.value;
          const start = exact ? span.start + attributeSource.indexOf(match[1]!) + 1 : undefined;
          references.push({
            ...base,
            kind: "jsx",
            url: attribute.value,
            ...(isRecord(alt) && typeof alt.value === "string" ? { alt: alt.value } : {}),
            ...(start === undefined
              ? {}
              : {
                  urlStart: start,
                  urlEnd: start + attribute.value.length,
                  urlSyntax: match?.[1] === '"' ? ("double" as const) : ("single" as const),
                }),
          });
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

interface SourceDestination {
  readonly urlStart?: number;
  readonly urlEnd?: number;
  readonly urlSyntax?: Exclude<MarkdownReference["urlSyntax"], undefined>;
}

/** Locate a literal destination after the actual label, never in the title or label text. */
function markdownDestination(
  raw: string,
  offset: number,
  url: string,
  definition: boolean,
): SourceDestination {
  if (raw === url) return { urlStart: offset, urlEnd: offset + raw.length, urlSyntax: "markdown" };
  if (raw.startsWith("<") && raw.endsWith(">") && raw.slice(1, -1) === url) {
    return { urlStart: offset + 1, urlEnd: offset + raw.length - 1, urlSyntax: "angle" };
  }
  let index = raw.startsWith("![") ? 2 : raw.startsWith("[") ? 1 : -1;
  if (index < 0) return {}; // Unsupported syntax has no independently editable destination.
  let depth = 1;
  for (; index < raw.length; index++) {
    if (raw[index] === "\\") {
      index++;
      continue;
    }
    // Labels containing code spans need token-level resolution; leave them alone.
    if (raw[index] === "`") return {};
    if (raw[index] === "[") depth++;
    if (raw[index] === "]" && --depth === 0) break;
  }
  if (raw[index + 1] !== (definition ? ":" : "(")) return {};
  index += 2;
  while (/\s/.test(raw[index] ?? "") && index < raw.length) index++;
  const angle = raw[index] === "<";
  if (angle) index++;
  const start = index;
  let parentheses = 0;
  for (; index < raw.length; index++) {
    const character = raw[index];
    // Remark decodes escapes/entities; do not guess their source representation.
    if (character === "\\") return {};
    if (angle) {
      if (character === ">") break;
    } else {
      if (/\s/.test(character ?? "")) break;
      if (character === "(") parentheses++;
      if (character === ")") {
        if (parentheses === 0) break;
        parentheses--;
      }
    }
  }
  if (raw.slice(start, index) !== url) return {};
  return { urlStart: offset + start, urlEnd: offset + index, urlSyntax: angle ? "angle" : "markdown" };
}

function htmlAttributes(raw: string): {
  url: string;
  alt?: string;
  start: number;
  end: number;
  syntax: "double" | "single" | "unquoted";
}[] {
  const found: ReturnType<typeof htmlAttributes> = [];
  // Consume quoted values as part of the tag, so a 'src=' inside one is never another attribute.
  const tags = /<\/?[A-Za-z][\w:.-]*(?:[^>"']|"[^"]*"|'[^']*')*>/g;
  const literalElements = new Set([
    "script",
    "style",
    "pre",
    "code",
    "textarea",
    "xmp",
    "iframe",
    "noembed",
    "noframes",
    "plaintext",
  ]);
  let literal: string | undefined;
  for (const tag of raw.replace(/<!--[\s\S]*?-->/g, (comment) => " ".repeat(comment.length)).matchAll(tags)) {
    const name = /^<(\/?)([\w:.-]+)/.exec(tag[0]);
    const tagName = name?.[2]?.toLowerCase() ?? "";
    const closing = name?.[1] === "/";
    if (literal) {
      if (closing && tagName === literal) literal = undefined;
      continue;
    }
    if (closing) continue;
    if (literalElements.has(tagName)) literal = tagName;
    const attributes = /([^\s=<>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
    const values: { name: string; value: string; start: number; syntax: "double" | "single" | "unquoted" }[] =
      [];
    attributes.lastIndex = /^<[\w:.-]+/.exec(tag[0])?.[0].length ?? 0;
    let match;
    while ((match = attributes.exec(tag[0])) !== null) {
      const value = match[2] ?? match[3] ?? match[4];
      if (value === undefined) continue;
      const syntax = match[2] !== undefined ? "double" : match[3] !== undefined ? "single" : "unquoted";
      const equals = match[0].indexOf("=");
      let start = equals + 1;
      while (/\s/.test(match[0][start] ?? "") && start < match[0].length) start++;
      if (syntax !== "unquoted") start++;
      values.push({
        name: (match[1] ?? "").toLowerCase(),
        value,
        start: tag.index + match.index + start,
        syntax,
      });
    }
    const alt = values.find((attribute) => attribute.name === "alt")?.value;
    for (const attribute of values) {
      if (attribute.name !== "src" && attribute.name !== "href") continue;
      found.push({
        url: attribute.value,
        start: attribute.start,
        end: attribute.start + attribute.value.length,
        syntax: attribute.syntax,
        ...(alt === undefined ? {} : { alt }),
      });
    }
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
    throw new Error(`Invalid YAML frontmatter: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    });
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

/** Replace the URL inside a node, preserving alt text and the rest of the node. */
export function urlEdit(
  source: string,
  reference: MarkdownReference,
  replacement: string,
): TextEdit | undefined {
  if (reference.url === replacement) return undefined;
  const { urlStart: start, urlEnd: end, urlSyntax } = reference;
  if (start === undefined || end === undefined || urlSyntax === undefined) return undefined;
  if (
    source.slice(reference.nodeStart, reference.nodeEnd) !== reference.raw ||
    source.slice(start, end) !== reference.url
  )
    return undefined;
  // Encode syntax delimiters rather than introducing malformed Markdown or attributes.
  const unsafe =
    urlSyntax === "markdown"
      ? /[\s()<>\\]/g
      : urlSyntax === "angle"
        ? /[\s<>\\]/g
        : urlSyntax === "double"
          ? /["<>]/g
          : urlSyntax === "single"
            ? /['<>]/g
            : /[\s"'`=<>]/g;
  const encoded = replacement.replace(unsafe, (character) => {
    const encoded = encodeURIComponent(character);
    return encoded === character ? `%${character.charCodeAt(0).toString(16).toUpperCase()}` : encoded;
  });
  return { start, end, replacement: encoded, reason: `rewrite ${reference.url} → ${replacement}` };
}

const TRACKING_PARAMETERS = new Set([
  "fbclid",
  "gclid",
  "dclid",
  "msclkid",
  "mc_cid",
  "mc_eid",
  "igshid",
  "vero_id",
  "oly_anon_id",
  "oly_enc_id",
  "wickedid",
  "_hsenc",
  "_hsmi",
  "mkt_tok",
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
  const removed: string[] = [];
  const kept = query.split("&").filter((part) => {
    const name = new URLSearchParams(part).keys().next().value as string | undefined;
    if (name === undefined || !isTrackingParameter(name)) return true;
    removed.push(name);
    return false;
  });
  if (removed.length === 0) return { url, removed: [] };
  const search = kept.join("&");
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

export interface SourceRange {
  readonly start: number;
  readonly end: number;
}

/** Protect literal code and metadata even before invalid MDX HTML comments are removed. */
export function protectedMarkdownRanges(source: string, path: string): readonly SourceRange[] {
  const ranges: SourceRange[] = [];
  const collect = (tree: Node, types: ReadonlySet<string>) =>
    visit(tree, (node) => {
      if (!types.has(node.type)) return;
      const span = startOffset(node);
      if (span) ranges.push({ start: span.start, end: span.end });
    });
  const markdown = unified().use(remarkParse).use(remarkGfm).use(remarkFrontmatter).parse(source);
  collect(markdown, new Set(["code", "inlineCode", "yaml"]));
  visit(markdown, (node) => {
    if (node.type !== "html" || !isRecord(node) || typeof node.value !== "string") return;
    if (!/^\s*<(?:pre|script|style|textarea)(?:\s|>)/i.test(node.value)) return;
    const span = startOffset(node);
    if (span) ranges.push({ start: span.start, end: span.end });
  });
  if (/\.mdx$/i.test(path)) {
    // HTML comments are invalid MDX, but must not prevent protecting nearby expressions.
    const masked = source.replace(/<!--[\s\S]*?-->/g, (comment) => comment.replace(/[^\r\n]/g, " "));
    try {
      const mdx = unified()
        .use(remarkParse)
        .use(remarkGfm)
        .use(remarkFrontmatter)
        .use(remarkMdx)
        .parse(masked);
      collect(mdx, new Set(["mdxFlowExpression", "mdxTextExpression", "mdxjsEsm"]));
      visit(mdx, (node) => {
        if (!isRecord(node)) return;
        if (["pre", "script", "style", "textarea"].includes(String(node.name))) {
          const span = startOffset(node);
          if (span) ranges.push({ start: span.start, end: span.end });
        }
        if (!Array.isArray(node.attributes)) return;
        for (const attribute of node.attributes) {
          if (!isRecord(attribute)) continue;
          const span = startOffset(attribute as unknown as Node);
          if (span) ranges.push({ start: span.start, end: span.end });
        }
      });
    } catch {
      // Unknown syntax is never permission to rewrite potentially executable content.
      return [{ start: 0, end: source.length }];
    }
  }
  const merged: SourceRange[] = [];
  for (const range of ranges.sort((left, right) => left.start - right.start)) {
    const previous = merged.at(-1);
    if (previous && range.start <= previous.end) {
      merged[merged.length - 1] = { start: previous.start, end: Math.max(previous.end, range.end) };
    } else merged.push(range);
  }
  return merged;
}

/** Collapse blank lines outside literal code/frontmatter, retaining their exact bytes. */
export function normalizeBlankLines(source: string, path = "post.md"): NormalizeResult {
  const lines = splitLines(source);
  const ranges = protectedMarkdownRanges(source, path);
  const output: { text: string; ending: string; protected: boolean }[] = [];
  let previousBlank = false;
  let collapsed = 0;
  let offset = 0;
  for (const line of lines) {
    const end = offset + line.text.length + line.ending.length;
    const protectedLine = ranges.some((range) => range.start < end && range.end > offset);
    offset = end;
    if (protectedLine) {
      output.push({ ...line, protected: true });
      previousBlank = false;
      continue;
    }
    const blank = line.text.trim() === "";
    if (blank && previousBlank) {
      collapsed++;
      continue;
    }
    previousBlank = blank;
    output.push({ ...line, protected: false });
  }
  while (output.length > 0 && !output.at(-1)?.protected && output.at(-1)?.text.trim() === "") output.pop();
  let text = output.map((line) => line.text + line.ending).join("");
  if (!/[\r\n]$/.test(text)) text += dominantEnding(lines);
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
