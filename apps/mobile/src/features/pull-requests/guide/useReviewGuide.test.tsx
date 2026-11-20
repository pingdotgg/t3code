import {
  NavigationContext,
  type NavigationProp,
  type ParamListBase,
} from "@react-navigation/native";
import { AsyncResult } from "effect/reactivity";
import { act, useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  enabled: true,
  generate: vi.fn(),
  query: {
    data: null as { run: { _tag: "Running" | "Completed" | "Failed" } | null } | null,
    isPending: false,
    refresh: vi.fn<() => void>(),
  },
  otherQuery: {
    data: null as { run: { _tag: "Running" | "Completed" | "Failed" } | null } | null,
    isPending: false,
    refresh: vi.fn<() => void>(),
  },
}));

vi.mock("@react-navigation/native", async () => {
  const { createRequire } = await import("node:module");
  const { realpathSync } = await import("node:fs");
  const require = createRequire(import.meta.url);
  const nativeRequire = createRequire(
    realpathSync(require.resolve("@react-navigation/native/package.json")),
  );
  // Use the shipped focus hook without importing the React Native view layer.
  const { NavigationContext, useFocusEffect }: typeof import("@react-navigation/native") =
    nativeRequire("@react-navigation/core");
  return { NavigationContext, useFocusEffect };
});
vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: unknown) =>
    atom === "settings" ? { reviewGuidesEnabled: mocks.enabled } : true,
}));
vi.mock("../../../state/server", () => ({
  serverEnvironment: { settingsValueAtom: () => "settings" },
}));
vi.mock("../../../state/pull-requests", () => ({
  composerPullRequests: {
    reviewGuide: (target: { number: number; environmentId: string }) =>
      target.environmentId === "environment" && target.number === 1 ? 1 : 2,
    generateReviewGuide: { permissionAtom: () => "permission" },
  },
}));
vi.mock("../../../state/query", () => ({
  useEnvironmentQuery: (number: number) => ({ ...(number === 1 ? mocks.query : mocks.otherQuery) }),
}));
vi.mock("../../../state/use-atom-command", () => ({ useAtomCommand: () => mocks.generate }));
vi.mock("../usePullRequestConnected", () => ({ usePullRequestConnected: () => true }));
vi.mock("../usePullRequestDiff", () => ({
  pullRequestTarget: (params: unknown) => params,
}));

import { useReviewGuide } from "./useReviewGuide";

function createNavigation() {
  const listeners = { focus: new Set<() => void>(), blur: new Set<() => void>() };
  let focused = true;
  return {
    value: {
      isFocused: () => focused,
      addListener: (event: keyof typeof listeners, listener: () => void) => {
        listeners[event].add(listener);
        return () => listeners[event].delete(listener);
      },
    } as unknown as NavigationProp<ParamListBase>,
    focus(next: boolean) {
      focused = next;
      act(() => {
        for (const listener of listeners[next ? "focus" : "blur"]) listener();
      });
    },
  };
}

function setup() {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.enabled = true;
  mocks.generate = vi.fn().mockResolvedValue(AsyncResult.success(undefined));
  mocks.query = { data: null, isPending: false, refresh: vi.fn() };
  mocks.otherQuery = { data: null, isPending: false, refresh: vi.fn() };
  const root = createRoot(document.createElement("div"));
  const navigation = createNavigation();
  const params = {
    environmentId: "environment",
    projectId: "project",
    repository: "repo",
    number: 1,
  };
  let current: ReturnType<typeof useReviewGuide>;
  function Probe({
    number,
    environmentId,
    visible,
  }: {
    number: number;
    environmentId: string;
    visible?: boolean;
  }) {
    const state = useReviewGuide({ ...params, number, environmentId }, visible);
    useLayoutEffect(() => {
      current = state;
    });
    return null;
  }
  return {
    render(number = 1, environmentId = params.environmentId, visible?: boolean) {
      act(() =>
        root.render(
          <NavigationContext.Provider value={navigation.value}>
            <Probe number={number} environmentId={environmentId} visible={visible} />
          </NavigationContext.Provider>,
        ),
      );
    },
    get current() {
      return current;
    },
    focus: navigation.focus,
    [Symbol.dispose]() {
      act(() => root.unmount());
    },
  };
}

