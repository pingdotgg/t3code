import {
  DEFAULT_CLIENT_SETTINGS,
  type ClientSettingsPatch,
  type DesktopSnapShotState,
} from "@t3tools/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { userEvent } from "vite-plus/test/browser";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const bridge = vi.hoisted(() => ({
  getSnapShotState: vi.fn<() => Promise<DesktopSnapShotState>>(),
  setSnapShotShortcutSuppressed: vi.fn(),
  checkSnapShotShortcut: vi.fn(),
  previewSnapShotConfig: vi.fn(),
  applySnapShotConfig: vi.fn(),
  setupSnapShot: vi.fn(),
  requestSnapShotPermissions: vi.fn(),
  onMenuAction: vi.fn(),
  onSnapShotEvent: vi.fn(() => () => undefined),
}));
const toast = vi.hoisted(() => vi.fn());
// Client settings behave like the real store: an update re-renders every reader.
const settingsStore = vi.hoisted(() => ({
  current: {} as typeof DEFAULT_CLIENT_SETTINGS,
  listeners: new Set<() => void>(),
  update: vi.fn<(patch: ClientSettingsPatch) => Promise<void>>(),
  set(next: typeof DEFAULT_CLIENT_SETTINGS) {
    settingsStore.current = next;
    for (const listener of settingsStore.listeners) listener();
  },
}));
vi.mock(import("@tanstack/react-router"), async (original) => ({
  ...(await original()),
  useLocation: ((options?: { select?: (location: unknown) => unknown }) =>
    options?.select?.({ hash: "", pathname: "/settings/snapshots", state: {} }) ?? "") as never,
  useNavigate: (() => vi.fn()) as never,
}));
vi.mock(import("../../lib/desktopSnapShot"), async (original) => ({
  ...(await original()),
  getDesktopSnapShotBridge: () => bridge as never,
}));
vi.mock(import("../ui/toast"), async (original) => {
  const actual = await original();
  return { ...actual, toastManager: { ...actual.toastManager, add: toast } };
});
vi.mock(import("../../hooks/useSettings"), async (original) => {
  const { useSyncExternalStore } = await import("react");
  const subscribe = (listener: () => void) => {
    settingsStore.listeners.add(listener);
    return () => settingsStore.listeners.delete(listener);
  };
  return {
    ...(await original()),
    useClientSettings: (() =>
      useSyncExternalStore(subscribe, () => settingsStore.current)) as never,
    updateClientSettings: settingsStore.update as never,
  };
});

import { readSnapShotSetupResume } from "../../lib/snapShotSetupResume";
import { SnapShotSettings } from "./SnapShotSettings";

let state: DesktopSnapShotState;
let root: Root;
let container: HTMLDivElement;

async function mount() {
  root = createRoot(container);
  await act(async () => root.render(<SnapShotSettings />));
  await vi.waitFor(() => expect(bridge.getSnapShotState).toHaveBeenCalled());
  await act(async () => {});
}
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
const scope = () => dialog() ?? container;
function button(label: string, within: ParentNode = scope()) {
  return (
    [...within.querySelectorAll("button")].find(
      (element) => element.textContent?.trim() === label,
    ) ?? null
  );
}
async function click(label: string) {
  const target = button(label);
  expect(target, `button ${label}`).not.toBeNull();
  await act(async () => target!.click());
}
const recorder = () => scope().querySelector<HTMLButtonElement>("[data-keybinding-capture]")!;
const toggle = (label: string) =>
  container.querySelector<HTMLButtonElement>(`[role="switch"][aria-label="${label}"]`)!;
const stepTitle = () => dialog()?.querySelector("h3")?.textContent;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  localStorage.clear();
  Object.defineProperty(navigator, "platform", { configurable: true, get: () => "Linux" });
  settingsStore.current = { ...DEFAULT_CLIENT_SETTINGS, snapShotEnabled: true };
  state = {
    mode: "portal",
    linuxBackend: "hyprland",
    shortcut: DEFAULT_CLIENT_SETTINGS.snapShotShortcut,
    shortcutRegistered: false,
    shortcutActionRegistered: true,
    shortcutMessage: null,
    message: null,
    hyprlandHelper: { status: "ready", message: "Ready" },
  };
  bridge.getSnapShotState.mockImplementation(async () => state);
  bridge.setSnapShotShortcutSuppressed.mockResolvedValue(undefined);
  bridge.checkSnapShotShortcut.mockResolvedValue({ available: true, message: null });
  bridge.requestSnapShotPermissions.mockResolvedValue(undefined);
  bridge.setupSnapShot.mockReset().mockResolvedValue(undefined);
  settingsStore.update.mockImplementation(async (patch) => {
    state = { ...state, shortcut: patch.snapShotShortcut ?? state.shortcut };
    settingsStore.set({ ...settingsStore.current, ...patch });
  });
  container = document.createElement("div");
  document.body.append(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  localStorage.clear();
  Reflect.deleteProperty(navigator, "platform");
  vi.unstubAllGlobals();
});

