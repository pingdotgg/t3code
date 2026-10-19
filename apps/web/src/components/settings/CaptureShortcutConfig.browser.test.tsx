import {
  DEFAULT_CLIENT_SETTINGS,
  type DesktopCaptureConfigPreview,
  type DesktopSnapShotState,
} from "@t3tools/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { userEvent } from "vite-plus/test/browser";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const bridge = vi.hoisted(() => ({
  previewSnapShotConfig: vi.fn(),
  applySnapShotConfig: vi.fn(),
  setSnapShotShortcutSuppressed: vi.fn(),
}));
const toast = vi.hoisted(() => vi.fn());
vi.mock(import("../../lib/desktopSnapShot"), async (original) => ({
  ...(await original()),
  getDesktopSnapShotBridge: () => bridge as never,
}));
vi.mock(import("../ui/toast"), async (original) => {
  const actual = await original();
  return { ...actual, toastManager: { ...actual.toastManager, add: toast } };
});

import { CaptureShortcutConfig } from "./CaptureShortcutConfig";

const preview: DesktopCaptureConfigPreview = {
  id: "approved-snapshot",
  path: "/config/niri/config.kdl",
  resolvedPath: "/config/niri/config.kdl",
  before: "binds {\n}\n",
  after: 'binds {\n    Ctrl+Shift+2 { spawn "gdbus"; }\n}\n',
  shortcut: "Ctrl+Shift+2",
  operation: "install",
};
const complete = vi.fn<() => Promise<void>>();

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

let root: Root;
let container: HTMLDivElement;

async function render(desktop: "niri" | "hyprland" = "niri") {
  const state: DesktopSnapShotState = {
    mode: "portal",
    linuxBackend: desktop,
    shortcut: DEFAULT_CLIENT_SETTINGS.snapShotShortcut,
    shortcutRegistered: false,
    shortcutActionRegistered: true,
    shortcutMessage: null,
    message: null,
    shortcutConfigPath: preview.path,
    shortcutBinding: "manual binding",
  };
  await act(async () => root.render(<CaptureShortcutConfig state={state} onComplete={complete} />));
}
function button(label: string) {
  return [...container.querySelectorAll("button")].find((element) => element.textContent === label);
}
async function click(label: string) {
  const target = button(label);
  expect(target, `button ${label}`).toBeDefined();
  await act(async () => target!.click());
}
const recorder = () => container.querySelector<HTMLButtonElement>("[data-keybinding-capture]")!;
const diff = () => container.querySelector('[aria-label="Shortcut changes"]');
const alert = () => container.querySelector('[role="alert"]');
const advanced = () => container.querySelector("details")!;
async function recordKeys(keys: string) {
  await act(async () => userEvent.click(recorder()));
  await act(async () => userEvent.keyboard(keys));
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  Object.defineProperty(navigator, "platform", { configurable: true, get: () => "Linux" });
  bridge.setSnapShotShortcutSuppressed.mockReset().mockResolvedValue(undefined);
  bridge.previewSnapShotConfig.mockReset().mockResolvedValue(preview);
  bridge.applySnapShotConfig
    .mockReset()
    .mockResolvedValue({ backupPath: "/config/backup", warning: null });
  complete.mockReset().mockResolvedValue(undefined);
  toast.mockClear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  Reflect.deleteProperty(navigator, "platform");
  vi.unstubAllGlobals();
});

it.each(["niri", "hyprland"] as const)(
  "shows the fallback before review and requires separate read and write approval on %s",
  async (desktop) => {
    await render(desktop);
    expect(recorder().getAttribute("aria-label")).toBe(
      "Record snapshot shortcut, currently Ctrl+Shift+2",
    );
    expect(advanced().textContent).toContain("manual binding");
    expect(bridge.previewSnapShotConfig).not.toHaveBeenCalled();
    await click("Review changes");
    expect(recorder().getAttribute("aria-label")).toBe(
      "Record snapshot shortcut, currently Ctrl+Shift+2",
    );
    expect(bridge.applySnapShotConfig).not.toHaveBeenCalled();
    expect(diff()).not.toBeNull();
    await click("Save shortcut");
    expect(bridge.applySnapShotConfig).toHaveBeenCalledExactlyOnceWith(preview.id);
    expect(complete).toHaveBeenCalledOnce();
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ type: "success" }));
  },
);

it.each(["niri", "hyprland"] as const)(
  "lets users choose %s keys without opening Advanced, then approve the matching diff",
  async (desktop) => {
    await render(desktop);
    expect(advanced().contains(recorder())).toBe(false);
    await recordKeys("{Control>}{Alt>}y{/Alt}{/Control}");
    expect(bridge.setSnapShotShortcutSuppressed).toHaveBeenNthCalledWith(1, true);
    expect(bridge.setSnapShotShortcutSuppressed).toHaveBeenLastCalledWith(false);
    expect(bridge.previewSnapShotConfig).not.toHaveBeenCalled();
    const custom = {
      ...preview,
      id: "custom-keys",
      shortcut: "Ctrl+Alt+Y",
      after: preview.after.replace("Ctrl+Shift+2", "Ctrl+Alt+Y"),
    };
    bridge.previewSnapShotConfig.mockResolvedValue(custom);
    await click("Review changes");
    expect(bridge.previewSnapShotConfig).toHaveBeenCalledExactlyOnceWith({
      operation: "install",
      chooseFile: false,
      shortcut: "ctrl+alt+y",
    });
    expect(bridge.applySnapShotConfig).not.toHaveBeenCalled();
    await click("Save shortcut");
    expect(bridge.applySnapShotConfig).toHaveBeenCalledExactlyOnceWith(custom.id);
    expect(toast).toHaveBeenCalledWith(
      expect.objectContaining({ description: "Use Ctrl+Alt+Y from another app." }),
    );
  },
);

