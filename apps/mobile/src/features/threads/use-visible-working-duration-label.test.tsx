import {
  NavigationContext,
  type NavigationProp,
  type ParamListBase,
} from "@react-navigation/native";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

const native = vi.hoisted(() => ({
  appState: {
    currentState: "active",
    listeners: new Set<(state: string) => void>(),
    addEventListener(_event: string, listener: (state: string) => void) {
      native.appState.listeners.add(listener);
      return { remove: () => native.appState.listeners.delete(listener) };
    },
  },
}));

vi.mock("react-native", () => ({ AppState: native.appState }));
vi.mock("@react-navigation/native", async () => {
  const { createRequire } = await import("node:module");
  const requireNavigation = createRequire(
    createRequire(import.meta.url).resolve("@react-navigation/native/package.json"),
  );
  // Exercise the real focus subscription without loading native navigation views.
  const { NavigationContext, useIsFocused } = requireNavigation("@react-navigation/core");
  return { NavigationContext, useIsFocused };
});

import { useVisibleWorkingDurationLabel } from "./use-visible-working-duration-label";

const timestamp = (ms: number) => new Date(ms).toISOString();

function setup(startedAt: string | null, nowMs = 0, active = true, focusedInitially = true) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  vi.setSystemTime(nowMs);
  native.appState.currentState = active ? "active" : "background";
  native.appState.listeners.clear();
  let focused = focusedInitially;
  const focusListeners = new Set<() => void>();
  const navigation = {
    isFocused: () => focused,
    addListener: (_event: string, listener: () => void) => {
      focusListeners.add(listener);
      return () => focusListeners.delete(listener);
    },
  } as unknown as NavigationProp<ParamListBase>;
  let executions = 0;
  const starts = [{ id: "first", value: startedAt }];
  function Probe(props: { readonly startedAt: string | null }) {
    executions++;
    return useVisibleWorkingDurationLabel(props.startedAt);
  }
  const host = document.createElement("div");
  const root = createRoot(host);
  const render = (start: string | null) => {
    starts[0]!.value = start;
    act(() =>
      root.render(
        <NavigationContext.Provider value={navigation}>
          {starts.map(({ id, value }) => (
            <span key={id}>
              <Probe startedAt={value} />
            </span>
          ))}
        </NavigationContext.Provider>,
      ),
    );
  };
  render(startedAt);
  return {
    label: () => host.textContent,
    labels: () => Array.from(host.children, (element) => element.textContent),
    addLabel: (start: string | null) => {
      starts.push({ id: `label-${starts.length}`, value: start });
      render(starts[0]!.value);
    },
    executions: () => executions,
    rebind: render,
    advance: (ms: number) => act(() => vi.advanceTimersByTime(ms)),
    focus: (next: boolean) =>
      act(() => {
        focused = next;
        for (const listener of focusListeners) listener();
      }),
    appState: (state: string) =>
      act(() => {
        native.appState.currentState = state;
        for (const listener of native.appState.listeners) listener(state);
      }),
    [Symbol.dispose]: () => {
      act(() => root.unmount());
      expect(vi.getTimerCount()).toBe(0);
      expect(native.appState.listeners.size).toBe(0);
      expect(focusListeners.size).toBe(0);
      vi.useRealTimers();
    },
  };
}

it("publishes only the two label changes across 120 individually delivered minute-age ticks", () => {
  using screen = setup(timestamp(0), 180_000);
  const initialExecutions = screen.executions();
  const labels = [screen.label()];
  for (let second = 1; second <= 120; second++) {
    screen.advance(1_000);
    labels.push(screen.label());
  }
  expect(labels).toEqual([
    ...Array.from({ length: 60 }, () => " 3m"),
    ...Array.from({ length: 60 }, () => " 4m"),
    " 5m",
  ]);
  expect(screen.executions() - initialExecutions).toBe(2);
  expect(vi.getTimerCount()).toBe(1);
});

it("keeps second labels and on-phase minute and hour boundaries", () => {
  using screen = setup(timestamp(0), 58_000);
  screen.advance(1_000);
  expect(screen.label()).toBe(" 59s");
  screen.advance(999);
  expect(screen.label()).toBe(" 59s");
  screen.advance(1);
  expect(screen.label()).toBe(" 1m");
  screen.rebind(timestamp(-60_000));
  expect(screen.label()).toBe(" 2m");
  screen.rebind(timestamp(-3_539_000));
  expect(screen.label()).toBe(" 59m");
  screen.advance(1_000);
  expect(screen.label()).toBe(" 1h 0m");
});

it.each([
  [59_999, " 59s", " 1m"],
  [119_999, " 1m", " 2m"],
  [3_599_999, " 59m", " 1h 0m"],
] as const)("matches the shared wall-clock boundary across age %i", (age, before, after) => {
  using screen = setup(timestamp(0), age);
  expect(screen.label()).toBe(before);
  screen.advance(1);
  expect(screen.label()).toBe(after);
});

