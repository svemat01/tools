import { afterEach, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { openLocalFile } from "../../src/lib/open.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "sv-open-test-"));
  roots.push(root);
  const report = join(root, "report ' ; $(do-not-run).html");
  await writeFile(report, "<!doctype html>");
  const binary = join(root, "xdg-open");
  await writeFile(binary, '#!/bin/sh\nprintf "%s" "$1" > "$SV_OPEN_LOG"\n');
  await chmod(binary, 0o755);
  return { root, report, binary, env: { PATH: root, SV_OPEN_LOG: join(root, "argv") } };
}
test("local opening uses a fixed executable and one encoded file URL, without shell evaluation", async () => {
  const f = await fixture();
  expect(await openLocalFile(f.report, { env: f.env, platform: "linux" })).toBe(true);
  expect(await readFile(f.env.SV_OPEN_LOG, "utf8")).toBe(pathToFileURL(f.report).href);
  expect(await openLocalFile(join(f.root, "missing"), { env: f.env })).toBe(false);
  const alias = join(f.root, "alias.html");
  await symlink(f.report, alias);
  expect(await openLocalFile(alias, { env: f.env })).toBe(false);
});
test("missing, cancelled and stalled openers fail without preventing report access", async () => {
  const f = await fixture();
  expect(await openLocalFile(f.report, { env: { PATH: "/nonexistent" } })).toBe(false);
  expect(await openLocalFile(f.report, { env: f.env, signal: AbortSignal.abort() })).toBe(false);
  await writeFile(f.binary, "#!/bin/sh\nexec /bin/sleep 10\n");
  const start = performance.now();
  expect(await openLocalFile(f.report, { env: f.env, platform: "linux", timeoutMs: 30 })).toBe(false);
  expect(performance.now() - start).toBeLessThan(1000);
  expect(await readFile(f.report, "utf8")).toBe("<!doctype html>");
});
