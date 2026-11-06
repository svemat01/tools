/** Local project discovery. Nearest ancestor wins; marker order breaks ties. */
import { lstat, readFile } from "node:fs/promises";
import { dirname, join, parse, resolve, sep } from "node:path";

import { z } from "zod";

import { loadBlogConfig, type LoadedBlogConfig } from "./blog.ts";

export const ProjectConfigSchema = z.object({ schemaVersion: z.literal(1) }).strict();
export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;
export const PROJECT_MARKERS = [
  "sv.config.json",
  "sv.blog.json",
  ".sv/blog.json",
  "blog.config.json",
  ".git",
  "package.json",
] as const;
export type ProjectMarker = (typeof PROJECT_MARKERS)[number];
export interface DiscoveredProject {
  root: string;
  marker: ProjectMarker;
}

/** Refuse symbolic links in any component, including explicit input paths. */
export async function assertNoSymlinks(path: string): Promise<void> {
  const absolute = resolve(path);
  let current = parse(absolute).root;
  for (const part of absolute.slice(current.length).split(sep).filter(Boolean)) {
    current = join(current, part);
    if ((await lstat(current)).isSymbolicLink())
      throw new Error(`Symbolic links are not inspected: ${current}`);
  }
}

async function present(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

export async function discoverProject(cwd: string): Promise<DiscoveredProject | undefined> {
  await assertNoSymlinks(cwd);
  let directory = resolve(cwd);
  if (!(await lstat(directory)).isDirectory()) directory = dirname(directory);
  for (;;) {
    for (const marker of PROJECT_MARKERS) {
      if (await present(join(directory, marker))) return { root: directory, marker };
    }
    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

export interface LoadedProjectConfig {
  root: string;
  config: ProjectConfig | null;
  source: string | null;
  blog: LoadedBlogConfig | null;
}

/** Validate selected sv and blog configs; never include config contents in errors. */
export async function loadProjectConfig(root: string): Promise<LoadedProjectConfig> {
  const directory = resolve(root);
  await assertNoSymlinks(directory);
  const source = join(directory, "sv.config.json");
  let config: ProjectConfig | null = null;
  if (await present(source)) {
    await assertNoSymlinks(source);
    try {
      config = ProjectConfigSchema.parse(JSON.parse(await readFile(source, "utf8")));
    } catch {
      throw new Error(`Invalid project config ${source}; expected {"schemaVersion":1} with no extra fields.`);
    }
  }
  let blog: LoadedBlogConfig | null = null;
  for (const marker of PROJECT_MARKERS.slice(1, 4)) {
    const path = join(directory, marker);
    if (!(await present(path))) continue;
    await assertNoSymlinks(path);
    try {
      blog = await loadBlogConfig(directory, path);
    } catch {
      throw new Error(`Invalid blog config ${path}; check JSON syntax and the blog configuration schema.`);
    }
    break;
  }
  return { root: directory, config, source: config ? source : null, blog };
}