it("uses the shared second sample for off-grid and rebound starts", () => {
  using screen = setup(timestamp(500), 180_250);
  expect(screen.label()).toBe(" 2m");
  screen.advance(749);
  expect(screen.label()).toBe(" 2m");
  screen.advance(1);
  expect(screen.label()).toBe(" 3m");
  screen.advance(600);
  screen.rebind(timestamp(121_500));
  expect(screen.label()).toBe(" 59s");
  screen.advance(399);
  expect(screen.label()).toBe(" 59s");
  screen.advance(1);
  expect(screen.label()).toBe(" 1m");
  expect(vi.getTimerCount()).toBe(1);
});

it("shares one aligned timer across staggered labels and releases it when all pause", () => {
  using screen = setup(timestamp(0), 59_250);
  screen.advance(250);
  screen.addLabel(timestamp(0));
  screen.advance(250);
  screen.addLabel(timestamp(0));
  expect(screen.labels()).toEqual([" 59s", " 59s", " 59s"]);
  expect(vi.getTimerCount()).toBe(1);
  screen.advance(249);
  expect(screen.labels()).toEqual([" 59s", " 59s", " 59s"]);
  screen.advance(1);
  expect(screen.labels()).toEqual([" 1m", " 1m", " 1m"]);
  screen.focus(false);
  expect(vi.getTimerCount()).toBe(0);
  screen.advance(60_000);
  expect(screen.labels()).toEqual([" 1m", " 1m", " 1m"]);
  screen.focus(true);
  expect(screen.labels()).toEqual([" 2m", " 2m", " 2m"]);
  expect(vi.getTimerCount()).toBe(1);
});

it.each([null, "", "invalid"])("does not tick for missing/invalid start %s", (start) => {
  using screen = setup(start, 180_000);
  expect(screen.label()).toBe("");
  expect(vi.getTimerCount()).toBe(0);
  screen.advance(15_000);
  screen.rebind(timestamp(0));
  expect(screen.label()).toBe(" 3m");
  expect(vi.getTimerCount()).toBe(1);
  screen.rebind(start);
  expect(screen.label()).toBe("");
  expect(vi.getTimerCount()).toBe(0);
});

it("clamps future starts without publishing equal zero labels", () => {
  using screen = setup(timestamp(2_000));
  const initialExecutions = screen.executions();
  screen.advance(1_000);
  screen.advance(1_000);
  expect(screen.label()).toBe(" 0s");
  expect(screen.executions()).toBe(initialExecutions);
  screen.advance(1_000);
  expect(screen.label()).toBe(" 1s");
});

it("pauses on blur, reads the shared sample on rebinding, and refreshes on focus", () => {
  using screen = setup(timestamp(0), 59_250);
  screen.advance(350);
  screen.focus(false);
  expect(vi.getTimerCount()).toBe(0);
  const pausedExecutions = screen.executions();
  screen.advance(60_000);
  expect(screen.label()).toBe(" 59s");
  expect(screen.executions()).toBe(pausedExecutions);
  screen.rebind(timestamp(-1_000));
  expect(screen.label()).toBe(" 2m");
  screen.focus(true);
  expect(screen.label()).toBe(" 2m");
  screen.rebind(timestamp(60_000));
  expect(screen.label()).toBe(" 59s");
  screen.advance(399);
  expect(screen.label()).toBe(" 59s");
  screen.advance(1);
  expect(screen.label()).toBe(" 1m");
});

it.each(["inactive", "background"])(
  "pauses while %s and refreshes immediately on active",
  (state) => {
    using screen = setup(timestamp(0), 59_250);
    screen.appState(state);
    expect(vi.getTimerCount()).toBe(0);
    screen.advance(61_000);
    expect(screen.label()).toBe(" 59s");
    screen.appState("active");
    expect(screen.label()).toBe(" 2m");
    expect(vi.getTimerCount()).toBe(1);
    screen.focus(false);
    screen.appState("background");
    screen.advance(60_000);
    screen.appState("active");
    expect(vi.getTimerCount()).toBe(0);
    expect(screen.label()).toBe(" 3m");
    screen.focus(true);
    expect(screen.label()).toBe(" 3m");
  },
);

it.each([
  [false, true],
  [true, false],
] as const)("starts paused when active=%s focused=%s", (active, focused) => {
  using screen = setup(timestamp(0), 59_000, active, focused);
  expect(screen.label()).toBe(" 59s");
  expect(vi.getTimerCount()).toBe(0);
  screen.advance(61_000);
  screen.appState("active");
  screen.focus(true);
  expect(screen.label()).toBe(" 2m");
  expect(vi.getTimerCount()).toBe(1);
});
