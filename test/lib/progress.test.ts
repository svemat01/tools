import { expect, test } from "bun:test";

import { createProgressReporter } from "../../src/lib/progress.ts";

test("progress is silent when redirected or explicitly disabled for JSON", () => {
  for (const [isTTY, enabled] of [
    [false, true],
    [true, false],
  ] as const) {
    let text = "";
    const reporter = createProgressReporter(
      {
        isTTY,
        write(chunk) {
          text += chunk;
        },
      },
      { cwd: "/work", enabled },
    );
    reporter.report({ phase: "encode", current: 1, total: 2, path: "/work/a.png" });
    reporter.finish();
    expect(text).toBe("");
  }
});

test("interactive progress shows stages, inert filenames and elapsed cancellation without timers", () => {
  let text = "",
    clock = 0;
  const reporter = createProgressReporter(
    {
      isTTY: true,
      write(chunk) {
        text += chunk;
      },
    },
    { cwd: "/work", now: () => clock },
  );
  reporter.report({ phase: "inspect", path: "/work/a\u001b[31m.png" });
  reporter.report({ phase: "encode", current: 1, total: 2, path: "/work/a.png" });
  clock = 1250;
  reporter.finish("cancelled");
  expect(text).toContain("Inspecting");
  expect(text).toContain('"a\\u001b[31m.png"');
  expect(text).toContain("Encoding 1/2");
  expect(text).toContain("Cancelled · 1.3s");
  expect(text).not.toContain("a\u001b[31m.png");
  const finished = text;
  reporter.finish();
  expect(text).toBe(finished);
});
