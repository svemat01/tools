import { describe, expect, test } from "bun:test";

import {
  applyEdits,
  extractFrontmatter,
  normalizeBlankLines,
  parseMarkdown,
  protectedMarkdownRanges,
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

describe("conservative source rewriting", () => {
  function rewrite(source: string, replacement = "next.webp", path = "post.md"): string {
    const references = parseMarkdown(source, path).references;
    const edits = references.flatMap((reference) => {
      const edit = urlEdit(source, reference, replacement);
      return edit ? [edit] : [];
    });
    return applyEdits(source, edits);
  }

  test("rewrites the destination after whitespace without touching its identical title", () => {
    expect(rewrite('[label]( image.png "image.png")')).toBe('[label]( next.webp "image.png")');
    expect(rewrite('![image.png](image.png "image.png")')).toBe('![image.png](next.webp "image.png")');
  });

  test("handles nested labels and literal parenthesized destinations", () => {
    expect(rewrite('[label [nested]](image(test).png "title")')).toBe('[label [nested]](next.webp "title")');
    expect(rewrite('[label](<image with spaces.png> "title")')).toBe('[label](<next.webp> "title")');
    expect(rewrite('[label]:  <image.png> "image.png"')).toBe('[label]:  <next.webp> "image.png"');
  });

  test("refuses to guess the destination of decoded or escaped source text", () => {
    const source = '[label](image\\(1\\).png "image(1).png")';
    expect(rewrite(source)).toBe(source);
    const encoded = '[label](image.png?x=1&amp;y=2 "image.png?x=1&y=2")';
    expect(rewrite(encoded)).toBe(encoded);
  });

  test("tracks each HTML attribute and its own tag alt text", () => {
    // A quoted attribute containing a URL-like word must not be mistaken for src.
    const valid = '<img title="src=fiction.png" src="a.png" alt="A"><img src="b.png" alt="B">';
    const parsed = parseMarkdown(valid, "post.md");
    expect(parsed.references.map((reference) => [reference.url, reference.alt])).toEqual([
      ["a.png", "A"],
      ["b.png", "B"],
    ]);
    expect(rewrite(valid)).toBe(
      '<img title="src=fiction.png" src="next.webp" alt="A"><img src="next.webp" alt="B">',
    );
  });

  test("does not invent HTML references inside comments", () => {
    expect(parseMarkdown('<!-- <img src="fake.png"> -->', "post.md").references).toEqual([]);
  });

  test("keeps separate source spans for src and href in MDX", () => {
    const source = '<Asset src="image.png" href="image.png" alt="image.png" />';
    expect(rewrite(source, "next.webp", "post.mdx")).toBe(
      '<Asset src="next.webp" href="next.webp" alt="image.png" />',
    );
  });

  test("encodes replacement delimiters without breaking destination syntax", () => {
    expect(rewrite("[x](old.png)", "new (1).png")).toBe("[x](new%20%281%29.png)");
    expect(rewrite('<img src="old.png">', 'new"name.png')).toBe('<img src="new%22name.png">');
  });

  test("rejects stale spans", () => {
    const source = "[x](old.png)";
    const reference = parseMarkdown(source, "post.md").references[0]!;
    expect(urlEdit("[x](new.png)", reference, "next.webp")).toBeUndefined();
  });
});

describe("tracking parameter safety", () => {
  test("preserves functional parameters even alongside tracking", () => {
    const result = stripTrackingParameters(
      "https://example.com/?s=search&source=feed&ref=branch&referrer=home&si=id&trk=route&utm_source=email",
    );
    expect(result.url).toBe(
      "https://example.com/?s=search&source=feed&ref=branch&referrer=home&si=id&trk=route",
    );
    expect(result.removed).toEqual(["utm_source"]);
  });

  test("does not normalize encoding or duplicate values in preserved query fields", () => {
    const result = stripTrackingParameters("/find?q=a%20b&q=%2f&literal=~&utm_source=x#fragment");
    expect(result.url).toBe("/find?q=a%20b&q=%2f&literal=~#fragment");
  });
});

describe("protected Markdown content", () => {
  test("preserves longer fences containing shorter fence examples", () => {
    const literal = "````md\n```\n\n\nexample\n```\n\n\n````\n";
    expect(normalizeBlankLines(literal).text).toBe(literal);
  });

  test("does not treat a fence with trailing text as a closing fence", () => {
    const literal = "```\n```not-a-close\n\n\nexample\n```\n";
    expect(normalizeBlankLines(literal).text).toBe(literal);
  });

  test("preserves indented code and unfinished fenced blocks", () => {
    const indented = "    first\n\n\n    second\n";
    expect(normalizeBlankLines(indented).text).toBe(indented);
    const unfinished = "```\nfirst\n\n\n";
    expect(normalizeBlankLines(unfinished).text).toBe(unfinished);
  });

  test("protects code, metadata and MDX JavaScript while allowing prose cleanup", () => {
    const source =
      '---\ntitle: text\n---\n\n<!-- notionvc: remove -->\n\n`literal`\n\nexport const value = "code";\n\n{value}\n\n<Image src="asset.png" />\n\nprose\n';
    const ranges = protectedMarkdownRanges(source, "post.mdx");
    const protectedText = ranges.map((range) => source.slice(range.start, range.end));
    expect(protectedText).toContain("---\ntitle: text\n---");
    expect(protectedText).toContain("`literal`");
    expect(protectedText).toContain('export const value = "code";');
    expect(protectedText).toContain("{value}");
    expect(protectedText).toContain('src="asset.png"');
    expect(protectedText.some((text) => text.includes("notionvc"))).toBe(false);
    expect(protectedText.some((text) => text.includes("prose"))).toBe(false);
  });
});

test("rewrites unambiguous autolinks without changing their label separately", () => {
  for (const source of ["<https://example.com/?utm_source=x>", "https://example.com/?utm_source=x"]) {
    const reference = parseMarkdown(source, "post.md").references[0]!;
    const edit = urlEdit(source, reference, "https://example.com/");
    expect(edit).toBeDefined();
    expect(applyEdits(source, [edit!])).toBe(
      source.startsWith("<") ? "<https://example.com/>" : "https://example.com/",
    );
  }
});

test("frontmatter must be a mapping rather than a sequence", () => {
  expect(() => extractFrontmatter("---\n- title\n- slug\n---\nbody\n")).toThrow("must be an object");
});

test("preserves blank lines in MDX expressions and literal HTML blocks", () => {
  const mdx = "{`first\n\n\nsecond`}\n";
  expect(normalizeBlankLines(mdx, "post.mdx").text).toBe(mdx);
  const html = "<pre>first\n\n\nsecond</pre>\n";
  expect(normalizeBlankLines(html).text).toBe(html);
  expect(normalizeBlankLines(html, "post.mdx").text).toBe(html);
});

test("does not extract apparent HTML references inside literal elements", () => {
  for (const tag of ["script", "style", "pre", "textarea", "code"]) {
    const source = `<${tag}>\nconst demo = '<img src="a.png">';\n</${tag}>\n<img src="b.png">\n`;
    const result = parseMarkdown(source, "post.md");
    expect(result.references.map((reference) => reference.url)).toEqual(["b.png"]);
  }
});
