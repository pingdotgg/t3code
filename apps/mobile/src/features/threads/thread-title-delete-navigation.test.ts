import * as NodeModule from "node:module";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { RootStackResetAction } from "../../lib/root-stack-reset";
import { leaveDeletedThread, threadRouteStillShows } from "./thread-title-delete-navigation";

const require = NodeModule.createRequire(import.meta.url);
const requireFromNative = NodeModule.createRequire(
  require.resolve("@react-navigation/native/package.json"),
);
const requireFromCore = NodeModule.createRequire(
  requireFromNative.resolve("@react-navigation/core/package.json"),
);
const { CommonActions, StackActions, StackRouter } = requireFromCore(
  "@react-navigation/routers",
) as {
  readonly CommonActions: typeof import("@react-navigation/native").CommonActions;
  readonly StackActions: typeof import("@react-navigation/native").StackActions;
  readonly StackRouter: typeof import("@react-navigation/native").StackRouter;
};
const router = StackRouter({});
const routerOptions = {
  routeNames: ["Home", "Thread", "ThreadFiles"],
  routeParamList: {},
  routeGetIdList: {},
};
type StackState = ReturnType<typeof router.getInitialState>;

const deleted = { environmentId: EnvironmentId.make("env-a"), id: ThreadId.make("thread-a") };

function navigation(
  params: object | undefined,
  options: { readonly focused?: boolean; readonly removed?: boolean } = {},
) {
  return {
    isFocused: () => options.focused ?? true,
    getState: () =>
      options.removed
        ? undefined
        : { index: 1, routes: [{ params: undefined }, { params }] as const },
  };
}

describe("threadRouteStillShows", () => {
  it("leaves only while the focused route still shows the deleted thread", () => {
    expect(
      threadRouteStillShows(navigation({ environmentId: "env-a", threadId: "thread-a" }), deleted),
    ).toBe(true);
    expect(
      threadRouteStillShows(
        navigation({ environmentId: ["env-a"], threadId: ["thread-a"] }),
        deleted,
      ),
    ).toBe(true);
  });

  it("keeps a newer selection in the same or another environment", () => {
    expect(
      threadRouteStillShows(navigation({ environmentId: "env-a", threadId: "thread-b" }), deleted),
    ).toBe(false);
    expect(
      threadRouteStillShows(navigation({ environmentId: "env-b", threadId: "thread-a" }), deleted),
    ).toBe(false);
  });

  it("stays put after the user leaves the thread route", () => {
    const params = { environmentId: "env-a", threadId: "thread-a" };
    expect(threadRouteStillShows(navigation(params, { focused: false }), deleted)).toBe(false);
    expect(threadRouteStillShows(navigation(params, { removed: true }), deleted)).toBe(false);
  });
});

function apply(state: StackState, action: Parameters<typeof router.getStateForAction>[1]) {
  const result = router.getStateForAction(state, action, routerOptions);
  if (!result) throw new Error(`Router rejected ${action.type}`);
  return router.getRehydratedState(result, routerOptions);
}

function stack(...routes: ReadonlyArray<{ readonly name: string; readonly params?: object }>) {
  const [first, ...rest] = routes;
  let state = router.getInitialState(routerOptions);
  if (first && first.name !== "Home")
    state = apply(state, CommonActions.reset({ index: 0, routes: [first] }));
  for (const route of rest) state = apply(state, StackActions.push(route.name, route.params));
  return state;
}

// Navigation for the focused route, dispatching through the real stack router.
function deleteFromFocusedRoute(initial: StackState) {
  let state = initial;
  const focusedKey = state.routes[state.index]?.key;
  const navigation = {
    isFocused: () => state.routes[state.index]?.key === focusedKey,
    getState: () => state,
    getParent: () => undefined,
    dispatch: (action: RootStackResetAction) => {
      state = apply(state, action);
    },
  };
  leaveDeletedThread(navigation, deleted);
  return state;
}

function names(state: StackState) {
  return state.routes.map((route) => route.name);
}

const threadA = { environmentId: "env-a", threadId: "thread-a" };

describe("leaveDeletedThread", () => {
  it("drops a covering Files route so Back cannot reopen the deleted thread", () => {
    const initial = stack(
      { name: "Home" },
      { name: "Thread", params: threadA },
      { name: "ThreadFiles", params: threadA },
    );
    const state = deleteFromFocusedRoute(initial);
    expect(names(state)).toEqual(["Home"]);
    expect(state.routes[0]?.key).toBe(initial.routes[0]?.key);
  });

  it("returns an ordinary thread to Home", () => {
    const initial = stack({ name: "Home" }, { name: "Thread", params: threadA });
    const state = deleteFromFocusedRoute(initial);
    expect(names(state)).toEqual(["Home"]);
    expect(state.routes[0]?.key).toBe(initial.routes[0]?.key);
  });

  it("creates Home beneath a deep-linked thread", () => {
    expect(names(deleteFromFocusedRoute(stack({ name: "Thread", params: threadA })))).toEqual([
      "Home",
    ]);
  });

  it("keeps a newer selection in the same or another environment", () => {
    for (const params of [
      { environmentId: "env-a", threadId: "thread-b" },
      { environmentId: "env-b", threadId: "thread-a" },
    ]) {
      const initial = stack({ name: "Home" }, { name: "Thread", params });
      expect(deleteFromFocusedRoute(initial)).toBe(initial);
    }
  });
});