it("uses the existing config keys when no replacement was chosen", async () => {
  bridge.previewSnapShotConfig.mockResolvedValue({ ...preview, shortcut: "Super+F8" });
  await render();
  await click("Review changes");
  expect(bridge.previewSnapShotConfig).toHaveBeenCalledExactlyOnceWith({
    operation: "install",
    chooseFile: false,
  });
  expect(recorder().getAttribute("aria-label")).toContain("F8");
});

it("requires a new diff after changing keys during review", async () => {
  await render();
  await click("Review changes");
  expect(diff()).not.toBeNull();
  await recordKeys("{Meta>}{F8}{/Meta}");
  expect(diff()).toBeNull();
  expect(bridge.applySnapShotConfig).not.toHaveBeenCalled();
  const replacement = { ...preview, id: "replacement", shortcut: "Super+F8" };
  bridge.previewSnapShotConfig.mockResolvedValue(replacement);
  await click("Review changes");
  expect(bridge.previewSnapShotConfig).toHaveBeenLastCalledWith({
    operation: "install",
    chooseFile: false,
    shortcut: "meta+f8",
  });
  await click("Save shortcut");
  expect(bridge.applySnapShotConfig).toHaveBeenCalledExactlyOnceWith(replacement.id);
});

it.each(["Escape", "blur"])(
  "keeps the reviewed diff when recording is cancelled with %s",
  async (cancel) => {
    await render();
    await click("Review changes");
    await act(async () => userEvent.click(recorder()));
    expect(button("Save shortcut")?.disabled).toBe(true);
    if (cancel === "Escape") await act(async () => userEvent.keyboard("{Escape}"));
    else await act(async () => recorder().blur());
    expect(button("Save shortcut")?.disabled).toBe(false);
    expect(bridge.previewSnapShotConfig).toHaveBeenCalledOnce();
    await click("Save shortcut");
    expect(bridge.applySnapShotConfig).toHaveBeenCalledExactlyOnceWith(preview.id);
  },
);

it("cancelling a reviewed diff does not write or finish setup", async () => {
  await render();
  await click("Review changes");
  await click("Cancel");
  expect(recorder().getAttribute("aria-label")).toBe(
    "Record snapshot shortcut, currently Ctrl+Shift+2",
  );
  expect(button("Review changes")).toBeDefined();
  expect(bridge.applySnapShotConfig).not.toHaveBeenCalled();
  expect(complete).not.toHaveBeenCalled();
});

it("shows reading feedback until a proposal arrives", async () => {
  const pending = deferred<DesktopCaptureConfigPreview>();
  bridge.previewSnapShotConfig.mockReturnValue(pending.promise);
  await render();
  await click("Review changes");
  expect(button("Preparing changes…")?.disabled).toBe(true);
  await act(async () => pending.resolve(preview));
  expect(button("Save shortcut")?.disabled).toBe(false);
});

it("keeps read failures actionable with technical details in Advanced, then permits retry", async () => {
  bridge.previewSnapShotConfig.mockRejectedValueOnce(new Error("EACCES: /config/niri/config.kdl"));
  await render();
  await click("Review changes");
  expect(alert()?.textContent).toBe("Couldn't prepare the changes. Check Advanced for help.");
  expect(advanced().textContent).toContain("EACCES: /config/niri/config.kdl");
  await click("Review changes");
  expect(alert()).toBeNull();
  expect(button("Save shortcut")?.disabled).toBe(false);
  expect(bridge.applySnapShotConfig).not.toHaveBeenCalled();
});

it("withdraws a stale diff and requires another read instead of retrying its write", async () => {
  await render();
  await click("Review changes");
  bridge.applySnapShotConfig.mockRejectedValue(
    new Error("Your config changed since this preview."),
  );
  await click("Save shortcut");
  expect(alert()?.textContent).toContain("Review the changes and try again");
  expect(advanced().textContent).toContain("Your config changed since this preview.");
  expect(button("Review changes")).toBeDefined();
  expect(diff()).toBeNull();
  expect(complete).not.toHaveBeenCalled();
});

it("does not finish or claim success when the desktop could not reload", async () => {
  await render();
  await click("Review changes");
  bridge.applySnapShotConfig.mockResolvedValue({
    backupPath: "/config/backup",
    warning: "Config saved, but reload failed.",
  });
  await click("Save shortcut");
  expect(container.querySelector('[role="status"]')?.textContent).toBe(
    "Saved, but the shortcut needs attention. Check Advanced for help.",
  );
  expect(advanced().textContent).toContain("Config saved, but reload failed.");
  expect(complete).not.toHaveBeenCalled();
  expect(toast).not.toHaveBeenCalled();
});