it.each(["niri", "hyprland"] as const)(
  "reopens %s setup at Shortcut without reading config or expanding Settings",
  async (desktop) => {
    state = { ...state, linuxBackend: desktop };
    await mount();
    expect(dialog()).toBeNull();
    expect(button("Review changes", container)).toBeNull();
    await click("Change shortcut");
    expect(stepTitle()).toBe("Choose your shortcut");
    expect(button("Review changes")).not.toBeNull();
    expect(bridge.previewSnapShotConfig).not.toHaveBeenCalled();
    expect(bridge.applySnapShotConfig).not.toHaveBeenCalled();
    await click("Close");
    expect(dialog()).toBeNull();
    expect(settingsStore.update).not.toHaveBeenCalled();
    expect(settingsStore.current.snapShotEnabled).toBe(true);
  },
);

it("returns to Access if the Hyprland helper needs attention before changing keys", async () => {
  await mount();
  state = { ...state, hyprlandHelper: { status: "not-installed", message: "Install helper" } };
  await click("Change shortcut");
  expect(stepTitle()).toBe("Allow snapshots");
  expect(button("Install helper")).not.toBeNull();
  expect(bridge.previewSnapShotConfig).not.toHaveBeenCalled();
});

it.each(["direct", "gnome-extension", "kde"] as const)(
  "keeps %s shortcut recording and saving inline",
  async (backend) => {
    state = {
      ...state,
      mode: backend === "direct" ? "direct" : "portal",
      linuxBackend: backend === "direct" ? undefined : backend,
      shortcutRegistered: true,
      shortcutLabel: backend === "direct" ? undefined : "Press <Shift><Control>2",
      shortcutMessage: backend === "direct" ? null : "Desktop shortcut: Press <Shift><Control>2",
    };
    await mount();
    if (backend !== "direct") {
      expect(recorder().getAttribute("aria-label")).toBe(
        "Record snapshot shortcut, currently Ctrl+Shift+2",
      );
    }
    await act(async () => userEvent.click(recorder()));
    await act(async () => userEvent.keyboard("{Control>}{Alt>}y{/Alt}{/Control}"));
    expect(bridge.checkSnapShotShortcut).toHaveBeenCalledOnce();
    expect(container.textContent).toContain("Ready to save.");
    expect(recorder().getAttribute("aria-label")).toBe(
      "Record snapshot shortcut, currently Ctrl+Alt+Y",
    );
    await click("Save");
    expect(settingsStore.update).toHaveBeenCalledWith({
      snapShotShortcut: expect.objectContaining({ key: "y", modKey: true, altKey: true }),
    });
    expect(dialog()).toBeNull();
    expect(bridge.previewSnapShotConfig).not.toHaveBeenCalled();
  },
);

it("turns capture on directly on Windows without opening setup", async () => {
  settingsStore.current = { ...settingsStore.current, snapShotEnabled: false };
  state = { ...state, mode: "direct", linuxBackend: undefined, windows: true };
  await mount();
  await act(async () => toggle("Enable snapshots").click());
  expect(settingsStore.update).toHaveBeenCalledWith({ snapShotEnabled: true });
  expect(toggle("Enable snapshots").getAttribute("aria-checked")).toBe("true");
  expect(dialog()).toBeNull();
  expect(button("Manage capture")).toBeNull();
});

it("keeps the approved desktop shortcut when recording is cancelled in setup", async () => {
  state = {
    ...state,
    linuxBackend: "gnome-extension",
    gnomeExtension: { status: "enabled", message: "Ready" },
    shortcutRegistered: true,
    shortcutLabel: "Press <Control><Alt>8",
  };
  await mount();
  await click("Manage capture");
  expect(dialog()).not.toBeNull();
  expect(recorder().getAttribute("aria-label")).toBe(
    "Record snapshot shortcut, currently Ctrl+Alt+8",
  );
  await act(async () => userEvent.click(recorder()));
  expect(recorder().textContent).toBe("Press shortcut…");
  await act(async () => userEvent.keyboard("{Escape}"));
  expect(dialog()).not.toBeNull();
  expect(recorder().getAttribute("aria-label")).toBe(
    "Record snapshot shortcut, currently Ctrl+Alt+8",
  );
  expect(settingsStore.update).not.toHaveBeenCalled();
  expect(bridge.checkSnapShotShortcut).not.toHaveBeenCalled();
});

function usePortalShortcut(shortcutCanRetry: boolean) {
  const shortcut = {
    key: "2",
    modKey: false,
    ctrlKey: true,
    altKey: false,
    shiftKey: true,
    metaKey: false,
  };
  settingsStore.current = { ...settingsStore.current, snapShotShortcut: shortcut };
  state = {
    ...state,
    linuxBackend: "gnome-extension",
    gnomeExtension: { status: "enabled", message: "Ready" },
    shortcut,
    linuxFeedbackAvailable: true,
    shortcutRegistered: true,
    shortcutCanRetry,
  };
}

