import {
  DEFAULT_CLIENT_SETTINGS,
  type DesktopCaptureConfigPreview,
  type DesktopSnapShotState,
} from "@t3tools/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { reactHookHarness as hooks } from "../../test/reactHookHarness";
import { visitElements } from "../../test/reactElementTree";

vi.mock("react", async (original) => {
  const actual = await original<typeof import("react")>();
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return {
    ...actual,
    useCallback: reactHookHarness.useCallback,
    useRef: reactHookHarness.useRef,
    useEffect: () => undefined,
    useMemo: reactHookHarness.useMemo,
    useState: reactHookHarness.useState,
  };
});
vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});
const bridge = vi.hoisted(() => ({
  previewSnapShotConfig: vi.fn(),
  applySnapShotConfig: vi.fn(),
  setSnapShotShortcutSuppressed: vi.fn(),
}));
vi.mock("../../lib/desktopSnapShot", () => ({ getDesktopSnapShotBridge: () => bridge }));
vi.mock("../../hooks/useTheme", () => ({ useTheme: () => ({ resolvedTheme: "light" }) }));
vi.mock("../../hooks/useCopyToClipboard", () => ({
  useCopyToClipboard: () => ({ copyToClipboard: vi.fn(), isCopied: false }),
}));
vi.mock("../ui/toast", () => ({ toastManager: { add: vi.fn() } }));
import { CaptureShortcutConfig } from "./CaptureShortcutConfig";
import { toastManager } from "../ui/toast";

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
function render(desktop: "niri" | "hyprland" = "niri") {
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
  hooks.beginRender();
  return CaptureShortcutConfig({ state, onComplete: complete });
}
function button(tree: ReturnType<typeof render>, label: string) {
  const node = visitElements(
    tree,
    (element) => element.props.children === label && typeof element.props.onClick === "function",
  );
  if (!node) throw new Error(`Missing button: ${label}`);
  return node.props as { onClick: () => void; disabled: boolean };
}
function shortcutInput(tree: ReturnType<typeof render>) {
  const node = visitElements(tree, (element) => "data-keybinding-capture" in element.props);
  if (!node) throw new Error("Missing shortcut recorder");
  return node.props as {
    "aria-label": string;
    onClick: () => void;
    onKeyDown: (event: object) => void;
    onBlur: () => void;
  };
}
async function recordKeys(desktop: "niri" | "hyprland", modifiers: object = {}) {
  shortcutInput(render(desktop)).onClick();
  await finish(bridge.setSnapShotShortcutSuppressed.mock.results.at(-1)!.value);
  shortcutInput(render(desktop)).onKeyDown({
    key: "y",
    code: "KeyY",
    ctrlKey: true,
    altKey: true,
    shiftKey: false,
    metaKey: false,
    repeat: false,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
    ...modifiers,
  });
}
async function finish(promise: Promise<unknown>) {
  await promise.catch(() => undefined);
  await Promise.resolve();
}
beforeEach(() => {
  hooks.reset();
  vi.stubGlobal("navigator", { platform: "Linux" });
  bridge.setSnapShotShortcutSuppressed.mockReset().mockResolvedValue(undefined);
  bridge.previewSnapShotConfig.mockReset().mockResolvedValue(preview);
  bridge.applySnapShotConfig
    .mockReset()
    .mockResolvedValue({ backupPath: "/config/backup", warning: null });
  complete.mockReset().mockResolvedValue(undefined);
  vi.mocked(toastManager.add).mockClear();
});
afterEach(() => vi.unstubAllGlobals());

