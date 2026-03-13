import { EventEmitter } from "node:events";
import * as FS from "node:fs/promises";
import * as OS from "node:os";
import * as Path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockedHomedir, readImageMock, spawnMock } = vi.hoisted(() => ({
  mockedHomedir: vi.fn(),
  readImageMock: vi.fn(),
  spawnMock: vi.fn(),
}));

vi.mock("electron", () => ({
  clipboard: {
    readImage: readImageMock,
  },
}));

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return {
    ...actual,
    homedir: mockedHomedir,
  };
});

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    spawn: spawnMock,
  };
});

function pngBytes(): Buffer {
  return Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7+7iQAAAAASUVORK5CYII=",
    "base64",
  );
}

function emptyClipboardImage() {
  return {
    isEmpty: () => true,
    toPNG: () => Buffer.alloc(0),
  };
}

function clipboardImage(imageBytes: Buffer) {
  return {
    isEmpty: () => false,
    toPNG: () => imageBytes,
  };
}

function createSpawnedChild(options?: {
  closeAfterMs?: number;
  onStart?: () => Promise<void> | void;
}) {
  const stdout = new EventEmitter() as EventEmitter & { setEncoding: (encoding: string) => void };
  const stderr = new EventEmitter() as EventEmitter & { setEncoding: (encoding: string) => void };
  stdout.setEncoding = () => undefined;
  stderr.setEncoding = () => undefined;

  const child = new EventEmitter() as EventEmitter & {
    stderr: typeof stderr;
    stdout: typeof stdout;
  };
  child.stdout = stdout;
  child.stderr = stderr;

  const onStart = options?.onStart ?? (() => undefined);
  const closeAfterMs = options?.closeAfterMs ?? 0;

  queueMicrotask(() => {
    void Promise.resolve(onStart()).then(() => {
      setTimeout(() => {
        child.emit("close", 0, null);
      }, closeAfterMs);
    });
  });

  return child;
}

