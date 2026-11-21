import * as NodeVM from "node:vm";

import { assert, beforeEach, it, vi } from "vite-plus/test";

const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }));

vi.mock("node:child_process", () => ({ execFile: execFileMock }));

import { activeWindow } from "./ActiveWindow.ts";

beforeEach(() => {
  execFileMock.mockReset();
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
      path: "/Applications/Editor.app",
      bundleId: "com.example.editor",
    },
    windows: windows.map((window) => ({ ...window, processId: 123, alpha: window.alpha ?? 1 })),
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
});

it.each([
  {
    name: "transparent and untitled helpers",
    helpers: [
      {
        id: 1,
        title: "",
        bounds: { x: -1, y: -44, width: 1_680, height: 44 },
        alpha: 0,
      },
      { id: 2, title: "", bounds: { x: 0, y: 0, width: 1_680, height: 68 } },
    ],
    content: {
      id: 3,
      title: "Document",
      bounds: { x: 0, y: 0, width: 1_680, height: 1_050 },
    },
  },
  {
    name: "Chrome strips stacked above the content window",
    helpers: [
      { id: 75, title: "", bounds: { x: 0, y: 39, width: 1_800, height: 41 } },
      { id: 74, title: "", bounds: { x: 0, y: 80, width: 1_800, height: 81 } },
      { id: 1691, title: "", bounds: { x: 0, y: 39, width: 1_800, height: 158 } },
    ],
    content: {
      id: 71,
      title: "(10) Video - YouTube",
      bounds: { x: 0, y: 161, width: 1_800, height: 1_008 },
    },
  },
  {
    name: "vertical strips at a negative desktop origin",
    helpers: [
      { id: 1, title: "", bounds: { x: -122, y: -100, width: 41, height: 1_000 } },
      { id: 2, title: "", bounds: { x: -81, y: -100, width: 81, height: 1_000 } },
    ],
    content: {
      id: 3,
      title: "Document",
      bounds: { x: 0, y: -100, width: 1_008, height: 1_000 },
    },
  },
  {
    name: "a smaller front window's strips with a larger background window",
    helpers: [
      { id: 75, title: "", bounds: { x: 100, y: 139, width: 1_200, height: 41 } },
      { id: 74, title: "", bounds: { x: 100, y: 180, width: 1_200, height: 81 } },
    ],
    content: {
      id: 71,
      title: "Video - YouTube",
      bounds: { x: 100, y: 261, width: 1_200, height: 700 },
    },
    background: [
      { id: 80, title: "Other document", bounds: { x: 0, y: 39, width: 1_800, height: 1_130 } },
    ],
  },
])("selects the content window behind $name", async ({ helpers, content, background = [] }) => {
  stubMacLookup(macLookup([...helpers, content, ...background]));

  const window = await activeWindow("darwin");

  assert.strictEqual(window?.id, content.id);
  assert.deepEqual(window?.bounds, content.bounds);
});

it.each([
  { name: "untitled dialog", title: "", bounds: { x: 300, y: 200, width: 400, height: 240 } },
  { name: "titled palette", title: "Palette", bounds: { x: 0, y: 0, width: 800, height: 50 } },
  { name: "offset untitled strip", title: "", bounds: { x: 100, y: 100, width: 800, height: 50 } },
  { name: "tall untitled window", title: "", bounds: { x: 0, y: 0, width: 800, height: 900 } },
  {
    name: "horizontal strip below the document",
    title: "",
    bounds: { x: 0, y: 1_200, width: 800, height: 50 },
  },
  {
    name: "horizontal strip inside the document",
    title: "",
    bounds: { x: 0, y: 600, width: 800, height: 50 },
  },
  {
    name: "horizontal strip far above the document",
    title: "",
    bounds: { x: 0, y: -300, width: 800, height: 50 },
  },
  {
    name: "vertical strip right of the document",
    title: "",
    bounds: { x: 900, y: 0, width: 50, height: 1_000 },
  },
  {
    name: "vertical strip inside the document",
    title: "",
    bounds: { x: 400, y: 0, width: 50, height: 1_000 },
  },
  {
    name: "vertical strip far left of the document",
    title: "",
    bounds: { x: -250, y: 0, width: 50, height: 1_000 },
  },
])("keeps a frontmost $name ahead of a larger document", async ({ title, bounds }) => {
  stubMacLookup(
    macLookup([
      { id: 1, title, bounds },
      { id: 2, title: "Document", bounds: { x: 0, y: 0, width: 800, height: 1_000 } },
    ]),
  );

  const window = await activeWindow("darwin");

  assert.strictEqual(window?.id, 1);
  assert.deepEqual(window?.bounds, bounds);
});

