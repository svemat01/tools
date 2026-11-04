/**
 * Configurable blog-post validation and preparation.
 *
 * Nothing here assumes a particular blog. A project describes its layout in a
 * `sv.blog.json` (or passes `--config`). The ENS layout is one example config
 * in `examples/ens-blog/sv.blog.json`, not a built-in assumption.
 */

import { existsSync } from "node:fs";
import { readdir, rm, stat } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { z } from "zod";

import {
  discoverFiles,
  displayPath,
  encodeTextFile,
  fileSize,
  planOutputPath,
  readFileBytes,
  readTextFile,
  type TextFile,
  writeFileAtomic,
} from "./fs.ts";
import { extensionForFormat, type ImageFormat, normalizeFormat, transformImage } from "./image.ts";
import {
  applyEdits,
  extractFrontmatter,
  isExternalUrl,
  type MarkdownReference,
  normalizeBlankLines,
  parseMarkdown,
  splitUrlSuffix,
  stripTrackingParameters,
  type TextEdit,
  toUrlPath,
  urlEdit,
} from "./markdown.ts";
import { fixText, scanText } from "./unicode.ts";

export interface BlogChecks {
  readonly metadata: boolean;
  readonly media: boolean;
  readonly links: boolean;
  readonly altText: boolean;
  readonly unicode: boolean;
  readonly slugs: boolean;
  readonly markdown: boolean;
  readonly oversizedAssets: boolean;
}

export interface BlogPrepare {
  readonly notion: boolean;
  readonly normalizeMarkdown: boolean;
  readonly stripTracking: boolean;
  readonly fixUnicode: boolean;
  readonly typography: boolean;
  readonly optimizeImages: boolean;
  readonly imageFormat: "webp" | "keep";
  readonly imageWidth: number;
  readonly imageQuality: number;
  readonly deleteOriginals: boolean;
}

export interface BlogConfig {
  readonly name?: string;
  readonly postsDir: string;
  readonly entries: readonly string[];
  readonly metadataFiles: readonly string[];
  readonly requiredMetadata: readonly string[];
  readonly slugField: string;
  readonly slugPattern: string;
  readonly publicDir?: string;
  readonly coverFields: readonly string[];
  readonly mediaExtensions: readonly string[];
  readonly maxAssetBytes: number;
  readonly ignore: readonly string[];
  readonly checks: BlogChecks;
  readonly prepare: BlogPrepare;
}

const DEFAULT_CHECKS: BlogChecks = {
  metadata: true,
  media: true,
  links: true,
  altText: true,
  unicode: true,
  slugs: true,
  markdown: true,
  oversizedAssets: true,
};

const DEFAULT_PREPARE: BlogPrepare = {
  notion: true,
  normalizeMarkdown: true,
  stripTracking: true,
  fixUnicode: true,
  typography: false,
  optimizeImages: true,
  imageFormat: "webp",
  imageWidth: 1920,
  imageQuality: 82,
  deleteOriginals: false,
};

export const DEFAULT_BLOG_CONFIG: BlogConfig = {
  postsDir: "posts",
  entries: ["readme.mdx", "README.mdx", "index.mdx", "index.md", "readme.md"],
  metadataFiles: ["meta.json"],
  requiredMetadata: ["title"],
  slugField: "slug",
  slugPattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$",
  coverFields: [],
  mediaExtensions: [
    "png",
    "jpg",
    "jpeg",
    "webp",
    "avif",
    "gif",
    "svg",
    "mp4",
    "mov",
    "webm",
    "mp3",
    "wav",
    "ogg",
  ],
  maxAssetBytes: 5 * 1024 * 1024,
  ignore: [],
  checks: DEFAULT_CHECKS,
  prepare: DEFAULT_PREPARE,
};

