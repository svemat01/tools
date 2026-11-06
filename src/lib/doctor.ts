import { clipboardCommand } from "./clipboard.ts";
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
  checks.push(
    clipboardCommand(env)
      ? {
          name: "clipboard",
          status: "ok",
          message: "Clipboard binary available (desktop access is not tested)",
        }
      : {
          name: "clipboard",
          status: "warning",
          message: "Optional: install pbcopy, wl-copy, xclip, xsel or clip.exe for clipboard support.",
        },
  );
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
