import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { screenMock } = vi.hoisted(() => ({
  screenMock: {
    getPrimaryDisplay: vi.fn(),
    getDisplayMatching: vi.fn(),
  },
}));

vi.mock("electron", () => ({
  screen: screenMock,
}));

import { attachWindowStatePersistence, loadWindowState } from "./windowState";

class FakeBrowserWindow {
  private readonly listeners = new Map<string, Array<() => void>>();
  private currentBounds: { x: number; y: number; width: number; height: number };

  constructor(
    private normalBounds: { x: number; y: number; width: number; height: number },
    private fullscreen = false,
    private maximized = false,
  ) {
    this.currentBounds = normalBounds;
  }

  on(event: string, listener: () => void): this {
    const listeners = this.listeners.get(event) ?? [];
    listeners.push(listener);
    this.listeners.set(event, listeners);
    return this;
  }

  emit(event: string): void {
    for (const listener of this.listeners.get(event) ?? []) {
      listener();
    }
  }

  getNormalBounds() {
    return this.normalBounds;
  }

  setNormalBounds(bounds: { x: number; y: number; width: number; height: number }): void {
    this.normalBounds = bounds;
  }

  getBounds() {
    return this.currentBounds;
  }

  setCurrentBounds(bounds: { x: number; y: number; width: number; height: number }): void {
    this.currentBounds = bounds;
  }

  isFullScreen(): boolean {
    return this.fullscreen;
  }

  isMaximized(): boolean {
    return this.maximized;
  }

  setModes({ fullscreen, maximized }: { fullscreen?: boolean; maximized?: boolean }): void {
    if (fullscreen !== undefined) {
      this.fullscreen = fullscreen;
    }
    if (maximized !== undefined) {
      this.maximized = maximized;
    }
  }
}

function createTempDir(): string {
  return FS.mkdtempSync(Path.join(OS.tmpdir(), "t3-window-state-"));
}

function readPersistedWindowState(dir: string) {
  return JSON.parse(FS.readFileSync(Path.join(dir, "window-state.json"), "utf8"));
}