it("keeps an untitled content window ahead of a much taller background window", async () => {
  const bounds = { x: 0, y: 0, width: 800, height: 900 };
  stubMacLookup(
    macLookup([
      { id: 1, title: "", bounds },
      { id: 2, title: "Background document", bounds: { x: 0, y: 0, width: 800, height: 4_000 } },
    ]),
  );

  const window = await activeWindow("darwin");

  assert.strictEqual(window?.id, 1);
  assert.deepEqual(window?.bounds, bounds);
});

const ON_SCREEN_ONLY = 1;

type FakeWindow = {
  readonly id: number;
  readonly ownerPid: number;
  readonly ownerName: string;
  readonly layer?: number;
  readonly onScreen?: boolean;
};

const wrap = (value: unknown) => ({ js: value });

// Runs the production JXA script against fake AppKit and CoreGraphics bindings.
function stubMacRuntime(
  app: { readonly pid: number; readonly name: string },
  windows: ReadonlyArray<FakeWindow>,
) {
  const $ = {
    NSWorkspace: {
      sharedWorkspace: {
        frontmostApplication: {
          isNil: () => false,
          processIdentifier: app.pid,
          localizedName: wrap(app.name),
          bundleURL: { path: wrap(`/Applications/${app.name}.app`) },
          bundleIdentifier: wrap(""),
        },
      },
    },
    kCGWindowListOptionOnScreenOnly: ON_SCREEN_ONLY,
    kCGWindowListExcludeDesktopElements: 16,
    kCGNullWindowID: 0,
    CGWindowListCopyWindowInfo: (options: number) =>
      options & ON_SCREEN_ONLY ? windows.filter((w) => w.onScreen !== false) : windows,
    CFMakeCollectable: () => undefined,
    CFArrayGetCount: (list: ReadonlyArray<FakeWindow>) => list.length,
    CFArrayGetValueAtIndex: (list: ReadonlyArray<FakeWindow>, index: number) => list[index],
  };
  const ObjC = {
    import: () => undefined,
    castRefToObject: (w: FakeWindow) => {
      const entries: Record<string, unknown> = {
        kCGWindowNumber: w.id,
        kCGWindowOwnerPID: w.ownerPid,
        kCGWindowOwnerName: w.ownerName,
        kCGWindowLayer: w.layer ?? 0,
        kCGWindowName: `window ${w.id}`,
        kCGWindowAlpha: 1,
        kCGWindowBounds: { X: 0, Y: 0, Width: 100, Height: 50 },
      };
      return { objectForKey: (key: string) => wrap(entries[key]) };
    },
    unwrap: (value: { js: unknown }) => value.js,
    deepUnwrap: (value: { js: unknown }) => value.js,
  };
  execFileMock.mockImplementation(
    (
      _file: string,
      args: ReadonlyArray<string>,
      _options: unknown,
      callback: (error: Error | null, stdout: string) => void,
    ) => callback(null, String(NodeVM.runInNewContext(`${args[3]}\nrun();`, { $, ObjC }))),
  );
}

it("matches windows by app name when the frontmost app reports PID -1", async () => {
  stubMacRuntime({ pid: -1, name: "Device Hub" }, [
    { id: 1, ownerPid: 50, ownerName: "Finder" },
    { id: 2, ownerPid: 35409, ownerName: "Device Hub", layer: 25 },
    { id: 3, ownerPid: 35409, ownerName: "Device Hub", onScreen: false },
    { id: 4, ownerPid: 60, ownerName: "Device Hub Helper" },
    { id: 5, ownerPid: 35409, ownerName: "Device Hub" },
  ]);

  const window = await activeWindow("darwin");

  assert.strictEqual(window?.id, 5);
  assert.deepEqual(window?.owner, {
    name: "Device Hub",
    processId: 35409,
    path: "/Applications/Device Hub.app",
  });
});

it("does not match unnamed windows when the app has PID -1 and no name", async () => {
  stubMacRuntime({ pid: -1, name: "" }, [{ id: 1, ownerPid: 77, ownerName: "" }]);

  assert.isUndefined(await activeWindow("darwin"));
});

it("matches a valid PID by process, not by owner name", async () => {
  stubMacRuntime({ pid: 123, name: "Editor" }, [
    { id: 1, ownerPid: 999, ownerName: "Editor" },
    { id: 2, ownerPid: 123, ownerName: "Editor Helper" },
  ]);

  const window = await activeWindow("darwin");

  assert.strictEqual(window?.id, 2);
  assert.strictEqual(window?.owner.processId, 123);
});
