import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import * as Electron from "electron";
import { MacPermissionHelper, macAppBundlePath } from "./MacPermissionHelper.ts";
import type { SettingsWindow } from "./MacSettingsWindow.ts";
import { SNAP_SHOT_PERMISSION_HELPER_CHANNEL } from "../ipc/channels.ts";

const mocks = vi.hoisted(() => ({
  granted: false,
  createFromPath: vi.fn(),
  startDrag: vi.fn(),
  showItemInFolder: vi.fn(),
  send: vi.fn(),
  loadURL: vi.fn(),
  stopTracking: vi.fn(),
  settingsChanged: undefined as ((state: SettingsWindow) => void) | undefined,
}));
const windows = vi.hoisted(
  () =>
    [] as Array<{
      destroyed: boolean;
      webContents: { mainFrame: object };
      setBounds: ReturnType<typeof vi.fn>;
      hide: ReturnType<typeof vi.fn>;
      showInactive: ReturnType<typeof vi.fn>;
    }>,
);
vi.mock("electron", async () => {
  const { EventEmitter } = await import("node:events");
  class MockWindow extends EventEmitter {
    destroyed = false;
    webContents = Object.assign(new EventEmitter(), {
      mainFrame: {},
      startDrag: mocks.startDrag,
      send: mocks.send,
      setWindowOpenHandler: vi.fn(),
    });
    constructor(_options: unknown) {
      super();
      windows.push(this);
    }
    isDestroyed() {
      return this.destroyed;
    }
    destroy() {
      this.destroyed = true;
      this.emit("closed");
    }
    close() {
      this.destroy();
    }
    loadURL = mocks.loadURL;
    showInactive = vi.fn();
    hide = vi.fn();
    setBounds = vi.fn();
    isVisible = () => false;
    isFocused = () => false;
    show = vi.fn();
    focus = vi.fn();
    getBounds = () => ({ x: 0, y: 0, width: 800, height: 600 });
  }
  return {
    app: {
      getPath: () => "/Applications/T3 Code (Nightly).app/Contents/MacOS/T3 Code",
    },
    nativeImage: { createFromPath: mocks.createFromPath },
    BrowserWindow: class extends MockWindow {},
    ipcMain: new EventEmitter(),
    screen: {
      getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1200, height: 900 } }),
      getCursorScreenPoint: () => ({ x: 10, y: 10 }),
      getDisplayNearestPoint: () => ({ workArea: { x: -1200, y: 0, width: 1200, height: 900 } }),
    },
    systemPreferences: {
      getMediaAccessStatus: () => (mocks.granted ? "granted" : "denied"),
      isTrustedAccessibilityClient: () => mocks.granted,
    },
    shell: { showItemInFolder: mocks.showItemInFolder },
  };
});
vi.mock("./MacSettingsWindow.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./MacSettingsWindow.ts")>();
  return {
    ...actual,
    watchMacSettingsWindow: (onChange: (state: SettingsWindow) => void) => {
      mocks.settingsChanged = onChange;
      return mocks.stopTracking;
    },
  };
});
let helper: MacPermissionHelper;
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  mocks.granted = false;
  const icon = { toDataURL: () => "data:image/png;base64,abc" };
  mocks.createFromPath.mockReturnValue({ isEmpty: () => false, resize: () => icon });
  mocks.loadURL.mockResolvedValue(undefined);
  windows.length = 0;
  helper = new MacPermissionHelper();
});
afterEach(() => {
  helper.close();
  vi.useRealTimers();
});
const iconPaths = ["/bundle/prod-resources/icon.png"];
const open = () =>
  helper.show("accessibility", "/bundle/snapshot-permission-preload.cjs", null, iconPaths);
function send(action: string, trusted = true) {
  const window = windows.at(-1)!;
  Electron.ipcMain.emit(
    SNAP_SHOT_PERMISSION_HELPER_CHANNEL,
    {
      sender: trusted ? window.webContents : {},
      senderFrame: window.webContents.mainFrame,
    },
    action,
  );
}

