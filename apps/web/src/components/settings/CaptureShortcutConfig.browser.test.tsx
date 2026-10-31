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
      await userEvent.click(recorder());
      await userEvent.keyboard(keys);
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