const ConfigFileSchema = z
  .object({
    name: z.string().optional(),
    postsDir: z.string().min(1).optional(),
    entries: z.array(z.string().min(1)).min(1).optional(),
    metadataFiles: z.array(z.string().min(1)).optional(),
    requiredMetadata: z.array(z.string().min(1)).optional(),
    slugField: z.string().min(1).optional(),
    slugPattern: z.string().min(1).optional(),
    publicDir: z.string().optional(),
    coverFields: z.array(z.string().min(1)).optional(),
    mediaExtensions: z.array(z.string().min(1)).optional(),
    maxAssetBytes: z.number().int().positive().optional(),
    ignore: z.array(z.string()).optional(),
    checks: z
      .object({
        metadata: z.boolean().optional(),
        media: z.boolean().optional(),
        links: z.boolean().optional(),
        altText: z.boolean().optional(),
        unicode: z.boolean().optional(),
        slugs: z.boolean().optional(),
        markdown: z.boolean().optional(),
        oversizedAssets: z.boolean().optional(),
      })
      .optional(),
    prepare: z
      .object({
        notion: z.boolean().optional(),
        normalizeMarkdown: z.boolean().optional(),
        stripTracking: z.boolean().optional(),
        fixUnicode: z.boolean().optional(),
        typography: z.boolean().optional(),
        optimizeImages: z.boolean().optional(),
        imageFormat: z.enum(["webp", "keep"]).optional(),
        imageWidth: z.number().int().positive().optional(),
        imageQuality: z.number().int().min(1).max(100).optional(),
        deleteOriginals: z.boolean().optional(),
      })
      .optional(),
  })
  .strict();

export type BlogConfigFile = z.infer<typeof ConfigFileSchema>;

export function resolveBlogConfig(file: BlogConfigFile = {}): BlogConfig {
  return {
    ...DEFAULT_BLOG_CONFIG,
    ...(file.name === undefined ? {} : { name: file.name }),
    ...(file.postsDir === undefined ? {} : { postsDir: file.postsDir }),
    ...(file.entries === undefined ? {} : { entries: file.entries }),
    ...(file.metadataFiles === undefined ? {} : { metadataFiles: file.metadataFiles }),
    ...(file.requiredMetadata === undefined ? {} : { requiredMetadata: file.requiredMetadata }),
    ...(file.slugField === undefined ? {} : { slugField: file.slugField }),
    ...(file.slugPattern === undefined ? {} : { slugPattern: file.slugPattern }),
    ...(file.publicDir === undefined ? {} : { publicDir: file.publicDir }),
    ...(file.coverFields === undefined ? {} : { coverFields: file.coverFields }),
    ...(file.mediaExtensions === undefined ? {} : { mediaExtensions: file.mediaExtensions }),
    ...(file.maxAssetBytes === undefined ? {} : { maxAssetBytes: file.maxAssetBytes }),
    ...(file.ignore === undefined ? {} : { ignore: file.ignore }),
    checks: { ...DEFAULT_CHECKS, ...definedOnly(file.checks ?? {}) } as BlogChecks,
    prepare: { ...DEFAULT_PREPARE, ...definedOnly(file.prepare ?? {}) } as BlogPrepare,
  };
}

/** Keep optional config fields from overriding a default with `undefined`. */
function definedOnly<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as Partial<T>;
}

export interface LoadedBlogConfig {
  readonly config: BlogConfig;
  readonly source?: string;
}

