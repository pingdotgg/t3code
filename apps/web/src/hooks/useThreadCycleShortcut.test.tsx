import type { ResolvedKeybindingsConfig } from "@t3tools/contracts";
import {
  DEFAULT_RESOLVED_KEYBINDINGS,
  compileResolvedKeybindingsConfig,
} from "@t3tools/shared/keybindings";
import { act, useEffect } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  order: "recent" as "recent" | "sidebar",
  paletteOpen: false,
  modelPickerOpen: false,
  navigate: vi.fn(),
}));
vi.mock("./useSettings", () => ({
  useClientSettings: (select: (settings: { threadCycleOrder: string }) => unknown) =>
    select({ threadCycleOrder: state.order }),
}));
vi.mock("../commandPaletteBus", () => ({ isCommandPaletteOpen: () => state.paletteOpen }));
vi.mock("../modelPickerVisibility", () => ({ isModelPickerOpen: () => state.modelPickerOpen }));
vi.mock("../lib/editableFocus", () => ({ isEditableFocused: () => true }));
vi.mock("../lib/previewFocus", () => ({ isPreviewFocused: () => false }));
vi.mock("../lib/terminalFocus", () => ({ isTerminalFocused: () => false }));

import { threadSwitcher } from "../threadSwitching";
import { useThreadCycleShortcut } from "./useThreadCycleShortcut";

const keys = ["local:a", "remote:a", "local:c"];
let renderer: ReactTestRenderer | undefined;
let controls: ReturnType<typeof useThreadCycleShortcut>;

class TestElement {
  closest() {
    return this;
  }
}

function Harness({
  current = "local:c",
  keybindings = DEFAULT_RESOLVED_KEYBINDINGS,
  threadKeys = keys,
}: {
  current?: string;
  keybindings?: ResolvedKeybindingsConfig;
  threadKeys?: readonly string[];
}) {
  const result = useThreadCycleShortcut({
    keybindings,
    threadKeys,
    currentThreadKey: current,
    terminalOpen: false,
    navigateToThread: state.navigate,
  });
  useEffect(() => {
    controls = result;
  }, [result]);
  return null;
}

function press(overrides: Partial<KeyboardEvent> = {}) {
  const { target, ...keys } = overrides;
  const event = Object.assign(new Event("keydown", { cancelable: true }), {
    key: "Tab",
    ctrlKey: true,
    shiftKey: false,
    altKey: false,
    metaKey: false,
    repeat: false,
    ...keys,
  });
  if (target) Object.defineProperty(event, "target", { value: target });
  act(() => window.dispatchEvent(event));
  return event;
}

function release(key = "Control") {
  act(() => window.dispatchEvent(Object.assign(new Event("keyup"), { key })));
}

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(state, { order: "recent", paletteOpen: false, modelPickerOpen: false });
  vi.stubGlobal("window", new EventTarget());
  vi.stubGlobal("navigator", { platform: "MacIntel" });
  vi.stubGlobal("HTMLElement", TestElement);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  threadSwitcher.cancel();
  keys.forEach((key) => threadSwitcher.visit(key));
});