async function makeExecutable(filePath: string): Promise<void> {
  await FS.mkdir(Path.dirname(filePath), { recursive: true });
  await FS.writeFile(filePath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  await FS.chmod(filePath, 0o755);
}

describe("captureDesktopScreenshot", () => {
  const originalOmarchyScreenshotDir = process.env.OMARCHY_SCREENSHOT_DIR;
  const originalXdgPicturesDir = process.env.XDG_PICTURES_DIR;
  const originalXdgRuntimeDir = process.env.XDG_RUNTIME_DIR;
  const originalHyprlandInstanceSignature = process.env.HYPRLAND_INSTANCE_SIGNATURE;
  const tempDirectories: string[] = [];

  beforeEach(() => {
    vi.resetModules();
    mockedHomedir.mockReset();
    readImageMock.mockReset();
    spawnMock.mockReset();
    delete process.env.OMARCHY_SCREENSHOT_DIR;
    delete process.env.XDG_PICTURES_DIR;
    delete process.env.HYPRLAND_INSTANCE_SIGNATURE;
  });

  afterEach(async () => {
    if (originalOmarchyScreenshotDir === undefined) {
      delete process.env.OMARCHY_SCREENSHOT_DIR;
    } else {
      process.env.OMARCHY_SCREENSHOT_DIR = originalOmarchyScreenshotDir;
    }

    if (originalXdgPicturesDir === undefined) {
      delete process.env.XDG_PICTURES_DIR;
    } else {
      process.env.XDG_PICTURES_DIR = originalXdgPicturesDir;
    }

    if (originalXdgRuntimeDir === undefined) {
      delete process.env.XDG_RUNTIME_DIR;
    } else {
      process.env.XDG_RUNTIME_DIR = originalXdgRuntimeDir;
    }

    if (originalHyprlandInstanceSignature === undefined) {
      delete process.env.HYPRLAND_INSTANCE_SIGNATURE;
    } else {
      process.env.HYPRLAND_INSTANCE_SIGNATURE = originalHyprlandInstanceSignature;
    }

    await Promise.all(
      tempDirectories
        .splice(0)
        .map((directoryPath) => FS.rm(directoryPath, { recursive: true, force: true })),
    );
  });

  it("uses Omarchy smart mode and the configured screenshot directory", async () => {
    const tempHome = await FS.mkdtemp(Path.join(OS.tmpdir(), "capture-home-"));
    const screenshotDirectory = Path.join(tempHome, "Shots");
    const runtimeDirectory = Path.join(tempHome, "runtime");
    const hyprlandInstanceSignature = "test-hypr-instance";
    tempDirectories.push(tempHome);
    await FS.mkdir(screenshotDirectory, { recursive: true });
    await FS.mkdir(Path.join(runtimeDirectory, "hypr", hyprlandInstanceSignature), {
      recursive: true,
    });
    await FS.writeFile(
      Path.join(runtimeDirectory, "hypr", hyprlandInstanceSignature, ".socket.sock"),
      "",
    );

    const commandPath = Path.join(
      tempHome,
      ".local",
      "share",
      "omarchy",
      "bin",
      "omarchy-cmd-screenshot",
    );
    await makeExecutable(commandPath);

    mockedHomedir.mockReturnValue(tempHome);
    process.env.OMARCHY_SCREENSHOT_DIR = screenshotDirectory;
    process.env.XDG_RUNTIME_DIR = runtimeDirectory;
    readImageMock.mockReturnValue(emptyClipboardImage());

    const screenshotBytes = pngBytes();
    spawnMock.mockImplementation(
      (command: string, args: string[], options: { env: NodeJS.ProcessEnv }) => {
        expect(command).toBe(commandPath);
        expect(args).toEqual([]);
        expect(options.env.OMARCHY_SCREENSHOT_DIR).toBe(screenshotDirectory);
        expect(options.env.HYPRLAND_INSTANCE_SIGNATURE).toBe(hyprlandInstanceSignature);

        return createSpawnedChild({
          onStart: async () => {
            await FS.writeFile(
              Path.join(screenshotDirectory, "omarchy-smart.png"),
              screenshotBytes,
            );
          },
        });
      },
    );

    const { captureDesktopScreenshot } = await import("./screenshotCapture");
    const screenshot = await captureDesktopScreenshot();

    expect(screenshot).toMatchObject({
      mimeType: "image/png",
      name: "omarchy-smart.png",
      sizeBytes: screenshotBytes.byteLength,
    });
    expect(screenshot?.dataUrl).toContain(screenshotBytes.toString("base64"));
  });

  it("resolves the Omarchy output directory from user-dirs config", async () => {
    const tempHome = await FS.mkdtemp(Path.join(OS.tmpdir(), "capture-home-"));
    const picturesDirectory = Path.join(tempHome, "Pictures", "Shots");
    tempDirectories.push(tempHome);
    await FS.mkdir(Path.join(tempHome, ".config"), { recursive: true });
    await FS.mkdir(picturesDirectory, { recursive: true });
    await FS.writeFile(
      Path.join(tempHome, ".config", "user-dirs.dirs"),
      'XDG_PICTURES_DIR="$HOME/Pictures/Shots"\n',
    );

    const commandPath = Path.join(
      tempHome,
      ".local",
      "share",
      "omarchy",
      "bin",
      "omarchy-cmd-screenshot",
    );
    await makeExecutable(commandPath);

    mockedHomedir.mockReturnValue(tempHome);
    readImageMock.mockReturnValue(emptyClipboardImage());

    const screenshotBytes = pngBytes();
    spawnMock.mockImplementation(() =>
      createSpawnedChild({
        onStart: async () => {
          await FS.writeFile(
            Path.join(picturesDirectory, "omarchy-user-dirs.png"),
            screenshotBytes,
          );
        },
      }),
    );

    const { captureDesktopScreenshot } = await import("./screenshotCapture");
    const screenshot = await captureDesktopScreenshot();

    expect(screenshot?.name).toBe("omarchy-user-dirs.png");
    expect(screenshot?.sizeBytes).toBe(screenshotBytes.byteLength);
  });

  it("falls back to the clipboard when Omarchy updates clipboard only", async () => {
    const tempHome = await FS.mkdtemp(Path.join(OS.tmpdir(), "capture-home-"));
    const screenshotDirectory = Path.join(tempHome, "Shots");
    tempDirectories.push(tempHome);
    await FS.mkdir(screenshotDirectory, { recursive: true });

    const commandPath = Path.join(
      tempHome,
      ".local",
      "share",
      "omarchy",
      "bin",
      "omarchy-cmd-screenshot",
    );
    await makeExecutable(commandPath);

    mockedHomedir.mockReturnValue(tempHome);
    process.env.OMARCHY_SCREENSHOT_DIR = screenshotDirectory;

    const screenshotBytes = pngBytes();
    readImageMock
      .mockReturnValueOnce(emptyClipboardImage())
      .mockReturnValueOnce(clipboardImage(screenshotBytes));
    spawnMock.mockImplementation(() => createSpawnedChild());

    const { captureDesktopScreenshot } = await import("./screenshotCapture");
    const screenshot = await captureDesktopScreenshot();

    expect(screenshot?.mimeType).toBe("image/png");
    expect(screenshot?.sizeBytes).toBe(screenshotBytes.byteLength);
    expect(screenshot?.name).toMatch(/^screenshot-.*\.png$/);
  });

  it("returns as soon as the Omarchy screenshot file lands", async () => {
    const tempHome = await FS.mkdtemp(Path.join(OS.tmpdir(), "capture-home-"));
    const screenshotDirectory = Path.join(tempHome, "Shots");
    const runtimeDirectory = Path.join(tempHome, "runtime");
    const hyprlandInstanceSignature = "test-hypr-instance";
    tempDirectories.push(tempHome);
    await FS.mkdir(screenshotDirectory, { recursive: true });
    await FS.mkdir(Path.join(runtimeDirectory, "hypr", hyprlandInstanceSignature), {
      recursive: true,
    });
    await FS.writeFile(
      Path.join(runtimeDirectory, "hypr", hyprlandInstanceSignature, ".socket.sock"),
      "",
    );

    const commandPath = Path.join(
      tempHome,
      ".local",
      "share",
      "omarchy",
      "bin",
      "omarchy-cmd-screenshot",
    );
    await makeExecutable(commandPath);

    mockedHomedir.mockReturnValue(tempHome);
    process.env.OMARCHY_SCREENSHOT_DIR = screenshotDirectory;
    process.env.XDG_RUNTIME_DIR = runtimeDirectory;
    readImageMock.mockReturnValue(emptyClipboardImage());

    const screenshotBytes = pngBytes();
    spawnMock.mockImplementation(() =>
      createSpawnedChild({
        closeAfterMs: 750,
        onStart: () => {
          setTimeout(() => {
            void FS.writeFile(
              Path.join(screenshotDirectory, "omarchy-delayed.png"),
              screenshotBytes,
            );
          }, 75);
        },
      }),
    );

    const { captureDesktopScreenshot } = await import("./screenshotCapture");
    const captureStartedAt = Date.now();
    const screenshot = await captureDesktopScreenshot();
    const elapsedMilliseconds = Date.now() - captureStartedAt;

    expect(screenshot?.name).toBe("omarchy-delayed.png");
    expect(screenshot?.sizeBytes).toBe(screenshotBytes.byteLength);
    expect(elapsedMilliseconds).toBeLessThan(500);
  });

  it("waits for a complete Omarchy screenshot file before returning", async () => {
    const tempHome = await FS.mkdtemp(Path.join(OS.tmpdir(), "capture-home-"));
    const screenshotDirectory = Path.join(tempHome, "Shots");
    const runtimeDirectory = Path.join(tempHome, "runtime");
    const hyprlandInstanceSignature = "test-hypr-instance";
    tempDirectories.push(tempHome);
    await FS.mkdir(screenshotDirectory, { recursive: true });
    await FS.mkdir(Path.join(runtimeDirectory, "hypr", hyprlandInstanceSignature), {
      recursive: true,
    });
    await FS.writeFile(
      Path.join(runtimeDirectory, "hypr", hyprlandInstanceSignature, ".socket.sock"),
      "",
    );

    const commandPath = Path.join(
      tempHome,
      ".local",
      "share",
      "omarchy",
      "bin",
      "omarchy-cmd-screenshot",
    );
    await makeExecutable(commandPath);

    mockedHomedir.mockReturnValue(tempHome);
    process.env.OMARCHY_SCREENSHOT_DIR = screenshotDirectory;
    process.env.XDG_RUNTIME_DIR = runtimeDirectory;
    readImageMock.mockReturnValue(emptyClipboardImage());

    const screenshotBytes = pngBytes();
    const partialScreenshotBytes = screenshotBytes.subarray(0, screenshotBytes.byteLength - 8);
    spawnMock.mockImplementation(() =>
      createSpawnedChild({
        closeAfterMs: 750,
        onStart: () => {
          setTimeout(() => {
            void FS.writeFile(
              Path.join(screenshotDirectory, "omarchy-partial.png"),
              partialScreenshotBytes,
            );
          }, 50);
          setTimeout(() => {
            void FS.writeFile(
              Path.join(screenshotDirectory, "omarchy-partial.png"),
              screenshotBytes,
            );
          }, 175);
        },
      }),
    );

    const { captureDesktopScreenshot } = await import("./screenshotCapture");
    const captureStartedAt = Date.now();
    const screenshot = await captureDesktopScreenshot();
    const elapsedMilliseconds = Date.now() - captureStartedAt;

    expect(screenshot?.name).toBe("omarchy-partial.png");
    expect(screenshot?.sizeBytes).toBe(screenshotBytes.byteLength);
    expect(screenshot?.dataUrl).toContain(screenshotBytes.toString("base64"));
    expect(elapsedMilliseconds).toBeGreaterThanOrEqual(125);
    expect(elapsedMilliseconds).toBeLessThan(650);
  });
});
