/** Ephemeral progress for interactive terminals; redirected and JSON output stays stable. */
import type { Output } from "../kit/context.ts";
import { displayPath } from "./fs.ts";
import { formatDuration } from "./output.ts";

export interface ProgressEvent {
  readonly phase: "inspect" | "encode" | "review" | "apply" | "reuse";
  readonly path?: string;
  readonly current?: number;
  readonly total?: number;
}
const labels: Record<ProgressEvent["phase"], string> = {
  inspect: "Inspecting",
  encode: "Encoding",
  review: "Building review",
  apply: "Writing",
  reuse: "Verifying existing output",
};
export function createProgressReporter(
  output: Output,
  options: { readonly cwd: string; readonly enabled?: boolean; readonly now?: () => number },
) {
  const enabled = output.isTTY === true && options.enabled !== false;
  const now = options.now ?? (() => performance.now());
  let started: number | undefined;
  let previous = "";
  return {
    report(event: ProgressEvent): void {
      if (!enabled) return;
      started ??= now();
      const count =
        event.current === undefined
          ? ""
          : ` ${event.current}${event.total === undefined ? "" : `/${event.total}`}`;
      // JSON quoting makes filenames containing terminal controls inert display data.
      const path =
        event.path === undefined ? "" : ` · ${JSON.stringify(displayPath(options.cwd, event.path))}`;
      const line = `${labels[event.phase]}${count}${path}`;
      if (line === previous) return;
      previous = line;
      output.write(`\r\x1b[2K${line}`);
    },
    finish(status: "complete" | "cancelled" | "failed" = "complete"): void {
      if (!enabled || started === undefined) return;
      const label = status === "complete" ? "Finished" : status === "cancelled" ? "Cancelled" : "Failed";
      output.write(`\r\x1b[2K${label} · ${formatDuration(Math.max(0, now() - started))}\n`);
      started = undefined;
      previous = "";
    },
  };
}
