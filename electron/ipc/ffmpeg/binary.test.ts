import { describe, expect, it, vi } from "vitest";

import { resolveFfprobeBinaryPath } from "./binary";

describe("resolveFfprobeBinaryPath", () => {
  it("prefers a native system ffprobe on Apple Silicon before the bundled static binary", () => {
    const result = resolveFfprobeBinaryPath({
      loadFfprobeStatic: vi.fn(
        () => "/app/node_modules/ffprobe-static/bin/darwin/arm64/ffprobe",
      ),
      resolveSystemFfprobeBinaryPath: vi.fn(() => "/opt/homebrew/bin/ffprobe"),
      existsSync: vi.fn(() => true),
      isPackaged: true,
      platform: "darwin",
      arch: "arm64",
    });

    expect(result).toBe("/opt/homebrew/bin/ffprobe");
  });

  it("uses the bundled ffprobe when a system Apple Silicon ffprobe is unavailable", () => {
    const result = resolveFfprobeBinaryPath({
      loadFfprobeStatic: vi.fn(
        () =>
          "/app/app.asar/node_modules/ffprobe-static/bin/darwin/arm64/ffprobe",
      ),
      resolveSystemFfprobeBinaryPath: vi.fn(() => null),
      existsSync: vi.fn(() => true),
      isPackaged: true,
      platform: "darwin",
      arch: "arm64",
    });

    expect(result).toBe(
      "/app/app.asar.unpacked/node_modules/ffprobe-static/bin/darwin/arm64/ffprobe",
    );
  });

  it("keeps bundled ffprobe first on non-Apple-Silicon platforms", () => {
    const result = resolveFfprobeBinaryPath({
      loadFfprobeStatic: vi.fn(
        () => "/app/node_modules/ffprobe-static/bin/darwin/x64/ffprobe",
      ),
      resolveSystemFfprobeBinaryPath: vi.fn(() => "/usr/local/bin/ffprobe"),
      existsSync: vi.fn(() => true),
      isPackaged: false,
      platform: "darwin",
      arch: "x64",
    });

    expect(result).toBe(
      "/app/node_modules/ffprobe-static/bin/darwin/x64/ffprobe",
    );
  });
});
