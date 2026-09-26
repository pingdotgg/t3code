import { assert, beforeEach, it, vi } from "vite-plus/test";

const { execFileMock, loadWindowsForegroundApiMock } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
  loadWindowsForegroundApiMock: vi.fn(),
}));

vi.mock("node:child_process", () => ({ execFile: execFileMock }));
vi.mock("../electron/WindowsForeground.ts", () => ({
  loadWindowsForegroundApi: loadWindowsForegroundApiMock,
}));

import { activeWindow } from "./ActiveWindow.ts";

beforeEach(() => {
  execFileMock.mockReset();
  loadWindowsForegroundApiMock.mockReset();
});

function stubMacLookup(stdout: string) {
  execFileMock.mockImplementation(
    (
      _file: string,
      _args: ReadonlyArray<string>,
      _options: unknown,
      callback: (error: Error | null, stdout: string) => void,
    ) => callback(null, stdout),
  );
}

function macLookup(
  windows: ReadonlyArray<{
    id: number;
    title: string;
    bounds: { x: number; y: number; width: number; height: number };
    alpha?: number;
  }>,
) {
  return JSON.stringify({
    owner: {
      name: "Editor",
      processId: 123,
      path: "/Applications/Editor.app",
      bundleId: "com.example.editor",
    },
    windows: windows.map((window) => ({ ...window, alpha: window.alpha ?? 1 })),
  });
}

it("parses the frontmost macOS window from the osascript lookup", async () => {
  stubMacLookup(
    macLookup([
      {
        id: 42,
        title: "main.ts",
        bounds: { x: 10, y: 20, width: 800, height: 600 },
      },
    ]) + "\n",
  );

  const window = await activeWindow("darwin");

  assert.deepEqual(window, {
    platform: "macos",
    id: 42,
    title: "main.ts",
    bounds: { x: 10, y: 20, width: 800, height: 600 },
    owner: {
      name: "Editor",
      processId: 123,
      path: "/Applications/Editor.app",
      bundleId: "com.example.editor",
    },
  });
  const [file, args] = execFileMock.mock.calls[0]!;
  assert.strictEqual(file, "/usr/bin/osascript");
  assert.deepEqual(args.slice(0, 3), ["-l", "JavaScript", "-e"]);
  assert.lengthOf(loadWindowsForegroundApiMock.mock.calls, 0);
});

it("omits an empty macOS bundle identifier", async () => {
  stubMacLookup(
    JSON.stringify({
      owner: { name: "cli", processId: 9, path: "", bundleId: "" },
      windows: [
        {
          id: 7,
          title: "",
          bounds: { x: 0, y: 0, width: 1, height: 1 },
          alpha: 1,
        },
      ],
    }),
  );

  const window = await activeWindow("darwin");

  assert.deepEqual(window?.owner, { name: "cli", processId: 9, path: "" });
});

it("skips transparent and tiny auxiliary windows before the main window", async () => {
  stubMacLookup(
    macLookup([
      {
        id: 1,
        title: "",
        bounds: { x: 0, y: -32, width: 1_680, height: 32 },
        alpha: 0,
      },
      {
        id: 2,
        title: "",
        bounds: { x: 0, y: 0, width: 1_680, height: 68 },
      },
      {
        id: 3,
        title: "Pull request · Browser",
        bounds: { x: 0, y: 0, width: 1_680, height: 1_050 },
      },
    ]),
  );

  const window = await activeWindow("darwin");

  assert.strictEqual(window?.id, 3);
  assert.deepEqual(window?.bounds, { x: 0, y: 0, width: 1_680, height: 1_050 });
});

it("keeps an untitled frontmost dialog ahead of a titled parent", async () => {
  stubMacLookup(
    macLookup([
      {
        id: 4,
        title: "",
        bounds: { x: 300, y: 200, width: 400, height: 240 },
      },
      {
        id: 5,
        title: "Document",
        bounds: { x: 0, y: 0, width: 1_680, height: 1_050 },
      },
    ]),
  );

  assert.strictEqual((await activeWindow("darwin"))?.id, 4);
});

