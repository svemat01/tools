/** Shared project-layout and local-reference resolution for blog workflows. */
import { dirname, isAbsolute, join, resolve, sep } from "node:path";

import type { BlogConfig, BlogPost, BlogProject } from "./blog.ts";

export function inferProjectRoot(postRoot: string, config: BlogConfig): string {
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

export function decodeURIComponentSafe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function localReferencePath(
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