it("refreshes on focus and PR changes without refreshing again for query rerenders", () => {
  using screen = setup();
  screen.render();
  expect(mocks.query.refresh).toHaveBeenCalledTimes(1);

  mocks.query = { ...mocks.query, isPending: true };
  screen.render();
  mocks.query = { ...mocks.query, isPending: false, data: { run: { _tag: "Completed" } } };
  screen.render();
  expect(mocks.query.refresh).toHaveBeenCalledTimes(1);

  screen.focus(false);
  screen.render();
  expect(mocks.query.refresh).toHaveBeenCalledTimes(1);
  screen.focus(true);
  expect(mocks.query.refresh).toHaveBeenCalledTimes(2);

  screen.render(2);
  expect(mocks.otherQuery.refresh).toHaveBeenCalledTimes(1);
  screen.render(2);
  expect(mocks.otherQuery.refresh).toHaveBeenCalledTimes(1);
  expect(mocks.query.refresh).toHaveBeenCalledTimes(2);
});

it("preserves the polling deadline across rerenders and stops polling on blur or completion", () => {
  vi.useFakeTimers();
  using _timers = { [Symbol.dispose]: () => vi.useRealTimers() };
  using screen = setup();
  mocks.query.data = { run: { _tag: "Running" } };
  screen.render();
  expect(mocks.query.refresh).toHaveBeenCalledTimes(1);

  act(() => vi.advanceTimersByTime(4_000));
  mocks.query = { ...mocks.query, isPending: true, data: { run: { _tag: "Running" } } };
  screen.render();
  expect(mocks.query.refresh).toHaveBeenCalledTimes(1);
  act(() => vi.advanceTimersByTime(1_000));
  expect(mocks.query.refresh).toHaveBeenCalledTimes(2);

  screen.focus(false);
  act(() => vi.advanceTimersByTime(10_000));
  expect(mocks.query.refresh).toHaveBeenCalledTimes(2);
  screen.focus(true);
  expect(mocks.query.refresh).toHaveBeenCalledTimes(3);
  act(() => vi.advanceTimersByTime(5_000));
  expect(mocks.query.refresh).toHaveBeenCalledTimes(4);

  mocks.query = { ...mocks.query, isPending: false, data: { run: { _tag: "Completed" } } };
  screen.render();
  const refreshesOnCompletion = mocks.query.refresh.mock.calls.length;
  act(() => vi.advanceTimersByTime(10_000));
  expect(mocks.query.refresh).toHaveBeenCalledTimes(refreshesOnCompletion);
});

it("retires the old environment's polling on target change and clears polling on unmount", () => {
  vi.useFakeTimers();
  using _timers = { [Symbol.dispose]: () => vi.useRealTimers() };
  {
    using screen = setup();
    mocks.query.data = { run: { _tag: "Running" } };
    mocks.otherQuery.data = { run: { _tag: "Running" } };
    screen.render();
    act(() => vi.advanceTimersByTime(4_000));

    screen.render(1, "other-environment");
    expect(mocks.query.refresh).toHaveBeenCalledTimes(1);
    expect(mocks.otherQuery.refresh).toHaveBeenCalledTimes(1);
    act(() => vi.advanceTimersByTime(1_000));
    expect(mocks.query.refresh).toHaveBeenCalledTimes(1);
    expect(mocks.otherQuery.refresh).toHaveBeenCalledTimes(1);
    act(() => vi.advanceTimersByTime(4_000));
    expect(mocks.query.refresh).toHaveBeenCalledTimes(1);
    expect(mocks.otherQuery.refresh).toHaveBeenCalledTimes(2);
  }
  act(() => vi.advanceTimersByTime(10_000));
  expect(mocks.query.refresh).toHaveBeenCalledTimes(1);
  expect(mocks.otherQuery.refresh).toHaveBeenCalledTimes(2);
  expect(vi.getTimerCount()).toBe(0);
});

