import {
  DEFAULT_CLIENT_SETTINGS,
  type DesktopCaptureConfigPreview,
  type DesktopSnapShotState,
} from "@t3tools/contracts";
import { userEvent } from "vite-plus/test/browser";
import { expect, it, vi } from "vite-plus/test";

import { act, render } from "../../../test/render";

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

function setup() {
  const platform = vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux");
  bridge.setSnapShotShortcutSuppressed.mockReset().mockResolvedValue(undefined);
  bridge.previewSnapShotConfig.mockReset().mockResolvedValue(preview);
  bridge.applySnapShotConfig
    .mockReset()
    .mockResolvedValue({ backupPath: "/config/backup", warning: null });
  complete.mockReset().mockResolvedValue(undefined);
  toast.mockClear();
  return { [Symbol.dispose]: () => platform.mockRestore() };
}

async function renderConfig(desktop: "niri" | "hyprland" = "niri") {
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
  const screen = await render(<CaptureShortcutConfig state={state} onComplete={complete} />);
  const { container } = screen;
  const button = (label: string) =>
    [...container.querySelectorAll("button")].find((element) => element.textContent === label);
  const recorder = () => container.querySelector<HTMLButtonElement>("[data-keybinding-capture]")!;
  return Object.assign(screen, {
    button,
    recorder,
    diff: () => container.querySelector('[aria-label="Shortcut changes"]'),
    alert: () => container.querySelector('[role="alert"]'),
    advanced: () => container.querySelector("details")!,
    async click(label: string) {
      const target = button(label);
      expect(target, `button ${label}`).toBeDefined();
      await act(async () => target!.click());
    },
    async recordKeys(keys: string) {
      await act(async () => userEvent.click(recorder()));
      await act(async () => userEvent.keyboard(keys));
    },
  });
}

it.each(["niri", "hyprland"] as const)(
  "shows the fallback before review and requires separate read and write approval on %s",
  async (desktop) => {
    using _env = setup();
    await using screen = await renderConfig(desktop);
    expect(screen.recorder().getAttribute("aria-label")).toBe(
      "Record snapshot shortcut, currently Ctrl+Shift+2",
    );
    expect(screen.advanced().textContent).toContain("manual binding");
    expect(bridge.previewSnapShotConfig).not.toHaveBeenCalled();
    await screen.click("Review changes");
    expect(screen.recorder().getAttribute("aria-label")).toBe(
      "Record snapshot shortcut, currently Ctrl+Shift+2",
    );
    expect(bridge.applySnapShotConfig).not.toHaveBeenCalled();
    expect(screen.diff()).not.toBeNull();
    await screen.click("Save shortcut");
    expect(bridge.applySnapShotConfig).toHaveBeenCalledExactlyOnceWith(preview.id);
    expect(complete).toHaveBeenCalledOnce();
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ type: "success" }));
  },
);

it.each(["niri", "hyprland"] as const)(
  "lets users choose %s keys without opening Advanced, then approve the matching diff",
  async (desktop) => {
    using _env = setup();
    await using screen = await renderConfig(desktop);
    expect(screen.advanced().contains(screen.recorder())).toBe(false);
    await screen.recordKeys("{Control>}{Alt>}y{/Alt}{/Control}");
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
    await screen.click("Review changes");
    expect(bridge.previewSnapShotConfig).toHaveBeenCalledExactlyOnceWith({
      operation: "install",
      chooseFile: false,
      shortcut: "ctrl+alt+y",
    });
    expect(bridge.applySnapShotConfig).not.toHaveBeenCalled();
    await screen.click("Save shortcut");
    expect(bridge.applySnapShotConfig).toHaveBeenCalledExactlyOnceWith(custom.id);
    expect(toast).toHaveBeenCalledWith(
      expect.objectContaining({ description: "Use Ctrl+Alt+Y from another app." }),
    );
  },
);

it("uses the existing config keys when no replacement was chosen", async () => {
  using _env = setup();
  bridge.previewSnapShotConfig.mockResolvedValue({ ...preview, shortcut: "Super+F8" });
  await using screen = await renderConfig();
  await screen.click("Review changes");
  expect(bridge.previewSnapShotConfig).toHaveBeenCalledExactlyOnceWith({
    operation: "install",
    chooseFile: false,
  });
  expect(screen.recorder().getAttribute("aria-label")).toContain("F8");
});

