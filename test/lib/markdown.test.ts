import { describe, expect, test } from "bun:test";

import {
  applyEdits,
  extractFrontmatter,
  normalizeBlankLines,
  parseMarkdown,
  splitUrlSuffix,
  stripTrackingParameters,
  toUrlPath,
  urlEdit,
} from "../../src/lib/markdown.ts";

describe("parseMarkdown", () => {
  test("finds images, links, definitions and HTML references", () => {
    const source = [
      "# Title",
      "",
      "![alt text](./cover.png)",
      "",
      "[link](https://example.com/page)",
      "",
      "[ref]: ./other.md",
      "",
      '<img src="./inline.png" alt="inline">',
      "",
    ].join("\n");

    const parsed = parseMarkdown(source, "post.md");
    expect(parsed.parseError).toBeUndefined();
    expect(parsed.references.map((reference) => [reference.kind, reference.url])).toEqual([
      ["image", "./cover.png"],
      ["link", "https://example.com/page"],
      ["definition", "./other.md"],
      ["html", "./inline.png"],
    ]);
    expect(parsed.references[0]?.alt).toBe("alt text");
    expect(parsed.references[3]?.alt).toBe("inline");
  });

  test("finds MDX JSX src and alt attributes", () => {
    const source = '<Image src="./hero.png" alt="Hero" />\n';
    const parsed = parseMarkdown(source, "post.mdx");
    expect(parsed.parseError).toBeUndefined();
    expect(parsed.references).toHaveLength(1);
    expect(parsed.references[0]).toMatchObject({
      kind: "jsx",
      url: "./hero.png",
      alt: "Hero",
    });
  });

  test("reports a parse error instead of throwing", () => {
    const parsed = parseMarkdown("<!-- comment -->\n", "post.mdx");
    expect(parsed.references).toEqual([]);
    expect(parsed.parseError).toBeTruthy();
  });
});

describe("stripTrackingParameters", () => {
  test("removes known and utm parameters, preserving the rest", () => {
    const result = stripTrackingParameters("https://example.com/a?utm_source=x&id=7&fbclid=y#frag");
    expect(result.url).toBe("https://example.com/a?id=7#frag");
    expect([...result.removed].sort()).toEqual(["fbclid", "utm_source"]);
  });

  test("leaves URLs without tracking parameters untouched", () => {
    const result = stripTrackingParameters("https://example.com/a?id=7#frag");
    expect(result.url).toBe("https://example.com/a?id=7#frag");
    expect(result.removed).toEqual([]);
  });
});

describe("splitUrlSuffix and toUrlPath", () => {
  test("separates path from query and hash", () => {
    expect(splitUrlSuffix("./a.png?x=1#y")).toEqual({ path: "./a.png", suffix: "?x=1#y" });
    expect(splitUrlSuffix("./a.png")).toEqual({ path: "./a.png", suffix: "" });
  });

  test("normalizes backslashes", () => {
    expect(toUrlPath("posts\\hello\\a.png")).toBe("posts/hello/a.png");
  });
});

describe("applyEdits and urlEdit", () => {
  test("applies non-overlapping edits from the end", () => {
    const source = "one two three";
    const edited = applyEdits(source, [
      { start: 0, end: 3, replacement: "ONE", reason: "upper" },
      { start: 8, end: 13, replacement: "THREE", reason: "upper" },
    ]);
    expect(edited).toBe("ONE two THREE");
  });

  test("rejects overlapping edits", () => {
    expect(() =>
      applyEdits("abcdef", [
        { start: 1, end: 4, replacement: "x", reason: "a" },
        { start: 2, end: 5, replacement: "y", reason: "b" },
      ]),
    ).toThrow("Overlapping");
  });

  test("replaces only the reference URL inside its node", () => {
    const source = "![alt](./a.png)";
    const parsed = parseMarkdown(source, "post.md");
    const reference = parsed.references[0]!;
    const edit = urlEdit(source, reference, "./b.png");
    expect(edit).toBeDefined();
    expect(applyEdits(source, [edit!])).toBe("![alt](./b.png)");
  });

  test("does not rewrite link text that happens to equal the URL", () => {
    const source = "[https://example.com](https://example.com)";
    const parsed = parseMarkdown(source, "post.md");
    const reference = parsed.references[0]!;
    const edit = urlEdit(source, reference, "https://example.com/next");
    expect(edit).toBeDefined();
    expect(applyEdits(source, [edit!])).toBe("[https://example.com](https://example.com/next)");
  });
});

describe("normalizeBlankLines", () => {
  test("collapses runs of blank lines and trims trailing blank lines", () => {
    const result = normalizeBlankLines("a\n\n\n\nb\n\n");
    expect(result.text).toBe("a\n\nb\n");
    expect(result.collapsedBlankLines).toBe(2);
  });

  test("preserves CRLF line endings", () => {
    const result = normalizeBlankLines("a\r\n\r\n\r\nb\r\n");
    expect(result.text).toBe("a\r\n\r\nb\r\n");
  });

  test("does not touch blank lines inside frontmatter or fenced code", () => {
    const source = "---\na: 1\n\n\n---\n\n\n```\n\n\n```\n\n\nbody\n";
    const result = normalizeBlankLines(source);
    expect(result.text).toContain("a: 1\n\n\n---");
    expect(result.text).toContain("```\n\n\n```");
    expect(result.text).toEndWith("body\n");
  });
});

describe("extractFrontmatter", () => {
  test("parses YAML frontmatter and leaves the body", () => {
    const result = extractFrontmatter("---\ntitle: Hello\n---\n\nBody\n");
    expect(result.data).toEqual({ title: "Hello" });
    expect(result.body).toBe("\nBody\n");
    expect(result.raw).toBe("title: Hello");
  });

  test("returns the source when there is no frontmatter", () => {
    expect(extractFrontmatter("# Body\n")).toEqual({ data: {}, body: "# Body\n", raw: "" });
  });
});