it("suspends only manual refresh while hidden, including focus and target changes", () => {
  vi.useFakeTimers();
  using _timers = { [Symbol.dispose]: () => vi.useRealTimers() };
  {
    using screen = setup();
    mocks.query.data = { run: { _tag: "Running" } };
    mocks.otherQuery.data = { run: { _tag: "Running" } };
    screen.render();
    const cached = screen.current.data;
    screen.render(1, "environment", false);
    act(() => vi.advanceTimersByTime(60_000));
    expect(mocks.query.refresh).toHaveBeenCalledTimes(1);
    expect(screen.current.data).toBe(cached);
    screen.render();
    expect(mocks.query.refresh).toHaveBeenCalledTimes(2);
    act(() => vi.advanceTimersByTime(5_000));
    expect(mocks.query.refresh).toHaveBeenCalledTimes(3);
    screen.render(1, "environment", false);
    screen.focus(false);
    screen.focus(true);
    expect(mocks.query.refresh).toHaveBeenCalledTimes(3);

    screen.render(2, "other-environment", false);
    act(() => vi.advanceTimersByTime(5_000));
    expect(mocks.otherQuery.refresh).not.toHaveBeenCalled();
    screen.focus(false);
    screen.render(2, "other-environment", true);
    expect(mocks.otherQuery.refresh).not.toHaveBeenCalled();
    screen.focus(true);
    expect(mocks.otherQuery.refresh).toHaveBeenCalledTimes(1);
    act(() => vi.advanceTimersByTime(5_000));
    expect(mocks.otherQuery.refresh).toHaveBeenCalledTimes(2);
    expect(mocks.query.refresh).toHaveBeenCalledTimes(3);
  }
  expect(vi.getTimerCount()).toBe(0);
});

it("keeps disabled, completed and failed guides idle and refreshes once on reveal", () => {
  vi.useFakeTimers();
  using _timers = { [Symbol.dispose]: () => vi.useRealTimers() };
  using screen = setup();
  mocks.enabled = false;
  screen.render();
  act(() => vi.advanceTimersByTime(5_000));
  expect(mocks.query.refresh).not.toHaveBeenCalled();
  mocks.enabled = true;
  mocks.query.data = { run: null };
  screen.render();
  expect(mocks.query.refresh).toHaveBeenCalledTimes(1);
  act(() => vi.advanceTimersByTime(10_000));
  expect(mocks.query.refresh).toHaveBeenCalledTimes(1);
  screen.render(1, "environment", false);
  mocks.query.data = { run: { _tag: "Failed" } };
  screen.render(1, "environment", false);
  expect(mocks.query.refresh).toHaveBeenCalledTimes(1);
  screen.render();
  expect(mocks.query.refresh).toHaveBeenCalledTimes(2);
  act(() => vi.advanceTimersByTime(10_000));
  expect(mocks.query.refresh).toHaveBeenCalledTimes(2);
  expect(vi.getTimerCount()).toBe(0);
});

it("leaves generation running when hidden and accepts its completion without a refresh", async () => {
  vi.useFakeTimers();
  using _timers = { [Symbol.dispose]: () => vi.useRealTimers() };
  using screen = setup();
  const generated = Promise.withResolvers<ReturnType<typeof AsyncResult.success<void>>>();
  mocks.generate.mockReturnValue(generated.promise);
  screen.render();
  let writing: Promise<void>;
  act(() => {
    writing = screen.current.write();
  });
  expect(screen.current.running).toBe(true);
  screen.render(1, "environment", false);
  const beforeHidden = mocks.query.refresh.mock.calls.length;
  act(() => vi.advanceTimersByTime(60_000));
  expect(mocks.query.refresh).toHaveBeenCalledTimes(beforeHidden);
  expect(mocks.generate).toHaveBeenCalledTimes(1);
  expect(screen.current.running).toBe(true);
  await act(async () => {
    generated.resolve(AsyncResult.success(undefined));
    await writing;
  });
  expect(screen.current.running).toBe(false);
  expect(mocks.query.refresh).toHaveBeenCalledTimes(beforeHidden);
  screen.render();
  expect(mocks.query.refresh).toHaveBeenCalledTimes(beforeHidden + 1);
  expect(vi.getTimerCount()).toBe(0);
});
