import * as NodeModule from "node:module";
import { act, useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

const harness = vi.hoisted(() => ({ navigation: undefined as unknown }));

vi.mock("@react-navigation/native", async () => {
  const { createRequire } = await import("node:module");
  const requireNavigation = createRequire(
    createRequire(import.meta.url).resolve("@react-navigation/native/package.json"),
  );
  return {
    StackActions: requireNavigation("@react-navigation/routers").StackActions,
    useNavigation: () => harness.navigation,
  };
});

import { useTerminalExitNavigation } from "./useTerminalExitNavigation";

const requireNavigation = NodeModule.createRequire(
  NodeModule.createRequire(import.meta.url).resolve("@react-navigation/native/package.json"),
);
const { StackRouter, StackActions, CommonActions } = requireNavigation(
  "@react-navigation/routers",
) as {
  StackRouter: typeof import("@react-navigation/native").StackRouter;
  StackActions: typeof import("@react-navigation/native").StackActions;
  CommonActions: typeof import("@react-navigation/native").CommonActions;
};

type Action = Parameters<ReturnType<typeof StackRouter>["getStateForAction"]>[1];

function setup(fallbackTerminalId: string | null) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const router = StackRouter({});
  const options = {
    routeNames: ["Thread", "ThreadTerminal", "ThreadFiles"],
    routeParamList: {},
    routeGetIdList: {},
  };
  let state = router.getInitialState(options);
  const apply = (action: Action) => {
    const next = router.getStateForAction(state, action, options);
    if (!next) throw new Error(`Rejected ${action.type}`);
    state = router.getRehydratedState(next, options);
  };
  const thread = { environmentId: "environment", threadId: "thread" };
  apply(StackActions.replace("Thread", thread));
  apply(StackActions.push("ThreadTerminal", { ...thread, terminalId: "second" }));
  const terminalKey = state.routes.at(-1)!.key;
  const focusListeners = new Set<() => void>();
  // A screen's navigation object stamps its route as the source but leaves the
  // target unset, as React Navigation's screen navigation does.
  const dispatch = (action: Action) => apply({ source: terminalKey, ...action } as Action);
  harness.navigation = {
    dispatch,
    goBack: () => dispatch(CommonActions.goBack()),
    canGoBack: () => state.routes.length > 1,
    isFocused: () => state.routes.at(-1)?.key === terminalKey,
    addListener: (_event: "focus", listener: () => void) => {
      focusListeners.add(listener);
      return () => focusListeners.delete(listener);
    },
  };
  let exitNavigation!: ReturnType<typeof useTerminalExitNavigation>;
  function Probe() {
    const value = useTerminalExitNavigation({
      ...thread,
      readFallbackTerminalId: () => fallbackTerminalId,
    });
    useLayoutEffect(() => {
      exitNavigation = value;
    });
    return null;
  }
  const root = createRoot(document.createElement("div"));
  act(() => root.render(<Probe />));
  return {
    exitNavigation,
    routes: () => state.routes.map((route) => [route.name, route.params]),
    openFiles: () => apply(StackActions.push("ThreadFiles", thread)),
    returnToTerminal: () => {
      apply(StackActions.pop());
      for (const listener of focusListeners) listener();
    },
    [Symbol.dispose]: () => act(() => root.unmount()),
  };
}

const thread = { environmentId: "environment", threadId: "thread" };

it("leaves the screen on top alone when a terminal behind it exits, then goes back on return", () => {
  using screen = setup(null);
  screen.openFiles();

  screen.exitNavigation.exited();
  expect(screen.routes()).toEqual([
    ["Thread", thread],
    ["ThreadTerminal", { ...thread, terminalId: "second" }],
    ["ThreadFiles", thread],
  ]);

  screen.returnToTerminal();
  expect(screen.routes()).toEqual([["Thread", thread]]);
});

it("does not replace the screen on top with the fallback terminal", () => {
  using screen = setup("first");
  screen.openFiles();

  screen.exitNavigation.exited();
  expect(screen.routes().at(-1)).toEqual(["ThreadFiles", thread]);

  screen.returnToTerminal();
  expect(screen.routes()).toEqual([
    ["Thread", thread],
    ["ThreadTerminal", { ...thread, terminalId: "first" }],
  ]);
});

it("stays on a terminal that restarted before the user returned", () => {
  using screen = setup(null);
  screen.openFiles();

  screen.exitNavigation.exited();
  screen.exitNavigation.restarted();
  screen.returnToTerminal();
  expect(screen.routes()).toEqual([
    ["Thread", thread],
    ["ThreadTerminal", { ...thread, terminalId: "second" }],
  ]);
});