it("keeps a small frontmost window ahead of a larger window", async () => {
  stubMacLookup(
    macLookup([
      {
        id: 6,
        title: "Widget",
        bounds: { x: 20, y: 20, width: 109, height: 68 },
      },
      {
        id: 7,
        title: "Document",
        bounds: { x: 0, y: 0, width: 1_680, height: 1_050 },
      },
    ]),
  );

  assert.strictEqual((await activeWindow("darwin"))?.id, 6);
});

it("keeps a titled edge-strip window ahead of a larger window", async () => {
  stubMacLookup(
    macLookup([
      {
        id: 8,
        title: "Palette",
        bounds: { x: 0, y: 0, width: 1_000, height: 50 },
      },
      {
        id: 9,
        title: "Document",
        bounds: { x: 0, y: 0, width: 1_000, height: 800 },
      },
    ]),
  );

  assert.strictEqual((await activeWindow("darwin"))?.id, 8);
});

it("keeps an offset untitled edge-strip window ahead of a larger window", async () => {
  stubMacLookup(
    macLookup([
      {
        id: 10,
        title: "",
        bounds: { x: 100, y: 100, width: 1_000, height: 50 },
      },
      {
        id: 11,
        title: "Document",
        bounds: { x: 0, y: 0, width: 1_000, height: 800 },
      },
    ]),
  );

  assert.strictEqual((await activeWindow("darwin"))?.id, 10);
});

it("resolves undefined when macOS has no frontmost window", async () => {
  stubMacLookup("\n");

  assert.isUndefined(await activeWindow("darwin"));
});

it("resolves undefined when macOS reports no visible windows", async () => {
  stubMacLookup(macLookup([]));

  assert.isUndefined(await activeWindow("darwin"));
});

it("composes the Windows foreground window from Win32 calls", async () => {
  const api = {
    getForegroundWindow: vi.fn(() => 0x1_f123_4567n),
    getWindowRect: vi.fn(() => ({ x: 10, y: 20, width: 800, height: 600 })),
    getWindowThreadAndProcessId: vi.fn(() => ({ threadId: 5, processId: 123 })),
    getProcessImagePath: vi.fn(() => "C:\\Program Files\\Editor\\editor.exe"),
    getWindowText: vi.fn(() => "main.ts - Editor"),
  };
  loadWindowsForegroundApiMock.mockResolvedValue(api);

  const window = await activeWindow("win32");

  assert.deepEqual(window, {
    platform: "windows",
    id: 0x1_f123_4567,
    title: "main.ts - Editor",
    bounds: { x: 10, y: 20, width: 800, height: 600 },
    owner: { name: "editor.exe", processId: 123, path: "C:\\Program Files\\Editor\\editor.exe" },
  });
  assert.deepEqual(api.getWindowRect.mock.calls, [[0x1_f123_4567n]]);
  assert.deepEqual(api.getProcessImagePath.mock.calls, [[123]]);
  assert.lengthOf(execFileMock.mock.calls, 0);
});

it("resolves undefined when Windows reports no foreground window", async () => {
  const api = {
    getForegroundWindow: vi.fn(() => 0n),
    getWindowRect: vi.fn(),
    getWindowThreadAndProcessId: vi.fn(),
    getProcessImagePath: vi.fn(),
    getWindowText: vi.fn(),
  };
  loadWindowsForegroundApiMock.mockResolvedValue(api);

  assert.isUndefined(await activeWindow("win32"));
  assert.lengthOf(api.getWindowRect.mock.calls, 0);
});

it("resolves undefined on other platforms without querying the OS", async () => {
  assert.isUndefined(await activeWindow("linux"));
  assert.lengthOf(execFileMock.mock.calls, 0);
  assert.lengthOf(loadWindowsForegroundApiMock.mock.calls, 0);
});
