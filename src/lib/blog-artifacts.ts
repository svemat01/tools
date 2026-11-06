/** Notion export cleanup, excluding literal Markdown and MDX content. */
import { protectedMarkdownRanges, type TextEdit } from "./markdown.ts";

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
export function findNotionArtifacts(source: string, path: string): NotionArtifact[] {
  const protectedRanges = protectedMarkdownRanges(source, path);
  const artifacts: NotionArtifact[] = [];
  const patterns = [
    /<!--\s*notionvc:[\s\S]*?-->/gi,
    /<empty-block\s*\/>/gi,
    /<empty-block>\s*<\/empty-block>/gi,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      if (match.index === undefined) continue;
      const start = match.index;
      const end = start + match[0].length;
      if (protectedRanges.some((range) => start < range.end && end > range.start)) continue;
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

export function artifactEdits(artifacts: readonly NotionArtifact[]): TextEdit[] {
  return artifacts.map((artifact) => ({
    start: artifact.start,
    end: artifact.end,
    replacement: "",
    reason: "remove Notion export artifact",
  }));
}
