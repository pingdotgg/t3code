// @vitest-environment jsdom
import { act, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const harness = vi.hoisted(() => ({
  platform: "android",
  listeners: new Set<(state: string) => void>(),
}));

vi.mock("react-native", () => ({
  Platform: {
    get OS() {
      return harness.platform;
    },
  },
  AppState: {
    addEventListener: (_event: "change", listener: (state: string) => void) => {
      harness.listeners.add(listener);
      return { remove: () => harness.listeners.delete(listener) };
    },
  },
}));

import { useKeyboardResumeGuard } from "./use-keyboard-resume-guard";

let root: Root;
let guard: ReturnType<typeof useKeyboardResumeGuard>;

function Probe(props: { visible: boolean; height: number }) {
  const state = useKeyboardResumeGuard(props.visible, props.height);
  useLayoutEffect(() => {
    guard = state;
  });
  return <div>{state.keyboardStateSuspect ? "resting" : "following keyboard"}</div>;
}

function render(visible = true, height = 320) {
  act(() => root.render(<Probe visible={visible} height={height} />));
}

function appState(state: string) {
  act(() => {
    for (const listener of harness.listeners) listener(state);
  });
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  harness.platform = "android";
  root = createRoot(document.createElement("div"));
});

afterEach(() => {
  act(() => root.unmount());
  expect(harness.listeners.size).toBe(0);
});

describe("useKeyboardResumeGuard", () => {
  it("keeps following an open keyboard after switching apps without a new focus or height event", () => {
    render();
    act(() => guard.onInputFocusChange(true));
    appState("background");
    appState("active");
    expect(guard.keyboardStateSuspect).toBe(false);
  });

  it("ignores stale open-keyboard state after sending and backgrounding during dismissal", () => {
    render();
    act(() => guard.onInputFocusChange(true));
    act(() => guard.onInputFocusChange(false));
    appState("background");
    appState("active");
    expect(guard.keyboardStateSuspect).toBe(true);
    render();
    expect(guard.keyboardStateSuspect).toBe(true);
  });

  it("resumes following the keyboard when an owned input is focused again", () => {
    render();
    appState("background");
    appState("active");
    expect(guard.keyboardStateSuspect).toBe(true);
    act(() => guard.onInputFocusChange(true));
    expect(guard.keyboardStateSuspect).toBe(false);
  });

  it("accepts a keyboard height update after returning with no focused input", () => {
    render();
    appState("background");
    appState("active");
    render(true, 340);
    expect(guard.keyboardStateSuspect).toBe(false);
  });

  it("accepts a keyboard hide event even if its reported height did not change", () => {
    render();
    appState("background");
    appState("active");
    render(false, 320);
    expect(guard.keyboardStateSuspect).toBe(false);
  });

  it("leaves iOS keyboard transitions enabled across app switches", () => {
    harness.platform = "ios";
    render();
    appState("background");
    appState("active");
    expect(guard.keyboardStateSuspect).toBe(false);
  });
});