it.each(["niri", "hyprland"] as const)(
  "shows the fallback before review and requires separate read and write approval on %s",
  async (desktop) => {
    let tree = render(desktop);
    expect(shortcutInput(tree)["aria-label"]).toBe(
      "Record snapshot shortcut, currently Ctrl+Shift+2",
    );
    expect(bridge.previewSnapShotConfig).not.toHaveBeenCalled();
    expect(bridge.applySnapShotConfig).not.toHaveBeenCalled();
    expect(visitElements(tree, (element) => element.type === "details")).not.toBeNull();
    button(tree, "Review changes").onClick();
    await finish(bridge.previewSnapShotConfig.mock.results[0]!.value);
    tree = render(desktop);
    expect(shortcutInput(tree)["aria-label"]).toBe(
      "Record snapshot shortcut, currently Ctrl+Shift+2",
    );
    expect(bridge.applySnapShotConfig).not.toHaveBeenCalled();
    const diff = visitElements(tree, (element) => "fileDiff" in element.props);
    expect(diff).not.toBeNull();
    expect(diff?.props.fileDiff).toMatchObject({ name: preview.path });
    button(tree, "Save shortcut").onClick();
    await finish(bridge.applySnapShotConfig.mock.results[0]!.value);
    expect(bridge.applySnapShotConfig).toHaveBeenCalledExactlyOnceWith(preview.id);
    expect(complete).toHaveBeenCalledOnce();
    expect(toastManager.add).toHaveBeenCalledWith(expect.objectContaining({ type: "success" }));
  },
);
it.each(["niri", "hyprland"] as const)(
  "lets users choose %s keys without opening Advanced, then approve the matching diff",
  async (desktop) => {
    const tree = render(desktop);
    const advanced = visitElements(tree, (element) => element.type === "details");
    expect(
      visitElements(advanced, (element) => "data-keybinding-capture" in element.props),
    ).toBeNull();
    await recordKeys(desktop);
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
    button(render(desktop), "Review changes").onClick();
    await finish(bridge.previewSnapShotConfig.mock.results[0]!.value);
    expect(bridge.previewSnapShotConfig).toHaveBeenCalledExactlyOnceWith({
      operation: "install",
      chooseFile: false,
      shortcut: "ctrl+alt+y",
    });
    expect(bridge.applySnapShotConfig).not.toHaveBeenCalled();
    button(render(desktop), "Save shortcut").onClick();
    await finish(bridge.applySnapShotConfig.mock.results[0]!.value);
    expect(bridge.applySnapShotConfig).toHaveBeenCalledExactlyOnceWith(custom.id);
    expect(toastManager.add).toHaveBeenCalledWith(
      expect.objectContaining({ description: "Use Ctrl+Alt+Y from another app." }),
    );
  },
);
it("uses the existing config keys when no replacement was chosen", async () => {
  bridge.previewSnapShotConfig.mockResolvedValue({ ...preview, shortcut: "Super+F8" });
  button(render(), "Review changes").onClick();
  await finish(bridge.previewSnapShotConfig.mock.results[0]!.value);
  expect(bridge.previewSnapShotConfig).toHaveBeenCalledExactlyOnceWith({
    operation: "install",
    chooseFile: false,
  });
  expect(shortcutInput(render())["aria-label"]).toContain("F8");
});
it("requires a new diff after changing keys during review", async () => {
  button(render(), "Review changes").onClick();
  await finish(bridge.previewSnapShotConfig.mock.results[0]!.value);
  await recordKeys("niri", { key: "F8", code: "F8", ctrlKey: false, altKey: false, metaKey: true });
  expect(visitElements(render(), (element) => "fileDiff" in element.props)).toBeNull();
  expect(bridge.applySnapShotConfig).not.toHaveBeenCalled();
  const replacement = { ...preview, id: "replacement", shortcut: "Super+F8" };
  bridge.previewSnapShotConfig.mockResolvedValue(replacement);
  button(render(), "Review changes").onClick();
  await finish(bridge.previewSnapShotConfig.mock.results[1]!.value);
  expect(bridge.previewSnapShotConfig).toHaveBeenLastCalledWith({
    operation: "install",
    chooseFile: false,
    shortcut: "meta+f8",
  });
  button(render(), "Save shortcut").onClick();
  await finish(bridge.applySnapShotConfig.mock.results[0]!.value);
  expect(bridge.applySnapShotConfig).toHaveBeenCalledExactlyOnceWith(replacement.id);
});
it.each(["Escape", "blur"])(
  "keeps the reviewed diff when recording is cancelled with %s",
  async (cancel) => {
    button(render(), "Review changes").onClick();
    await finish(bridge.previewSnapShotConfig.mock.results[0]!.value);
    shortcutInput(render()).onClick();
    await finish(bridge.setSnapShotShortcutSuppressed.mock.results.at(-1)!.value);
    expect(button(render(), "Save shortcut").disabled).toBe(true);
    if (cancel === "Escape")
      shortcutInput(render()).onKeyDown({
        key: "Escape",
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
      });
    else shortcutInput(render()).onBlur();
    expect(bridge.applySnapShotConfig).not.toHaveBeenCalled();
    expect(button(render(), "Save shortcut").disabled).toBe(false);
    expect(bridge.previewSnapShotConfig).toHaveBeenCalledOnce();
    button(render(), "Save shortcut").onClick();
    await finish(bridge.applySnapShotConfig.mock.results[0]!.value);
    expect(bridge.applySnapShotConfig).toHaveBeenCalledExactlyOnceWith(preview.id);
  },
);
it("cancelling a reviewed diff does not write or finish setup", async () => {
  button(render(), "Review changes").onClick();
  await finish(bridge.previewSnapShotConfig.mock.results[0]!.value);
  button(render(), "Cancel").onClick();
  expect(shortcutInput(render())["aria-label"]).toBe(
    "Record snapshot shortcut, currently Ctrl+Shift+2",
  );
  expect(button(render(), "Review changes")).toBeDefined();
  expect(bridge.applySnapShotConfig).not.toHaveBeenCalled();
  expect(complete).not.toHaveBeenCalled();
});
it("shows reading feedback until a proposal arrives", async () => {
  let resolvePreview!: (value: DesktopCaptureConfigPreview) => void;
  const pending = new Promise<DesktopCaptureConfigPreview>((resolve) => {
    resolvePreview = resolve;
  });
  bridge.previewSnapShotConfig.mockReturnValue(pending);
  button(render(), "Review changes").onClick();
  expect(button(render(), "Preparing changes…").disabled).toBe(true);
  expect(bridge.applySnapShotConfig).not.toHaveBeenCalled();
  resolvePreview(preview);
  await finish(pending);
  expect(button(render(), "Save shortcut").disabled).toBe(false);
});
it("keeps read failures actionable with technical details in Advanced, then permits retry", async () => {
  bridge.previewSnapShotConfig.mockRejectedValueOnce(new Error("EACCES: /config/niri/config.kdl"));
  button(render(), "Review changes").onClick();
  await finish(bridge.previewSnapShotConfig.mock.results[0]!.value);
  const failed = render();
  expect(visitElements(failed, (element) => element.props.role === "alert")?.props.children).toBe(
    "Couldn't prepare the changes. Check Advanced for help.",
  );
  const advanced = visitElements(failed, (element) => element.type === "details");
  expect(
    visitElements(
      advanced,
      (element) => element.props.children === "EACCES: /config/niri/config.kdl",
    ),
  ).not.toBeNull();
  expect(bridge.applySnapShotConfig).not.toHaveBeenCalled();
  button(failed, "Review changes").onClick();
  await finish(bridge.previewSnapShotConfig.mock.results[1]!.value);
  expect(visitElements(render(), (element) => element.props.role === "alert")).toBeNull();
  expect(button(render(), "Save shortcut").disabled).toBe(false);
  expect(bridge.applySnapShotConfig).not.toHaveBeenCalled();
});
it("withdraws a stale diff and requires another read instead of retrying its write", async () => {
  button(render(), "Review changes").onClick();
  await finish(bridge.previewSnapShotConfig.mock.results[0]!.value);
  bridge.applySnapShotConfig.mockRejectedValue(
    new Error("Your config changed since this preview."),
  );
  button(render(), "Save shortcut").onClick();
  await finish(bridge.applySnapShotConfig.mock.results[0]!.value);
  const tree = render();
  expect(
    visitElements(tree, (element) => element.props.role === "alert")?.props.children,
  ).toContain("Review the changes and try again");
  const advanced = visitElements(tree, (element) => element.type === "details");
  expect(
    visitElements(
      advanced,
      (element) => element.props.children === "Your config changed since this preview.",
    ),
  ).not.toBeNull();
  expect(button(tree, "Review changes")).toBeDefined();
  expect(visitElements(tree, (element) => "fileDiff" in element.props)).toBeNull();
  expect(complete).not.toHaveBeenCalled();
});
it("does not finish or claim success when the desktop could not reload", async () => {
  button(render(), "Review changes").onClick();
  await finish(bridge.previewSnapShotConfig.mock.results[0]!.value);
  bridge.applySnapShotConfig.mockResolvedValue({
    backupPath: "/config/backup",
    warning: "Config saved, but reload failed.",
  });
  button(render(), "Save shortcut").onClick();
  await finish(bridge.applySnapShotConfig.mock.results[0]!.value);
  expect(
    visitElements(render(), (element) => element.props.role === "status")?.props.children,
  ).toBe("Saved, but the shortcut needs attention. Check Advanced for help.");
  const advanced = visitElements(render(), (element) => element.type === "details");
  expect(
    visitElements(
      advanced,
      (element) => element.props.children === "Config saved, but reload failed.",
    ),
  ).not.toBeNull();
  expect(complete).not.toHaveBeenCalled();
  expect(toastManager.add).not.toHaveBeenCalled();
});