it("keeps older portal shortcuts editable without offering unsupported permissions", async () => {
  usePortalShortcut(false);
  await mount();
  expect(button("Shortcut permissions")).toBeNull();
  expect(bridge.setupSnapShot).not.toHaveBeenCalled();
  await act(async () => userEvent.click(recorder()));
  expect(recorder().textContent).toBe("Press shortcut…");
});

it("shows permission errors once in a toast and allows retrying", async () => {
  usePortalShortcut(true);
  bridge.setupSnapShot.mockRejectedValueOnce(new Error("The desktop service disconnected."));
  await mount();
  await click("Shortcut permissions");
  expect(toast).toHaveBeenCalledExactlyOnceWith({
    type: "error",
    title: "Couldn't open shortcut permissions",
    description: "The desktop service disconnected.",
  });
  expect(container.querySelector('[role="alert"]')).toBeNull();
  await click("Shortcut permissions");
  expect(bridge.setupSnapShot).toHaveBeenCalledTimes(2);
  expect(toast).toHaveBeenCalledTimes(1);
});

it("keeps a failed preference unchanged and reports the save error in a toast", async () => {
  usePortalShortcut(true);
  settingsStore.update.mockRejectedValueOnce(new Error("The settings file is read-only."));
  await mount();
  const flash = () => toggle("Flash captured window");
  expect(flash().getAttribute("aria-checked")).toBe("true");
  await act(async () => flash().click());
  expect(flash().getAttribute("aria-checked")).toBe("true");
  expect(toast).toHaveBeenCalledExactlyOnceWith({
    type: "error",
    title: "Couldn't save capture settings",
    description: "The settings file is read-only.",
  });
  await act(async () => flash().click());
  expect(flash().getAttribute("aria-checked")).toBe("false");
  expect(toast).toHaveBeenCalledTimes(1);
});

it("keeps setup errors in the wizard and does not toast them after closing it", async () => {
  usePortalShortcut(true);
  state = { ...state, shortcutRegistered: false };
  await mount();
  await click("Manage capture");
  expect(stepTitle()).toBe("Choose your shortcut");
  bridge.setupSnapShot.mockRejectedValueOnce(new Error("The desktop service disconnected."));
  await click("Shortcut permissions");
  expect(dialog()!.querySelector('[role="alert"]')?.textContent).toContain(
    "Couldn't finish this step",
  );
  expect(dialog()!.querySelector("details")?.textContent).toContain(
    "The desktop service disconnected.",
  );
  expect(toast).not.toHaveBeenCalled();
  await click("Close");
  expect(dialog()).toBeNull();
  expect(toast).not.toHaveBeenCalled();
});

function useMacPermissions(granted: boolean) {
  settingsStore.current = { ...settingsStore.current, snapShotEnabled: false };
  state = {
    mode: "direct",
    shortcut: DEFAULT_CLIENT_SETTINGS.snapShotShortcut,
    shortcutRegistered: granted,
    shortcutMessage: null,
    message: null,
    macPermissions: { screenRecording: granted, accessibility: granted },
  };
}

it.each([false, true])(
  "resumes macOS permission setup after restart and clears it on close, completed=%s",
  async (completed) => {
    useMacPermissions(false);
    await mount();
    await act(async () => toggle("Enable snapshots").click());
    expect(stepTitle()).toBe("Allow snapshots");
    bridge.setupSnapShot.mockImplementationOnce(async () => {
      expect(readSnapShotSetupResume()).toEqual({ wasEnabled: false });
    });
    await click("Allow");
    expect(bridge.setupSnapShot).toHaveBeenCalledWith("allow-screen-recording");

    // macOS quits the app from its permission prompt; the next launch resumes setup.
    await act(async () => root.unmount());
    state = { ...state, shortcutRegistered: true };
    state = { ...state, macPermissions: { screenRecording: true, accessibility: true } };
    await mount();
    expect(stepTitle()).toBe("Allow snapshots");
    expect(button("Finish later")).not.toBeNull();
    if (completed) {
      await click("Test capture and continue");
      expect(stepTitle()).toBe("Choose your shortcut");
      await click("Done");
    } else {
      await click("Finish later");
    }
    expect(dialog()).toBeNull();
    expect(readSnapShotSetupResume()).toBeNull();
  },
);

it("requires a successful macOS test capture before enabling and allows retry", async () => {
  useMacPermissions(true);
  await mount();
  await act(async () => toggle("Enable snapshots").click());
  bridge.setupSnapShot.mockRejectedValueOnce(new Error("Capture was denied"));
  await click("Test capture and continue");
  expect(dialog()!.querySelector('[role="alert"]')).not.toBeNull();
  expect(dialog()!.querySelector("details")?.textContent).toContain("Capture was denied");
  expect(stepTitle()).toBe("Allow snapshots");
  expect(settingsStore.current.snapShotEnabled).toBe(false);
  await click("Test capture and continue");
  expect(stepTitle()).toBe("Choose your shortcut");
  expect(bridge.setupSnapShot.mock.calls).toEqual([["test-mac-capture"], ["test-mac-capture"]]);
  expect(settingsStore.current.snapShotEnabled).toBe(true);
});
