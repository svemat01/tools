/**
 * Small, dependency-free output helpers shared by commands.
 *
 * Colour is opt-in per stream and follows the usual NO_COLOR convention, so
 * redirected output and tests stay plain text.
 */

import type { Output } from "../kit/index.ts";

const CODES = {
  red: 31,
  green: 32,
  yellow: 33,
  blue: 34,
  magenta: 35,
  cyan: 36,
  gray: 90,
  bold: 1,
  dim: 2,
} as const;

export type ColorName = keyof typeof CODES;

export function useColor(output: Output, env: Readonly<Record<string, string | undefined>>): boolean {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return false;
  if (env.FORCE_COLOR === "1" || env.FORCE_COLOR === "true") return true;
  return output.isTTY === true;
}

export function color(text: string, name: ColorName, enabled: boolean): string {
  return enabled ? `\x1b[${CODES[name]}m${text}\x1b[0m` : text;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
  if (bytes >= 1024 ** 4) return `${(bytes / 1024 ** 4).toFixed(2)} TB`;
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(2)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

/** Signed size change, e.g. `-42.1%` or `+8.0%`. */
export function formatSavings(before: number, after: number): string {
  if (before <= 0) return "n/a";
  const change = ((after - before) / before) * 100;
  if (Math.abs(change) < 0.05) return "0%";
  return `${change > 0 ? "+" : ""}${change.toFixed(1)}%`;
}

export function formatPercent(value: number, digits = 2): string {
  return `${value.toFixed(digits)}%`;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  return `${minutes}m ${rest}s`;
}

export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return count === 1 ? singular : pluralForm;
}

/** JSON with stable two-space indentation and a trailing newline. */
export function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/** Keep table-ish output aligned without pulling in a table library. */
export function pad(text: string, width: number): string {
  return text.length >= width ? text : text + " ".repeat(width - text.length);
}
