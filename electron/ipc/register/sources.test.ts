import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  handle: vi.fn(),
  getSources: vi.fn(),
  getNativeMacWindowSources: vi.fn(),
  stopWindowBoundsCapture: vi.fn(),
}));

vi.mock("electron", () => ({
  app: {
    getName: () => "Recordly",
    getPath: () => "/tmp/recordly-test",
  },
  BrowserWindow: {
    getAllWindows: () => [],
  },
  desktopCapturer: {
    getSources: mocks.getSources,
  },
  ipcMain: {
    handle: mocks.handle,
  },
}));

vi.mock("../utils", () => {
  const primaryDisplay = {
    id: 101,
    bounds: { x: 0, y: 0, width: 1440, height: 900 },
    workArea: { x: 0, y: 0, width: 1440, height: 860 },
  };

  return {
    getScreen: () => ({
      getAllDisplays: () => [primaryDisplay],
      getPrimaryDisplay: () => primaryDisplay,
    }),
    parseWindowId: (sourceId?: string) => {
      const match = sourceId?.match(/^window:(\d+):/);
      return match ? Number(match[1]) : null;
    },
  };
});

vi.mock("../recording/ffmpeg", () => ({
  getDisplayBoundsForSource: vi.fn(),
  getDisplayWorkAreaForSource: vi.fn(),
}));

vi.mock("../cursor/bounds", () => ({
  getNativeMacWindowSources: mocks.getNativeMacWindowSources,
  resolveMacWindowBounds: vi.fn(),
  resolveWindowsWindowBounds: vi.fn(),
  resolveLinuxWindowBounds: vi.fn(),
  stopWindowBoundsCapture: mocks.stopWindowBoundsCapture,
}));

vi.mock("../../windows", () => ({
  reassertHudOverlayMousePassthrough: vi.fn(),
}));

vi.mock("./sourceMapping", () => ({
  getScreenSourceIdForDisplay: ({ displayId }: { displayId: string }) =>
    `screen:${displayId}:0`,
}));

import {
  registerSourceHandlers,
  shouldUseElectronSourceEnumeration,
} from "./sources";

async function withPlatform<T>(
  platform: NodeJS.Platform,
  run: () => Promise<T>,
) {
  const originalDescriptor = Object.getOwnPropertyDescriptor(
    process,
    "platform",
  );
  Object.defineProperty(process, "platform", {
    value: platform,
  });
  try {
    return await run();
  } finally {
    if (originalDescriptor) {
      Object.defineProperty(process, "platform", originalDescriptor);
    }
  }
}

describe("shouldUseElectronSourceEnumeration", () => {
  it("avoids Electron source enumeration on macOS by default", () => {
    expect(shouldUseElectronSourceEnumeration("darwin", {})).toBe(false);
  });

  it("allows the deprecated Electron macOS fallback only when explicitly enabled", () => {
    expect(
      shouldUseElectronSourceEnumeration("darwin", {
        RECORDLY_ALLOW_DEPRECATED_ELECTRON_CAPTURE_FALLBACK: "1",
      }),
    ).toBe(true);
  });

  it("keeps Electron source enumeration on non-macOS platforms", () => {
    expect(shouldUseElectronSourceEnumeration("win32", {})).toBe(true);
    expect(shouldUseElectronSourceEnumeration("linux", {})).toBe(true);
  });
});

describe("registerSourceHandlers", () => {
  it("lists macOS sources without touching Electron desktopCapturer by default", async () => {
    mocks.handle.mockClear();
    mocks.getSources.mockClear();
    mocks.getNativeMacWindowSources.mockResolvedValue([
      {
        id: "window:77:0",
        name: "Safari — Page",
        display_id: "101",
        appName: "Safari",
        windowTitle: "Page",
      },
    ]);

    await withPlatform("darwin", async () => {
      const previousFallback =
        process.env.RECORDLY_ALLOW_DEPRECATED_ELECTRON_CAPTURE_FALLBACK;
      delete process.env.RECORDLY_ALLOW_DEPRECATED_ELECTRON_CAPTURE_FALLBACK;
      try {
        registerSourceHandlers({
          createEditorWindow: vi.fn(),
          createSourceSelectorWindow: vi.fn(),
          getSourceSelectorWindow: vi.fn(() => null),
        });

        const getSourcesHandler = mocks.handle.mock.calls.find(
          ([channel]) => channel === "get-sources",
        )?.[1];
        expect(getSourcesHandler).toBeTypeOf("function");

        const result = await getSourcesHandler(null, {
          types: ["screen", "window"],
          thumbnailSize: { width: 160, height: 90 },
        });

        expect(mocks.getSources).not.toHaveBeenCalled();
        expect(result).toEqual([
          {
            id: "screen:101:0",
            name: "Screen 1 (Primary)",
            originalName: "Screen 1 (Primary)",
            display_id: "101",
            thumbnail: null,
            appIcon: null,
            sourceType: "screen",
          },
          {
            id: "window:77:0",
            name: "Safari — Page",
            originalName: "Safari — Page",
            display_id: "101",
            thumbnail: null,
            appIcon: null,
            appName: "Safari",
            windowTitle: "Page",
            sourceType: "window",
          },
        ]);
      } finally {
        if (previousFallback === undefined) {
          delete process.env
            .RECORDLY_ALLOW_DEPRECATED_ELECTRON_CAPTURE_FALLBACK;
        } else {
          process.env.RECORDLY_ALLOW_DEPRECATED_ELECTRON_CAPTURE_FALLBACK =
            previousFallback;
        }
      }
    });
  });
});
