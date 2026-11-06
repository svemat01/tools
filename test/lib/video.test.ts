import { describe, expect, test } from "bun:test";

import {
  buildWebmArgs,
  defaultWebmOptions,
  parseProbeOutput,
  targetDimensions,
  VIDEO_EXTENSIONS,
} from "../../src/lib/video.ts";

const PROBE = JSON.stringify({
  streams: [
    {
      codec_type: "video",
      codec_name: "h264",
      width: 3840,
      height: 2160,
      avg_frame_rate: "30000/1001",
      duration: "12.5",
    },
    { codec_type: "audio", codec_name: "aac" },
  ],
  format: { duration: "12.6", bit_rate: "5000000", format_name: "mov,mp4,m4a,3gp,3g2,mj2" },
});

describe("parseProbeOutput", () => {
  test("reads video, audio and format metadata", () => {
    const info = parseProbeOutput(PROBE);
    expect(info).toMatchObject({
      width: 3840,
      height: 2160,
      codec: "h264",
      format: "mov,mp4,m4a,3gp,3g2,mj2",
      bitRate: 5000000,
      duration: 12.5,
      hasAudio: true,
    });
    expect(info.frameRate).toBeCloseTo(29.97, 2);
  });

  test("reports missing audio and handles missing streams", () => {
    const info = parseProbeOutput(JSON.stringify({ streams: [], format: {} }));
    expect(info.hasAudio).toBe(false);
    expect(info.width).toBeUndefined();
  });

  test("rejects invalid JSON", () => {
    expect(() => parseProbeOutput("not json")).toThrow("invalid JSON");
  });
});

describe("targetDimensions", () => {
  test("scales down to the width limit while preserving aspect ratio", () => {
    expect(targetDimensions({ width: 3840, height: 2160, hasAudio: false }, 1920)).toEqual({
      width: 1920,
      height: 1080,
    });
  });

  test("never upscales", () => {
    expect(targetDimensions({ width: 800, height: 600, hasAudio: false }, 1920)).toBeUndefined();
  });

  test("honours both width and height limits", () => {
    expect(targetDimensions({ width: 1920, height: 1080, hasAudio: false }, 1920, 1000)).toEqual({
      width: 1778,
      height: 1000,
    });
    expect(targetDimensions({ width: 1080, height: 1920, hasAudio: false }, 1920, 1080)).toEqual({
      width: 608,
      height: 1080,
    });
  });

  test("returns even dimensions", () => {
    const dimensions = targetDimensions({ width: 1001, height: 1001, hasAudio: false }, 500);
    expect(dimensions?.width).toBe(500);
    expect(dimensions?.height).toBe(500);
  });

  test("never rounds beyond odd maximum dimensions", () => {
    const dimensions = targetDimensions({ width: 1920, height: 1080, hasAudio: false }, 1001, 563);
    expect(dimensions?.width).toBeLessThanOrEqual(1001);
    expect(dimensions?.height).toBeLessThanOrEqual(563);
    expect((dimensions?.width ?? 1) % 2).toBe(0);
    expect((dimensions?.height ?? 1) % 2).toBe(0);
  });

  test("rounds odd source dimensions down without upscaling", () => {
    expect(targetDimensions({ width: 801, height: 601, hasAudio: false }, 1920)).toEqual({
      width: 800,
      height: 600,
    });
  });

  test("rejects limits too small for even output dimensions", () => {
    expect(() => targetDimensions({ width: 100, height: 100, hasAudio: false }, 1)).toThrow("at least 2");
  });
});

describe("buildWebmArgs", () => {
  const options = { crf: 32, maxWidth: 1920, audio: "keep" as const, audioBitrate: "128k" };

  test("uses VP9 constant quality and Opus audio", () => {
    const args = buildWebmArgs("in.mp4", "out.webm", options);
    expect(args).toContain("libvpx-vp9");
    expect(args).toContain("libopus");
    expect(args).toContain("-b:a");
    expect(args).toContain("128k");
    expect(args.at(-1)).toBe("out.webm");
    expect(args).not.toContain("-an");
    expect(args).not.toContain("-vf");
  });

  test("adds an explicit scale filter and strips audio on request", () => {
    const args = buildWebmArgs(
      "in.mp4",
      "out.webm",
      { ...options, audio: "strip" },
      { width: 1280, height: 720 },
    );
    expect(args).toContain("scale=1280:720:flags=lanczos");
    expect(args).toContain("-an");
    expect(args).not.toContain("libopus");
  });
});

describe("defaults", () => {
  test("default options are conservative", () => {
    expect(defaultWebmOptions()).toEqual({
      crf: 32,
      maxWidth: 1920,
      audio: "keep",
      audioBitrate: "128k",
    });
    expect(VIDEO_EXTENSIONS).toContain("mp4");
    expect(VIDEO_EXTENSIONS).toContain("webm");
  });
});