afterEach(async () => {
  await act(() => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

describe("conversation cycle shortcut", () => {
  beforeEach(async () => {
    await act(() => {
      renderer = create(<Harness />);
    });
  });

  it("previews while Control is held and only navigates on release", () => {
    expect(press().defaultPrevented).toBe(true);
    expect(controls.preview?.selectedKey).toBe("remote:a");
    press();
    expect(controls.preview?.selectedKey).toBe("local:a");
    expect(state.navigate).not.toHaveBeenCalled();
    release("Tab");
    expect(state.navigate).not.toHaveBeenCalled();
    release();
    expect(state.navigate.mock.calls).toEqual([["local:a"]]);
    expect(controls.preview).toBeNull();
  });

  it("toggles with Control on macOS even before navigation finishes", () => {
    press();
    release();
    press();
    release();
    expect(state.navigate.mock.calls).toEqual([["remote:a"], ["local:c"]]);
    expect(press({ ctrlKey: false, metaKey: true }).defaultPrevented).toBe(false);
  });

  it("keeps a new gesture open when the previous navigation finishes", async () => {
    press();
    release();
    press();
    expect(controls.preview?.selectedKey).toBe("local:c");
    await act(() => renderer?.update(<Harness current="remote:a" />));
    expect(controls.preview?.selectedKey).toBe("local:c");
    press();
    expect(controls.preview?.selectedKey).toBe("local:a");
    release();
    expect(state.navigate.mock.calls).toEqual([["remote:a"], ["local:a"]]);
  });

  it("keeps previews stable through unrelated rerenders and returns to the original thread", async () => {
    press();
    await act(() => renderer?.update(<Harness threadKeys={keys.toReversed()} />));
    press();
    expect(controls.preview?.selectedKey).toBe("local:a");
    release();
    await act(() => renderer?.update(<Harness current="local:a" />));
    press();
    expect(controls.preview?.selectedKey).toBe("local:c");
    release();
    expect(state.navigate.mock.calls).toEqual([["local:a"], ["local:c"]]);
  });

  it("reverses with Shift without committing on Shift release", () => {
    press();
    press({ shiftKey: true });
    expect(controls.preview?.selectedKey).toBe("local:c");
    release("Shift");
    expect(state.navigate).not.toHaveBeenCalled();
    press();
    release();
    expect(state.navigate.mock.calls).toEqual([["remote:a"]]);
  });

  it("cancels on Escape and blur without changing recency", () => {
    press();
    press();
    expect(press({ key: "Escape" }).defaultPrevented).toBe(true);
    release();
    expect(controls.preview).toBeNull();
    press();
    expect(controls.preview?.selectedKey).toBe("remote:a");
    act(() => window.dispatchEvent(new Event("blur")));
    release();
    expect(controls.preview).toBeNull();
    expect(state.navigate).not.toHaveBeenCalled();
    press();
    release();
    expect(state.navigate.mock.calls).toEqual([["remote:a"]]);
  });

  it("cancels when another action or external navigation takes over", async () => {
    press();
    press({ key: "1" });
    release();
    expect(state.navigate).not.toHaveBeenCalled();
    press();
    await act(() => renderer?.update(<Harness current="local:a" />));
    release();
    expect(state.navigate).not.toHaveBeenCalled();
    press();
    release();
    expect(state.navigate.mock.calls).toEqual([["local:c"]]);
  });

  it("never navigates to a preview removed from the working list", async () => {
    press();
    await act(() => renderer?.update(<Harness threadKeys={["local:a", "local:c"]} />));
    release();
    expect(controls.preview).toBeNull();
    expect(state.navigate).not.toHaveBeenCalled();
  });

  it("switches immediately on every Chrome-style press without showing a preview", async () => {
    state.order = "sidebar";
    await act(() => renderer?.update(<Harness />));
    press();
    expect(state.navigate.mock.calls).toEqual([["local:a"]]);
    press();
    expect(state.navigate.mock.calls).toEqual([["local:a"], ["remote:a"]]);
    expect(controls.preview).toBeNull();
    release();
    expect(state.navigate).toHaveBeenCalledTimes(2);
    press({ shiftKey: true });
    expect(state.navigate).toHaveBeenLastCalledWith("local:a");
  });

  it("cancels an open preview when switching modes", async () => {
    press();
    state.order = "sidebar";
    await act(() => renderer?.update(<Harness />));
    release();
    expect(state.navigate).not.toHaveBeenCalled();
    expect(controls.preview).toBeNull();
    press();
    expect(state.navigate).toHaveBeenLastCalledWith("local:a");
  });

  it("respects remapped keys and releases their modifier", async () => {
    const keybindings = compileResolvedKeybindingsConfig([
      { key: "alt+q", command: "thread.cycleNext" },
    ]);
    await act(() => renderer?.update(<Harness keybindings={keybindings} />));
    expect(press().defaultPrevented).toBe(false);
    press({ key: "q", ctrlKey: false, altKey: true });
    release("Control");
    expect(state.navigate).not.toHaveBeenCalled();
    release("Alt");
    expect(state.navigate.mock.calls).toEqual([["remote:a"]]);
    press({ key: "q", ctrlKey: false, altKey: true });
    release("Alt");
    expect(state.navigate.mock.calls).toEqual([["remote:a"], ["local:c"]]);
  });

  it("navigates immediately for bindings without a held modifier", async () => {
    const keybindings = compileResolvedKeybindingsConfig([
      { key: "f6", command: "thread.cycleNext" },
    ]);
    await act(() => renderer?.update(<Harness keybindings={keybindings} />));
    press({ key: "F6", ctrlKey: false });
    expect(state.navigate.mock.calls).toEqual([["remote:a"]]);
    expect(controls.preview).toBeNull();
  });

  it.each([
    ["Control", "Alt"],
    ["Alt", "Control"],
    ["Control", "Meta"],
    ["Meta", "Control"],
  ])("keeps a multi-modifier preview open after %s until %s is released", async (first, last) => {
    const meta = first === "Meta" || last === "Meta";
    const keybindings = compileResolvedKeybindingsConfig([
      { key: meta ? "ctrl+meta+tab" : "ctrl+alt+tab", command: "thread.cycleNext" },
    ]);
    await act(() => renderer?.update(<Harness keybindings={keybindings} />));
    press({ altKey: !meta, metaKey: meta });
    expect(controls.preview?.selectedKey).toBe("remote:a");
    release(first);
    release("Shift");
    expect(state.navigate).not.toHaveBeenCalled();
    expect(controls.preview?.selectedKey).toBe("remote:a");
    press({
      key: "ArrowDown",
      ctrlKey: last === "Control",
      altKey: last === "Alt",
      metaKey: last === "Meta",
    });
    expect(controls.preview?.selectedKey).toBe("local:a");
    release(last);
    release(first);
    expect(state.navigate.mock.calls).toEqual([["local:a"]]);
    expect(controls.preview).toBeNull();
  });

  it("supports arrows and Enter in the preview, and choosing a card", () => {
    press();
    press({ key: "ArrowRight" });
    expect(controls.preview?.selectedKey).toBe("local:a");
    press({ key: "ArrowLeft" });
    press({ key: "Enter" });
    release();
    expect(state.navigate.mock.calls).toEqual([["remote:a"]]);
    press();
    act(() => controls.commit("local:a"));
    release();
    expect(state.navigate.mock.calls).toEqual([["remote:a"], ["local:a"]]);
  });

  it("leaves the chord to pickers, keybinding capture, and composition", () => {
    state.paletteOpen = true;
    expect(press().defaultPrevented).toBe(false);
    state.paletteOpen = false;
    state.modelPickerOpen = true;
    expect(press().defaultPrevented).toBe(false);
    state.modelPickerOpen = false;
    expect(press({ isComposing: true }).defaultPrevented).toBe(false);
    expect(press({ target: new TestElement() as unknown as HTMLElement }).defaultPrevented).toBe(
      false,
    );
    expect(state.navigate).not.toHaveBeenCalled();
    expect(controls.preview).toBeNull();
  });
});