describe("windowState", () => {
  const defaultBounds = {
    x: 0,
    y: 0,
    width: 1100,
    height: 780,
  } as const;
  const primaryWorkArea = {
    x: 0,
    y: 25,
    width: 1440,
    height: 875,
  };

  beforeEach(() => {
    vi.useFakeTimers();
    screenMock.getPrimaryDisplay.mockReset();
    screenMock.getDisplayMatching.mockReset();
    screenMock.getPrimaryDisplay.mockReturnValue({
      workArea: primaryWorkArea,
    });
    screenMock.getDisplayMatching.mockReturnValue({
      workArea: primaryWorkArea,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("loads centered defaults when the state file is missing", () => {
    const result = loadWindowState({
      userDataPath: createTempDir(),
      defaultBounds,
      minWidth: 840,
      minHeight: 620,
    });

    expect(result).toEqual({
      bounds: {
        x: 170,
        y: 73,
        width: 1100,
        height: 780,
      },
      restoreMode: "normal",
    });
  });

  it("falls back to defaults for invalid JSON and unsupported versions", () => {
    const invalidJsonDir = createTempDir();
    FS.writeFileSync(Path.join(invalidJsonDir, "window-state.json"), "{oops", "utf8");

    expect(
      loadWindowState({
        userDataPath: invalidJsonDir,
        defaultBounds,
        minWidth: 840,
        minHeight: 620,
      }).restoreMode,
    ).toBe("normal");

    const invalidVersionDir = createTempDir();
    FS.writeFileSync(
      Path.join(invalidVersionDir, "window-state.json"),
      JSON.stringify({
        version: 2,
        normalBounds: { x: 10, y: 10, width: 1200, height: 800 },
        restoreMode: "maximized",
      }),
      "utf8",
    );

    expect(
      loadWindowState({
        userDataPath: invalidVersionDir,
        defaultBounds,
        minWidth: 840,
        minHeight: 620,
      }).restoreMode,
    ).toBe("normal");
  });

  it("clamps bounds below the minimum size", () => {
    const dir = createTempDir();
    FS.writeFileSync(
      Path.join(dir, "window-state.json"),
      JSON.stringify({
        version: 1,
        normalBounds: { x: 10, y: 20, width: 300, height: 200 },
        restoreMode: "normal",
      }),
      "utf8",
    );

    const result = loadWindowState({
      userDataPath: dir,
      defaultBounds,
      minWidth: 840,
      minHeight: 620,
    });

    expect(result.bounds).toEqual({
      x: 10,
      y: 20,
      width: 840,
      height: 620,
    });
    expect(result.restoreMode).toBe("normal");
  });

  it("accepts partially visible bounds when enough of the window remains on-screen", () => {
    const workArea = { x: 0, y: 0, width: 1000, height: 800 };
    screenMock.getPrimaryDisplay.mockReturnValue({ workArea });
    screenMock.getDisplayMatching.mockReturnValue({ workArea });

    const dir = createTempDir();
    FS.writeFileSync(
      Path.join(dir, "window-state.json"),
      JSON.stringify({
        version: 1,
        normalBounds: { x: 820, y: 50, width: 850, height: 700 },
        restoreMode: "maximized",
      }),
      "utf8",
    );

    const result = loadWindowState({
      userDataPath: dir,
      defaultBounds,
      minWidth: 840,
      minHeight: 620,
    });

    expect(result).toEqual({
      bounds: {
        x: 820,
        y: 50,
        width: 850,
        height: 700,
      },
      restoreMode: "maximized",
    });
  });

  it("falls back to defaults when persisted bounds are effectively off-screen", () => {
    const workArea = { x: 0, y: 0, width: 1000, height: 800 };
    screenMock.getPrimaryDisplay.mockReturnValue({ workArea });
    screenMock.getDisplayMatching.mockReturnValue({ workArea });

    const dir = createTempDir();
    FS.writeFileSync(
      Path.join(dir, "window-state.json"),
      JSON.stringify({
        version: 1,
        normalBounds: { x: 950, y: 50, width: 400, height: 400 },
        restoreMode: "maximized",
      }),
      "utf8",
    );

    const result = loadWindowState({
      userDataPath: dir,
      defaultBounds,
      minWidth: 840,
      minHeight: 620,
    });

    expect(result).toEqual({
      bounds: {
        x: -50,
        y: 10,
        width: 1100,
        height: 780,
      },
      restoreMode: "normal",
    });
  });

  it("persists fullscreen-origin restores separately from normal maximized state", () => {
    const fullscreenDir = createTempDir();
    const fullscreenWindow = new FakeBrowserWindow(
      { x: 100, y: 120, width: 1200, height: 900 },
      true,
      true,
    );
    fullscreenWindow.setCurrentBounds({ x: 60, y: 40, width: 1400, height: 850 });
    attachWindowStatePersistence({
      window: fullscreenWindow as never,
      userDataPath: fullscreenDir,
    });
    fullscreenWindow.emit("close");

    expect(readPersistedWindowState(fullscreenDir)).toEqual({
      version: 1,
      normalBounds: { x: 100, y: 120, width: 1200, height: 900 },
      restoreMode: "fullscreen-origin",
      fullscreenOriginBounds: { x: 60, y: 40, width: 1400, height: 850 },
    });
  });

  it("preserves the last non-fullscreen bounds when closing from true fullscreen", () => {
    const dir = createTempDir();
    const window = new FakeBrowserWindow({ x: 120, y: 90, width: 1280, height: 860 }, false, true);
    window.setCurrentBounds({ x: 40, y: 32, width: 1392, height: 842 });
    attachWindowStatePersistence({
      window: window as never,
      userDataPath: dir,
    });

    window.setModes({ fullscreen: true, maximized: true });
    window.setNormalBounds({ x: 0, y: 0, width: 1512, height: 982 });
    window.setCurrentBounds({ x: 0, y: 0, width: 1512, height: 982 });
    window.emit("enter-full-screen");
    window.emit("close");

    expect(readPersistedWindowState(dir)).toEqual({
      version: 1,
      normalBounds: { x: 120, y: 90, width: 1280, height: 860 },
      restoreMode: "fullscreen-origin",
      fullscreenOriginBounds: { x: 40, y: 32, width: 1392, height: 842 },
    });
  });

  it("persists maximized and normal modes using normal bounds", () => {
    const maximizedDir = createTempDir();
    const maximizedWindow = new FakeBrowserWindow(
      { x: 40, y: 60, width: 1280, height: 860 },
      false,
      true,
    );
    attachWindowStatePersistence({
      window: maximizedWindow as never,
      userDataPath: maximizedDir,
    });
    maximizedWindow.emit("close");

    expect(readPersistedWindowState(maximizedDir)).toEqual({
      version: 1,
      normalBounds: { x: 40, y: 60, width: 1280, height: 860 },
      restoreMode: "maximized",
    });

    const normalDir = createTempDir();
    const normalWindow = new FakeBrowserWindow({ x: 10, y: 20, width: 900, height: 700 });
    attachWindowStatePersistence({
      window: normalWindow as never,
      userDataPath: normalDir,
    });
    normalWindow.emit("close");

    expect(readPersistedWindowState(normalDir)).toEqual({
      version: 1,
      normalBounds: { x: 10, y: 20, width: 900, height: 700 },
      restoreMode: "normal",
    });
  });

  it("flushes pending resize persistence when the window closes", () => {
    const dir = createTempDir();
    const window = new FakeBrowserWindow({ x: 22, y: 44, width: 1000, height: 720 });
    attachWindowStatePersistence({
      window: window as never,
      userDataPath: dir,
    });

    window.emit("resize");
    expect(FS.existsSync(Path.join(dir, "window-state.json"))).toBe(false);

    window.emit("close");

    expect(readPersistedWindowState(dir).normalBounds).toEqual({
      x: 22,
      y: 44,
      width: 1000,
      height: 720,
    });
  });

  it("persists debounced move and resize updates", () => {
    const dir = createTempDir();
    const window = new FakeBrowserWindow({ x: 33, y: 55, width: 1111, height: 777 });
    attachWindowStatePersistence({
      window: window as never,
      userDataPath: dir,
    });

    window.emit("move");
    vi.advanceTimersByTime(249);
    expect(FS.existsSync(Path.join(dir, "window-state.json"))).toBe(false);

    vi.advanceTimersByTime(1);
    expect(readPersistedWindowState(dir).normalBounds).toEqual({
      x: 33,
      y: 55,
      width: 1111,
      height: 777,
    });
  });

  it("logs write failures without throwing", () => {
    const filePath = Path.join(createTempDir(), "occupied");
    FS.writeFileSync(filePath, "not a directory", "utf8");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const window = new FakeBrowserWindow({ x: 10, y: 20, width: 900, height: 700 });

    expect(() =>
      attachWindowStatePersistence({
        window: window as never,
        userDataPath: filePath,
      }),
    ).not.toThrow();

    expect(() => window.emit("close")).not.toThrow();
    expect(warnSpy).toHaveBeenCalledWith(
      "[desktop] failed to persist window state",
      expect.any(Error),
    );
  });
});