it("requires a new diff after changing keys during review", async () => {
  using _env = setup();
  await using screen = await renderConfig();
  await screen.click("Review changes");
  expect(screen.diff()).not.toBeNull();
  await screen.recordKeys("{Meta>}{F8}{/Meta}");
  expect(screen.diff()).toBeNull();
  expect(bridge.applySnapShotConfig).not.toHaveBeenCalled();
  const replacement = { ...preview, id: "replacement", shortcut: "Super+F8" };
  bridge.previewSnapShotConfig.mockResolvedValue(replacement);
  await screen.click("Review changes");
  expect(bridge.previewSnapShotConfig).toHaveBeenLastCalledWith({
    operation: "install",
    chooseFile: false,
    shortcut: "meta+f8",
  });
  await screen.click("Save shortcut");
  expect(bridge.applySnapShotConfig).toHaveBeenCalledExactlyOnceWith(replacement.id);
});

it.each(["Escape", "blur"])(
  "keeps the reviewed diff when recording is cancelled with %s",
  async (cancel) => {
    using _env = setup();
    await using screen = await renderConfig();
    await screen.click("Review changes");
    await act(async () => userEvent.click(screen.recorder()));
    expect(screen.button("Save shortcut")?.disabled).toBe(true);
    if (cancel === "Escape") await act(async () => userEvent.keyboard("{Escape}"));
    else await act(async () => screen.recorder().blur());
    expect(screen.button("Save shortcut")?.disabled).toBe(false);
    expect(bridge.previewSnapShotConfig).toHaveBeenCalledOnce();
    await screen.click("Save shortcut");
    expect(bridge.applySnapShotConfig).toHaveBeenCalledExactlyOnceWith(preview.id);
  },
);

it("cancelling a reviewed diff does not write or finish setup", async () => {
  using _env = setup();
  await using screen = await renderConfig();
  await screen.click("Review changes");
  await screen.click("Cancel");
  expect(screen.recorder().getAttribute("aria-label")).toBe(
    "Record snapshot shortcut, currently Ctrl+Shift+2",
  );
  expect(screen.button("Review changes")).toBeDefined();
  expect(bridge.applySnapShotConfig).not.toHaveBeenCalled();
  expect(complete).not.toHaveBeenCalled();
});

it("shows reading feedback until a proposal arrives", async () => {
  using _env = setup();
  const pending = deferred<DesktopCaptureConfigPreview>();
  bridge.previewSnapShotConfig.mockReturnValue(pending.promise);
  await using screen = await renderConfig();
  await screen.click("Review changes");
  expect(screen.button("Preparing changes…")?.disabled).toBe(true);
  await act(async () => pending.resolve(preview));
  expect(screen.button("Save shortcut")?.disabled).toBe(false);
});

it("keeps read failures actionable with technical details in Advanced, then permits retry", async () => {
  using _env = setup();
  bridge.previewSnapShotConfig.mockRejectedValueOnce(new Error("EACCES: /config/niri/config.kdl"));
  await using screen = await renderConfig();
  await screen.click("Review changes");
  expect(screen.alert()?.textContent).toBe(
    "Couldn't prepare the changes. Check Advanced for help.",
  );
  expect(screen.advanced().textContent).toContain("EACCES: /config/niri/config.kdl");
  await screen.click("Review changes");
  expect(screen.alert()).toBeNull();
  expect(screen.button("Save shortcut")?.disabled).toBe(false);
  expect(bridge.applySnapShotConfig).not.toHaveBeenCalled();
});

it("withdraws a stale diff and requires another read instead of retrying its write", async () => {
  using _env = setup();
  await using screen = await renderConfig();
  await screen.click("Review changes");
  bridge.applySnapShotConfig.mockRejectedValue(
    new Error("Your config changed since this preview."),
  );
  await screen.click("Save shortcut");
  expect(screen.alert()?.textContent).toContain("Review the changes and try again");
  expect(screen.advanced().textContent).toContain("Your config changed since this preview.");
  expect(screen.button("Review changes")).toBeDefined();
  expect(screen.diff()).toBeNull();
  expect(complete).not.toHaveBeenCalled();
});

it("does not finish or claim success when the desktop could not reload", async () => {
  using _env = setup();
  await using screen = await renderConfig();
  await screen.click("Review changes");
  bridge.applySnapShotConfig.mockResolvedValue({
    backupPath: "/config/backup",
    warning: "Config saved, but reload failed.",
  });
  await screen.click("Save shortcut");
  expect(screen.container.querySelector('[role="status"]')?.textContent).toBe(
    "Saved, but the shortcut needs attention. Check Advanced for help.",
  );
  expect(screen.advanced().textContent).toContain("Config saved, but reload failed.");
  expect(complete).not.toHaveBeenCalled();
  expect(toast).not.toHaveBeenCalled();
});