export async function loadBlogConfig(startDirectory: string, explicit?: string): Promise<LoadedBlogConfig> {
  const candidates = explicit
    ? [resolve(startDirectory, explicit)]
    : [
        join(startDirectory, "sv.blog.json"),
        join(startDirectory, ".sv", "blog.json"),
        join(startDirectory, "blog.config.json"),
      ];

  for (const path of candidates) {
    if (!existsSync(path)) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(await Bun.file(path).text());
    } catch (error) {
      throw new Error(
        `Cannot parse blog config ${path}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    const result = ConfigFileSchema.safeParse(parsed);
    if (!result.success) {
      const detail = result.error.issues
        .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
        .join("\n");
      throw new Error(`Invalid blog config ${path}:\n${detail}`);
    }
    return { config: resolveBlogConfig(result.data), source: path };
  }

  if (explicit) throw new Error(`Blog config not found: ${candidates[0]}`);
  return { config: DEFAULT_BLOG_CONFIG };
}

export interface BlogPost {
  readonly root: string;
  readonly entry: string;
  readonly projectRoot: string;
  readonly name: string;
}

export interface BlogProject {
  readonly kind: "post" | "project";
  readonly projectRoot: string;
  readonly posts: readonly BlogPost[];
}

function inferProjectRoot(postRoot: string, config: BlogConfig): string {
  const parent = dirname(postRoot);
  const postsDir = config.postsDir.replace(/[\\/]+$/, "");
  const nativePostsDir = isAbsolute(postsDir)
    ? resolve(postsDir)
    : postsDir.split(/[\\/]/).filter(Boolean).join(sep);
  if (!nativePostsDir) return postRoot;
  if (parent === nativePostsDir || parent.endsWith(`${sep}${nativePostsDir}`)) {
    if (isAbsolute(postsDir)) return dirname(nativePostsDir);
    return parent.slice(0, parent.length - nativePostsDir.length).replace(/[\\/]+$/, "") || sep;
  }
  return postRoot;
}

function findEntry(directory: string, config: BlogConfig): string | undefined {
  for (const candidate of config.entries) {
    const path = join(directory, candidate);
    if (existsSync(path)) return path;
  }
  return undefined;
}

function findMetadata(directory: string, config: BlogConfig): string | undefined {
  for (const candidate of config.metadataFiles) {
    const path = join(directory, candidate);
    if (existsSync(path)) return path;
  }
  return undefined;
}

export async function resolveBlogProject(
  target: string,
  cwd: string,
  config: BlogConfig,
): Promise<BlogProject> {
  const path = resolve(cwd, target);
  let info;
  try {
    info = await stat(path);
  } catch {
    throw new Error(`Path not found: ${target}`);
  }

  if (info.isFile()) {
    const root = dirname(path);
    const projectRoot = inferProjectRoot(root, config);
    return {
      kind: "post",
      projectRoot,
      posts: [{ root, entry: path, projectRoot, name: basename(root) }],
    };
  }

  const entry = findEntry(path, config);
  if (entry) {
    const projectRoot = inferProjectRoot(path, config);
    return {
      kind: "post",
      projectRoot,
      posts: [{ root: path, entry, projectRoot, name: basename(path) }],
    };
  }

  const postsDirectory = basename(path) === config.postsDir ? path : join(path, config.postsDir);
  if (!existsSync(postsDirectory)) {
    throw new Error(
      `No post entry (${config.entries.join(", ")}) or ${config.postsDir}/ directory found under ${target}`,
    );
  }

  const posts: BlogPost[] = [];
  const entries = await readdir(postsDirectory, { withFileTypes: true });
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;
    if (config.ignore.includes(entry.name)) continue;
    const root = join(postsDirectory, entry.name);
    const postEntry = findEntry(root, config);
    if (!postEntry) continue;
    posts.push({
      root,
      entry: postEntry,
      projectRoot: path,
      name: entry.name,
    });
  }

  return { kind: "project", projectRoot: path, posts };
}

export interface BlogIssue {
  readonly severity: "error" | "warn" | "info";
  readonly code: string;
  readonly message: string;
  readonly file: string;
  readonly line?: number;
  readonly column?: number;
}

interface NotionArtifact {
  readonly start: number;
  readonly end: number;
  readonly text: string;
  readonly line: number;
}

/**
 * Find Notion export artifacts before parsing. MDX treats HTML comments as
 * syntax errors, so removing them first lets the rest of the post be checked
 * (and is exactly what `prepare` does when it rewrites the file).
 */
function findNotionArtifacts(source: string): NotionArtifact[] {
  const artifacts: NotionArtifact[] = [];
  const patterns = [
    /<!--\s*notionvc:[\s\S]*?-->/gi,
    /<empty-block\s*\/>/gi,
    /<empty-block>\s*<\/empty-block>/gi,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      if (match.index === undefined) continue;
      artifacts.push({
        start: match.index,
        end: match.index + match[0].length,
        text: match[0],
        line: lineAt(source, match.index),
      });
    }
  }
  return artifacts.sort((a, b) => a.start - b.start);
}

function lineAt(source: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset; index++) {
    if (source[index] === "\n") line++;
  }
  return line;
}

function artifactEdits(artifacts: readonly NotionArtifact[]): TextEdit[] {
  return artifacts.map((artifact) => ({
    start: artifact.start,
    end: artifact.end,
    replacement: "",
    reason: "remove Notion export artifact",
  }));
}

export interface PostMetadata {
  readonly data: Readonly<Record<string, unknown>>;
  readonly sources: readonly string[];
  readonly errors: readonly string[];
}

export async function loadPostMetadata(post: BlogPost, config: BlogConfig): Promise<PostMetadata> {
  const errors: string[] = [];
  const sources: string[] = [];
  let data: Record<string, unknown> = {};

  try {
    const file = await readTextFile(post.entry);
    const frontmatter = extractFrontmatter(file.text);
    if (frontmatter.raw) {
      data = { ...frontmatter.data };
      sources.push("frontmatter");
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }

  const metadataPath = findMetadata(post.root, config);
  if (metadataPath) {
    try {
      const parsed: unknown = JSON.parse(await Bun.file(metadataPath).text());
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        errors.push(`${metadataPath} must contain a JSON object`);
      } else {
        data = { ...data, ...(parsed as Record<string, unknown>) };
        sources.push(metadataPath);
      }
    } catch (error) {
      errors.push(`${metadataPath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return { data, sources, errors };
}

export interface CheckOptions {
  readonly cwd: string;
  readonly strict?: boolean;
}

export interface CheckSummary {
  readonly project: BlogProject;
  readonly issues: readonly BlogIssue[];
  readonly posts: number;
  readonly errors: number;
  readonly warnings: number;
  readonly infos: number;
  readonly ok: boolean;
}

export async function checkBlog(
  project: BlogProject,
  config: BlogConfig,
  options: CheckOptions,
): Promise<CheckSummary> {
  const issues: BlogIssue[] = [];
  const slugs = new Map<string, BlogPost[]>();

  for (const post of project.posts) {
    const postIssues = await checkPost(post, project, config, options);
    issues.push(...postIssues);

    if (config.checks.slugs) {
      const metadata = await loadPostMetadata(post, config);
      const slug = metadata.data[config.slugField];
      if (typeof slug === "string" && slug.trim()) {
        const list = slugs.get(slug) ?? [];
        list.push(post);
        slugs.set(slug, list);
      }
    }
  }

  if (config.checks.slugs && project.kind === "project") {
    for (const [slug, posts] of slugs) {
      if (posts.length < 2) continue;
      for (const post of posts) {
        issues.push({
          severity: "error",
          code: "duplicate-slug",
          message: `Duplicate ${config.slugField} ${JSON.stringify(slug)} (also used by ${posts
            .filter((candidate) => candidate !== post)
            .map((candidate) => candidate.name)
            .join(", ")})`,
          file: post.entry,
          line: 1,
          column: 1,
        });
      }
    }
  }

  const errors = issues.filter((issue) => issue.severity === "error").length;
  const warnings = issues.filter((issue) => issue.severity === "warn").length;
  const infos = issues.filter((issue) => issue.severity === "info").length;
  return {
    project,
    issues,
    posts: project.posts.length,
    errors,
    warnings,
    infos,
    ok: errors === 0 && (!options.strict || warnings === 0),
  };
}

async function checkPost(
  post: BlogPost,
  project: BlogProject,
  config: BlogConfig,
  options: CheckOptions,
): Promise<BlogIssue[]> {
  const issues: BlogIssue[] = [];
  let file: TextFile;
  try {
    file = await readTextFile(post.entry);
  } catch (error) {
    return [
      {
        severity: "error",
        code: "unreadable-entry",
        message: error instanceof Error ? error.message : String(error),
        file: post.entry,
      },
    ];
  }

  const metadata = await loadPostMetadata(post, config);
  for (const error of metadata.errors) {
    issues.push({
      severity: "error",
      code: "metadata",
      message: error,
      file: post.entry,
      line: 1,
      column: 1,
    });
  }

  if (config.checks.metadata) {
    for (const field of config.requiredMetadata) {
      const value = metadata.data[field];
      if (value === undefined || value === null || value === "") {
        issues.push({
          severity: "error",
          code: "missing-metadata",
          message: `Missing required metadata field ${JSON.stringify(field)}`,
          file: post.entry,
          line: 1,
          column: 1,
        });
      }
    }
  }

  if (config.checks.slugs) {
    const slug = metadata.data[config.slugField];
    if (slug !== undefined) {
      if (typeof slug !== "string" || !slug.trim()) {
        issues.push({
          severity: "error",
          code: "invalid-slug",
          message: `${config.slugField} must be a non-empty string`,
          file: post.entry,
          line: 1,
          column: 1,
        });
      } else if (!new RegExp(config.slugPattern).test(slug)) {
        issues.push({
          severity: "error",
          code: "invalid-slug",
          message: `${config.slugField} ${JSON.stringify(slug)} does not match ${config.slugPattern}`,
          file: post.entry,
          line: 1,
          column: 1,
        });
      }
    }
  }

  const artifacts = findNotionArtifacts(file.text);
  if (config.checks.markdown) {
    for (const artifact of artifacts) {
      issues.push({
        severity: "info",
        code: "notion-artifact",
        message: `Notion export artifact found: ${artifact.text.slice(0, 60)}`,
        file: post.entry,
        line: artifact.line,
        column: 1,
      });
    }
  }

  const source = artifacts.length > 0 ? applyEdits(file.text, artifactEdits(artifacts)) : file.text;
  const parsed = parseMarkdown(source, post.entry);
  if (parsed.parseError) {
    issues.push({
      severity: "error",
      code: "markdown-parse",
      message: parsed.parseError,
      file: post.entry,
      line: 1,
      column: 1,
    });
    return issues;
  }

  if (config.checks.markdown) {
    for (const reference of parsed.references) {
      if (reference.url.trim() === "") {
        issues.push({
          severity: "warn",
          code: "empty-link",
          message: "Empty link or media URL",
          file: post.entry,
          line: reference.line,
          column: reference.column,
        });
      }
      if (reference.url.includes("notionvc") || reference.url.includes("notion.so")) {
        issues.push({
          severity: "info",
          code: "notion-artifact",
          message: "Notion export URL or marker found",
          file: post.entry,
          line: reference.line,
          column: reference.column,
        });
      }
      if (config.prepare.stripTracking) {
        const tracking = stripTrackingParameters(reference.url);
        if (tracking.removed.length > 0) {
          issues.push({
            severity: "info",
            code: "tracking-parameters",
            message: `Tracking parameters: ${tracking.removed.join(", ")}`,
            file: post.entry,
            line: reference.line,
            column: reference.column,
          });
        }
      }
    }
  }

  if (config.checks.unicode) {
    const scan = scanText(file.text);
    for (const finding of scan.findings) {
      issues.push({
        severity: finding.rule.severity,
        code: "unicode",
        message: `${finding.rule.description} (${finding.codePoint.toString(16).toUpperCase().padStart(4, "0")})`,
        file: post.entry,
        line: finding.line,
        column: finding.column,
      });
    }
  }

  const seen = new Set<string>();
  for (const reference of parsed.references) {
    if (isExternalUrl(reference.url)) continue;
    const { path: urlPath } = splitUrlSuffix(reference.url);
    if (!urlPath || urlPath.startsWith("#")) continue;

    let decoded: string;
    try {
      decoded = decodeURIComponent(urlPath);
    } catch {
      decoded = urlPath;
    }

    const absolute = localReferencePath(post, project, config, decoded);
    if (!absolute) continue;

    const key = `${reference.kind}:${absolute}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const isImageReference =
      reference.kind === "image" ||
      (reference.kind === "jsx" && /\.(?:png|jpe?g|webp|avif|gif|svg)$/i.test(urlPath)) ||
      (reference.kind === "html" && /\.(?:png|jpe?g|webp|avif|gif|svg)$/i.test(urlPath));
    if (
      isImageReference &&
      config.checks.altText &&
      (reference.alt === undefined || reference.alt.trim() === "")
    ) {
      issues.push({
        severity: "warn",
        code: "missing-alt-text",
        message: `Image is missing alt text: ${reference.url}`,
        file: post.entry,
        line: reference.line,
        column: reference.column,
      });
    }

    if (!existsSync(absolute)) {
      if (reference.kind === "link" && config.checks.links) {
        issues.push({
          severity: "error",
          code: "broken-link",
          message: `Local link target not found: ${reference.url}`,
          file: post.entry,
          line: reference.line,
          column: reference.column,
        });
      } else if (config.checks.media) {
        issues.push({
          severity: "error",
          code: "missing-media",
          message: `Local media not found: ${reference.url}`,
          file: post.entry,
          line: reference.line,
          column: reference.column,
        });
      }
      continue;
    }

    const extension = absolute.split(".").pop()?.toLowerCase() ?? "";
    const isMedia = config.mediaExtensions.includes(extension);
    if (isMedia && config.checks.media) {
      const size = await fileSize(absolute);
      if (config.checks.oversizedAssets && size > config.maxAssetBytes) {
        issues.push({
          severity: "warn",
          code: "oversized-asset",
          message: `Asset is ${size} bytes (limit ${config.maxAssetBytes}): ${reference.url}`,
          file: post.entry,
          line: reference.line,
          column: reference.column,
        });
      }
    }
  }

  if (config.checks.oversizedAssets) {
    for (const field of config.coverFields) {
      const value = metadata.data[field];
      if (typeof value !== "string" || !value || isExternalUrl(value)) continue;
      const { path: urlPath } = splitUrlSuffix(value);
      const absolute = localReferencePath(post, project, config, decodeURIComponentSafe(urlPath));
      if (!absolute || !existsSync(absolute)) {
        issues.push({
          severity: "error",
          code: "missing-media",
          message: `Cover image ${field} not found: ${value}`,
          file: post.entry,
          line: 1,
          column: 1,
        });
        continue;
      }
      const size = await fileSize(absolute);
      if (size > config.maxAssetBytes) {
        issues.push({
          severity: "warn",
          code: "oversized-asset",
          message: `Cover image ${field} is ${size} bytes (limit ${config.maxAssetBytes})`,
          file: post.entry,
          line: 1,
          column: 1,
        });
      }
    }
  }

  void options;
  return issues;
}

function decodeURIComponentSafe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function localReferencePath(
  post: BlogPost,
  project: BlogProject,
  config: BlogConfig,
  urlPath: string,
): string | undefined {
  if (!urlPath) return undefined;
  if (urlPath.startsWith("/")) {
    return config.publicDir
      ? join(project.projectRoot, config.publicDir, urlPath.slice(1))
      : join(project.projectRoot, urlPath.slice(1));
  }
  return join(post.root, urlPath);
}

export interface PlannedImage {
  readonly input: string;
  readonly output: string;
  readonly action: "convert" | "optimize";
  readonly before: number;
  readonly after: number;
  readonly width: number;
  readonly height: number;
  readonly format: ImageFormat;
  readonly reference: string;
  readonly nextUrl: string;
  readonly data: Uint8Array;
}

export interface PlannedEdit {
  readonly reason: string;
  readonly line?: number;
  readonly before?: string;
  readonly after?: string;
}

export interface PreparePlan {
  readonly post: BlogPost;
  readonly entry: string;
  readonly original: string;
  readonly prepared: string;
  readonly edits: readonly PlannedEdit[];
  readonly images: readonly PlannedImage[];
  readonly unicodeReplacements: number;
  readonly collapsedBlankLines: number;
  readonly changed: boolean;
}

export interface PrepareOptions {
  readonly cwd: string;
  readonly dryRun?: boolean;
  readonly noImages?: boolean;
  readonly noUnicode?: boolean;
}

export async function planBlogPrepare(
  post: BlogPost,
  config: BlogConfig,
  options: PrepareOptions,
): Promise<PreparePlan> {
  const file = await readTextFile(post.entry);
  const edits: PlannedEdit[] = [];
  const textEdits: TextEdit[] = [];
  const artifactList = config.prepare.notion ? findNotionArtifacts(file.text) : [];
  const artifacts = artifactEdits(artifactList);
  const source = artifacts.length > 0 ? applyEdits(file.text, artifacts) : file.text;

  for (const artifact of artifactList) {
    edits.push({
      reason: "remove Notion export artifact",
      line: artifact.line,
      before: artifact.text.slice(0, 120),
    });
  }

  const parsed = parseMarkdown(source, post.entry);
  if (parsed.parseError) throw new Error(`Cannot prepare ${post.entry}: ${parsed.parseError}`);

  const images: PlannedImage[] = [];
  const imageByInput = new Map<string, PlannedImage>();
  const imageForReference = new Map<MarkdownReference, PlannedImage>();
  const usedOutputs = new Set<string>();

  if (config.prepare.optimizeImages && !options.noImages) {
    for (const reference of parsed.references) {
      if (isExternalUrl(reference.url)) continue;
      const { path: urlPath } = splitUrlSuffix(reference.url);
      if (!urlPath) continue;
      const absolute = localReferencePath(
        post,
        { kind: "post", projectRoot: post.projectRoot, posts: [post] },
        config,
        decodeURIComponentSafe(urlPath),
      );
      if (!absolute || !existsSync(absolute)) continue;
      const extension = absolute.split(".").pop()?.toLowerCase() ?? "";
      if (!["png", "jpg", "jpeg", "webp", "avif", "gif", "svg"].includes(extension)) continue;

      let image = imageByInput.get(absolute);
      if (!image) {
        image = await planImage(absolute, post, config, usedOutputs);
        if (!image) continue;
        imageByInput.set(absolute, image);
        images.push(image);
      }
      imageForReference.set(reference, image);
    }
  }

  // One edit per reference: image rewriting and tracking-parameter removal
  // must compose, not overlap.
  for (const reference of parsed.references) {
    let nextUrl = reference.url;
    const image = imageForReference.get(reference);
    if (image) {
      const { suffix } = splitUrlSuffix(reference.url);
      nextUrl = `${imageUrlForReference(reference.url, image, post, config)}${suffix}`;
    }
    let removed: readonly string[] = [];
    if (config.prepare.stripTracking) {
      const stripped = stripTrackingParameters(nextUrl);
      nextUrl = stripped.url;
      removed = stripped.removed;
    }
    if (nextUrl === reference.url) continue;
    const edit = urlEdit(source, reference, nextUrl);
    if (!edit) continue;
    textEdits.push(edit);
    const reasons: string[] = [];
    if (image) {
      reasons.push(
        `optimize image ${displayPath(options.cwd, image.input)} → ${displayPath(options.cwd, image.output)}`,
      );
    }
    if (removed.length > 0) reasons.push(`remove tracking parameters (${removed.join(", ")})`);
    edits.push({
      reason: reasons.join("; "),
      line: reference.line,
      before: reference.url,
      after: nextUrl,
    });
  }

  let text = textEdits.length > 0 ? applyEdits(source, textEdits) : source;
  let unicodeReplacements = 0;
  if (config.prepare.fixUnicode && !options.noUnicode) {
    const fixed = fixText(text, { typography: config.prepare.typography });
    text = fixed.text;
    unicodeReplacements = fixed.replacements;
    if (unicodeReplacements > 0) {
      edits.push({ reason: `replace ${unicodeReplacements} invisible or typographic character(s)` });
    }
  }

  let collapsedBlankLines = 0;
  if (config.prepare.normalizeMarkdown) {
    const normalized = normalizeBlankLines(text);
    text = normalized.text;
    collapsedBlankLines = normalized.collapsedBlankLines;
    if (normalized.changed) {
      edits.push({ reason: "normalize blank lines and trailing newline" });
    }
  }

  return {
    post,
    entry: post.entry,
    original: file.text,
    prepared: text,
    edits,
    images,
    unicodeReplacements,
    collapsedBlankLines,
    changed: text !== file.text || images.length > 0,
  };
}

function imageUrlForReference(
  referenceUrl: string,
  image: PlannedImage,
  post: BlogPost,
  config: BlogConfig,
): string {
  if (!referenceUrl.startsWith("/")) return image.nextUrl;
  const base = config.publicDir ? join(post.projectRoot, config.publicDir) : post.projectRoot;
  return `/${toUrlPath(relative(base, image.output))}`;
}

async function planImage(
  input: string,
  post: BlogPost,
  config: BlogConfig,
  usedOutputs: Set<string>,
): Promise<PlannedImage | undefined> {
  const inputExtension = input.split(".").pop()?.toLowerCase() ?? "";
  const requested = config.prepare.imageFormat === "webp" ? "webp" : normalizeFormat(inputExtension);
  if (!requested) return undefined;
  // Do not create a chain of `-optimized` copies on repeated prepares.
  const sameFormat =
    config.prepare.imageFormat === "webp" ? inputExtension === "webp" : requested === inputExtension;
  if (sameFormat && basename(input, extname(input)).endsWith("-optimized")) return undefined;

  const before = await fileSize(input);
  let output: string;
  if (config.prepare.imageFormat === "webp" && inputExtension !== "webp") {
    output = await planOutputPath({
      input,
      cwd: post.root,
      extension: "webp",
      overwrite: false,
    });
  } else if (config.prepare.imageFormat === "webp" && inputExtension === "webp") {
    // Already WebP: only re-encode when resizing would help.
    output = await planOutputPath({
      input,
      cwd: post.root,
      extension: "webp",
      suffix: "-optimized",
      overwrite: false,
    });
  } else {
    output = await planOutputPath({
      input,
      cwd: post.root,
      extension: extensionForFormat(requested),
      suffix: "-optimized",
      overwrite: false,
    });
  }
  output = reserve(output, usedOutputs);

  const result = await transformImage(input, {
    resize: { width: config.prepare.imageWidth, withoutEnlargement: true },
    encode: {
      format: requested,
      quality: config.prepare.imageQuality,
      ...(requested === "png" ? { palette: true } : {}),
    },
  });

  // A same-format optimization that makes the file larger is not useful.
  if (config.prepare.imageFormat === "keep" && result.bytes >= before) return undefined;
  if (config.prepare.imageFormat === "webp" && inputExtension === "webp" && result.bytes >= before) {
    return undefined;
  }

  const relativeUrl = toUrlPath(relative(post.root, output));
  return {
    input,
    output,
    action: config.prepare.imageFormat === "webp" && inputExtension !== "webp" ? "convert" : "optimize",
    before,
    after: result.bytes,
    width: result.width,
    height: result.height,
    format: result.format,
    reference: input,
    nextUrl: relativeUrl,
    data: result.data,
  };
}

function reserve(desired: string, used: Set<string>): string {
  if (!used.has(desired) && !existsSync(desired)) {
    used.add(desired);
    return desired;
  }
  const directory = dirname(desired);
  const extension = extname(desired);
  const stem = basename(desired, extension);
  for (let counter = 1; counter < 10_000; counter++) {
    const candidate = join(directory, `${stem}-${counter}${extension}`);
    if (!used.has(candidate) && !existsSync(candidate)) {
      used.add(candidate);
      return candidate;
    }
  }
  throw new Error(`Could not reserve an output name for ${desired}`);
}

export interface PrepareResult {
  readonly plan: PreparePlan;
  readonly writtenImages: readonly string[];
  readonly deletedOriginals: readonly string[];
}

export async function applyBlogPrepare(plan: PreparePlan, config: BlogConfig): Promise<PrepareResult> {
  const file = await readTextFile(plan.entry);
  if (file.text !== plan.original) {
    throw new Error(`${plan.entry} changed after planning; re-run blog prepare`);
  }

  const writtenImages: string[] = [];
  for (const image of plan.images) {
    if (existsSync(image.output)) {
      const existing = await readFileBytes(image.output);
      if (existing.equals(image.data)) {
        writtenImages.push(image.output);
        continue;
      }
      throw new Error(`${image.output} appeared after planning; re-run blog prepare`);
    }
    await writeFileAtomic(image.output, image.data);
    writtenImages.push(image.output);
  }

  if (plan.prepared !== file.text) {
    await writeFileAtomic(plan.entry, encodeTextFile(file, plan.prepared));
  }

  const deletedOriginals: string[] = [];
  if (config.prepare.deleteOriginals) {
    for (const image of plan.images) {
      if (image.output === image.input) continue;
      await rm(image.input, { force: true });
      deletedOriginals.push(image.input);
    }
  }

  return { plan, writtenImages, deletedOriginals };
}

/** Read referenced media for the check command without treating them as posts. */
export async function findProjectMedia(project: BlogProject, config: BlogConfig): Promise<string[]> {
  const paths: string[] = [];
  for (const post of project.posts) {
    const found = await discoverFiles([post.root], {
      cwd: post.root,
      extensions: config.mediaExtensions,
      respectGitIgnore: true,
    });
    paths.push(...found.files);
  }
  return [...new Set(paths)].sort();
}
