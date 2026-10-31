import * as NodeVM from "node:vm";

import { assert, beforeEach, it, vi } from "vite-plus/test";

const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }));

vi.mock("node:child_process", () => ({ execFile: execFileMock }));

import { activeWindow } from "./ActiveWindow.ts";

beforeEach(() => {
  execFileMock.mockReset();
});

const ON_SCREEN_ONLY = 1;

type FakeWindow = {
  readonly id: number;
  readonly ownerPid: number;
  readonly ownerName: string;
  readonly layer?: number;
  readonly onScreen?: boolean;
};

type FakeApp = { readonly pid: number; readonly name: string };

const wrap = (value: unknown) => ({ js: value });

// Runs the production JXA script in a VM against fake AppKit and CoreGraphics
// bindings, so osascript's stdout comes from the script's own window selection.
function stubMacRuntime(app: FakeApp, windows: ReadonlyArray<FakeWindow>) {
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

it("falls back to the first on-screen layer-zero window named like the app when its PID is -1", async () => {
  stubMacRuntime({ pid: -1, name: "Device Hub" }, [
    { id: 1, ownerPid: 50, ownerName: "Finder" },
    { id: 2, ownerPid: 35409, ownerName: "Device Hub", layer: 25 },
    { id: 3, ownerPid: 35409, ownerName: "Device Hub", onScreen: false },
    { id: 4, ownerPid: 60, ownerName: "Device Hub Helper" },
    { id: 5, ownerPid: 35409, ownerName: "Device Hub" },
    { id: 6, ownerPid: 35410, ownerName: "Device Hub" },
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

it("keeps matching a valid PID by process, not by owner name", async () => {
  stubMacRuntime({ pid: 123, name: "Editor" }, [
    { id: 1, ownerPid: 999, ownerName: "Editor" },
    { id: 2, ownerPid: 123, ownerName: "Editor Helper" },
  ]);

  const window = await activeWindow("darwin");

  assert.strictEqual(window?.id, 2);
  assert.strictEqual(window?.owner.processId, 123);
  assert.strictEqual(window?.owner.name, "Editor");
});