describe("macAppBundlePath", () => {
  it("resolves bundles with spaces and refuses non-bundle executables", () => {
    expect(macAppBundlePath("/Applications/T3 Code.app/Contents/MacOS/T3 Code")).toBe(
      "/Applications/T3 Code.app",
    );
    expect(macAppBundlePath("/usr/local/bin/electron")).toBeUndefined();
    expect(macAppBundlePath("/Applications/T3 Code.app/other/MacOS/T3 Code")).toBeUndefined();
  });
});
it("drags the running app bundle only for the helper's own renderer", async () => {
  await open();
  send("drag", false);
  expect(mocks.startDrag).not.toHaveBeenCalled();
  send("drag");
  expect(mocks.createFromPath).toHaveBeenCalledWith("/bundle/prod-resources/icon.png");
  expect(mocks.startDrag).toHaveBeenCalledWith({
    file: "/Applications/T3 Code (Nightly).app",
    icon: mocks.createFromPath.mock.results[0]!.value.resize(),
  });
  send("finder");
  expect(mocks.showItemInFolder).toHaveBeenCalledWith("/Applications/T3 Code (Nightly).app");
});
it("rechecks permissions and releases resources when granted", async () => {
  await open();
  mocks.granted = true;
  vi.advanceTimersByTime(1000);
  expect(windows[0]!.destroyed).toBe(true);
  expect(Electron.ipcMain.listenerCount(SNAP_SHOT_PERMISSION_HELPER_CHANNEL)).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
});
it("keeps only one helper and cleans up on dismissal", async () => {
  await open();
  await helper.show("screen-recording", "/preload.cjs", null, iconPaths);
  expect(windows[0]!.destroyed).toBe(true);
  expect(Electron.ipcMain.listenerCount(SNAP_SHOT_PERMISSION_HELPER_CHANNEL)).toBe(1);
  send("close");
  expect(windows[1]!.destroyed).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});
it("does not open for a permission already granted", async () => {
  mocks.granted = true;
  await open();
  expect(windows).toHaveLength(0);
});
it("does not show a helper with a missing packaged icon", async () => {
  mocks.createFromPath.mockReturnValueOnce({ isEmpty: () => true });
  await expect(open()).rejects.toThrow("packaged T3 Code icon is missing");
  expect(windows).toHaveLength(0);
});
it("cleans up when the helper page fails to load", async () => {
  mocks.loadURL.mockRejectedValueOnce(new Error("load failed"));
  await expect(open()).rejects.toThrow("load failed");
  expect(Electron.ipcMain.listenerCount(SNAP_SHOT_PERMISSION_HELPER_CHANNEL)).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
});

it("offers the Finder fallback when native dragging fails", async () => {
  await open();
  mocks.startDrag.mockImplementationOnce(() => {
    throw new Error("drag failed");
  });
  send("drag");
  expect(mocks.showItemInFolder).toHaveBeenCalledWith("/Applications/T3 Code (Nightly).app");
  expect(windows[0]!.destroyed).toBe(false);
});

it("returns focus to onboarding when the permission is granted", async () => {
  const owner = new Electron.BrowserWindow({});
  await helper.show("screen-recording", "/preload.cjs", owner, iconPaths);
  mocks.granted = true;
  vi.advanceTimersByTime(1000);
  expect(owner.show).toHaveBeenCalledOnce();
  expect(owner.focus).toHaveBeenCalledOnce();
  expect(windows[1]!.destroyed).toBe(true);
  expect(owner.listenerCount("closed")).toBe(0);
});
it("closes the helper and stops checking when onboarding's window closes", async () => {
  const owner = new Electron.BrowserWindow({});
  await helper.show("accessibility", "/preload.cjs", owner, iconPaths);
  owner.destroy();
  expect(windows[1]!.destroyed).toBe(true);
  expect(Electron.ipcMain.listenerCount(SNAP_SHOT_PERMISSION_HELPER_CHANNEL)).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
});

it("uses the packaged PNG when an earlier resource candidate is absent", async () => {
  mocks.createFromPath.mockReturnValueOnce({ isEmpty: () => true });
  await helper.show("accessibility", "/preload.cjs", null, ["/missing/icon.png", ...iconPaths]);
  send("drag");
  expect(mocks.startDrag).toHaveBeenCalled();
  expect(mocks.createFromPath).toHaveBeenLastCalledWith(iconPaths[0]);
});

it("docks inside Settings and hides when it is covered or closed", async () => {
  await open();
  const window = windows[0]!;
  const settings = { x: 367, y: 100, width: 723, height: 719, frontmost: true };
  mocks.settingsChanged!(settings);
  expect(window.setBounds).toHaveBeenLastCalledWith(
    { x: 599, y: 663, width: 475, height: 140 },
    false,
  );
  expect(window.showInactive).toHaveBeenCalledOnce();
  mocks.settingsChanged!({ ...settings, x: -800, y: 200 });
  expect(window.setBounds).toHaveBeenLastCalledWith(
    { x: -568, y: 763, width: 475, height: 140 },
    false,
  );
  mocks.settingsChanged!({ ...settings, frontmost: false });
  expect(window.hide).toHaveBeenCalledOnce();
  mocks.settingsChanged!(null);
  expect(window.destroyed).toBe(true);
  helper.close();
  expect(mocks.stopTracking).toHaveBeenCalledOnce();
});
