// @vitest-environment jsdom
import { act, useEffect, useLayoutEffect, useSyncExternalStore } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const harness = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  const appStateListeners = new Set<(state: string) => void>();
  const state = { focused: true, appState: "active" };
  return {
    state,
    appStateListeners,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setFocused(focused: boolean) {
      state.focused = focused;
      for (const listener of listeners) listener();
    },
    setAppState(next: string) {
      state.appState = next;
      for (const listener of appStateListeners) listener(next);
    },
  };
});

vi.mock("@react-navigation/native", () => ({
  useIsFocused: () => useSyncExternalStore(harness.subscribe, () => harness.state.focused),
}));
vi.mock("react-native", () => ({
  AppState: {
    get currentState() {
      return harness.state.appState;
    },
    addEventListener: (_event: "change", listener: (state: string) => void) => {
      harness.appStateListeners.add(listener);
      return { remove: () => harness.appStateListeners.delete(listener) };
    },
  },
}));

import { useVisibleSecondClock } from "./use-visible-second-clock";

const START_MS = Date.UTC(2026, 9, 3, 12, 0, 0);
let root: Root | null = null;
// Clock value of every committed render, the work a tick costs on device.
let renders: number[] = [];

function Probe(props: { readonly enabled: boolean }) {
  const nowMs = useVisibleSecondClock(props.enabled);
  useEffect(() => {
    renders.push(nowMs);
  });
  return null;
}

function mount(enabled: boolean) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  root = createRoot(document.createElement("div"));
  act(() => root!.render(<Probe enabled={enabled} />));
}

// One act per second, so each tick commits its own render as it would on device.
function advance(ms: number) {
  for (let elapsed = 0; elapsed < ms; elapsed += 1_000) {
    act(() => vi.advanceTimersByTime(Math.min(1_000, ms - elapsed)));
  }
}

function latest() {
  return renders.at(-1);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(START_MS);
  harness.state.focused = true;
  harness.state.appState = "active";
  renders = [];
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  vi.useRealTimers();
});

describe("useVisibleSecondClock", () => {
  it("ticks once a second while enabled, focused and active", () => {
    mount(true);
    const before = renders.length;
    advance(60_000);
    expect(renders.length - before).toBe(60);
    expect(latest()).toBe(START_MS + 60_000);
  });

  it("does not wake while the app is in the background", () => {
    harness.state.appState = "background";
    mount(true);
    const before = renders.length;
    advance(60_000);
    expect(renders.length - before).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not wake while the screen is unfocused", () => {
    harness.state.focused = false;
    mount(true);
    const before = renders.length;
    advance(60_000);
    expect(renders.length - before).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not wake when disabled, even when visible", () => {
    mount(false);
    const before = renders.length;
    advance(60_000);
    expect(renders.length - before).toBe(0);
  });

  it("notices an AppState change between first render and subscribing", () => {
    // Layout effects run before the hook's passive subscription, so this change has no listener.
    function BackgroundBeforeSubscribe() {
      useLayoutEffect(() => harness.setAppState("background"), []);
      return null;
    }
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    root = createRoot(document.createElement("div"));
    act(() =>
      root!.render(
        <>
          <BackgroundBeforeSubscribe />
          <Probe enabled />
        </>,
      ),
    );
    const before = renders.length;
    advance(60_000);
    expect(renders.length - before).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("pauses on blur and shows wall-clock elapsed time the moment it refocuses", () => {
    mount(true);
    advance(5_000);
    act(() => harness.setFocused(false));
    const paused = renders.length;
    advance(120_000);
    expect(renders.length).toBe(paused);

    act(() => harness.setFocused(true));
    expect(latest()).toBe(START_MS + 125_000);
    advance(1_000);
    expect(latest()).toBe(START_MS + 126_000);
  });

  it("pauses while backgrounded and catches up on the first active render", () => {
    mount(true);
    act(() => harness.setAppState("background"));
    const paused = renders.length;
    advance(600_000);
    expect(renders.length).toBe(paused);
    expect(vi.getTimerCount()).toBe(0);

    act(() => harness.setAppState("inactive"));
    advance(10_000);
    expect(renders.length).toBe(paused);

    act(() => harness.setAppState("active"));
    expect(latest()).toBe(START_MS + 610_000);
    const resumed = renders.length;
    advance(60_000);
    expect(renders.length - resumed).toBe(60);
  });

  it("stops when the work it measures settles and refreshes when new work starts", () => {
    mount(true);
    advance(3_000);
    act(() => root!.render(<Probe enabled={false} />));
    const settled = renders.length;
    advance(60_000);
    expect(renders.length).toBe(settled);

    act(() => root!.render(<Probe enabled />));
    expect(latest()).toBe(START_MS + 63_000);
  });

  it("clears its interval and AppState subscription on unmount", () => {
    mount(true);
    expect(vi.getTimerCount()).toBe(1);
    expect(harness.appStateListeners.size).toBe(1);
    act(() => root!.unmount());
    root = null;
    expect(vi.getTimerCount()).toBe(0);
    expect(harness.appStateListeners.size).toBe(0);
  });
});
