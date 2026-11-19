import { clipboardCommand, clipboardReader } from "./clipboard.ts";
import { findBinary } from "./process.ts";
import { discoverProject, loadProjectConfig } from "./project.ts";

export interface DoctorCheck {
  name: string;
  status: "ok" | "warning" | "error";
  message: string;
}
export async function doctor(cwd: string, env: Readonly<Record<string, string | undefined>>) {
  const checks: DoctorCheck[] = [];
  const supported =
    Number(Bun.version.split(".")[0]) > 1 ||
    (Number(Bun.version.split(".")[0]) === 1 && Number(Bun.version.split(".")[1]) >= 4);
  checks.push({
    name: "runtime",
    status: supported ? "ok" : "error",
    message: `Bun ${Bun.version}${supported ? "" : "; upgrade to Bun >=1.4.0"}`,
  });
  for (const binary of ["ffmpeg", "ffprobe", "cloudflared"]) {
    const found = findBinary(binary, env);
    checks.push({
      name: binary,
      status: found ? "ok" : "warning",
      message: found
        ? "Available on PATH"
        : `Optional: install ${binary === "ffprobe" ? "FFmpeg (includes ffprobe)" : binary} and add it to PATH to enable ${binary === "cloudflared" ? "tunnels" : "video processing"}.`,
    });
  }
  for (const [name, available, advice] of [
    [
      "clipboard-copy",
      clipboardCommand(env) !== undefined,
      "Install pbcopy, wl-copy, xclip, xsel or clip.exe to copy URLs.",
    ],
    [
      "clipboard-read",
      clipboardReader({ env }) !== undefined,
      "Install pbpaste, wl-paste, xclip, xsel or PowerShell to use sv paste.",
    ],
  ] as const) {
    checks.push({
      name,
      status: available ? "ok" : "warning",
      message: available ? "Binary available; desktop access is not tested" : `Optional: ${advice}`,
    });
  }
  let project: Awaited<ReturnType<typeof discoverProject>> = undefined;
  try {
    project = await discoverProject(cwd);
    if (project) {
      const loaded = await loadProjectConfig(project.root);
      checks.push({
        name: "project",
        status: "ok",
        message: `Project at ${project.root}; ${loaded.config ? "sv config v1" : "no sv config"}${loaded.blog ? "; blog config valid" : ""}`,
      });
    } else
      checks.push({
        name: "project",
        status: "warning",
        message: "No project marker found; run sv init to create sv.config.json.",
      });
  } catch (error) {
    checks.push({
      name: "project",
      status: "error",
      message: error instanceof Error ? error.message : String(error),
    });
  }
  return {
    command: "doctor" as const,
    schemaVersion: 1 as const,
    project: project ?? null,
    checks,
    ok: checks.every((check) => check.status !== "error"),
  };
}
