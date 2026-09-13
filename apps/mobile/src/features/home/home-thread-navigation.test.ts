import * as NodeModule from "node:module";
import type {
  StackNavigationState,
  StackRouter as StackRouterType,
  StackActions as StackActionsType,
} from "@react-navigation/native";
import { describe, expect, it, vi } from "vite-plus/test";

function loadRouters() {
  const require = NodeModule.createRequire(import.meta.url);
  const nativePackage = require.resolve("@react-navigation/native/package.json");
  const requireFromNative = NodeModule.createRequire(nativePackage);
  const corePackage = requireFromNative.resolve("@react-navigation/core/package.json");
  const requireFromCore = NodeModule.createRequire(corePackage);
  return requireFromCore("@react-navigation/routers") as {
    readonly CommonActions: typeof import("@react-navigation/native").CommonActions;
    readonly StackActions: typeof StackActionsType;
    readonly StackRouter: typeof StackRouterType;
  };
}

vi.mock("@react-navigation/native", () => {
  const { CommonActions, StackActions } = loadRouters();
  return { CommonActions, StackActions };
});

import { createHomeThreadNavigationAction } from "./home-thread-navigation";

const { StackActions, StackRouter } = loadRouters();
const routeNames = ["Home", "Thread"];
const routeParamList = {
  Home: undefined,
  Thread: undefined,
};
const router = StackRouter({});
const routerOptions = {
  routeNames,
  routeParamList,
  routeGetIdList: {},
};

type ThreadSelection = Parameters<typeof createHomeThreadNavigationAction>[0]["thread"];

function thread(id: string): ThreadSelection {
  return {
    environmentId: "environment-1",
    id,
  } as ThreadSelection;
}

function initialState() {
  return router.getInitialState(routerOptions);
}

function apply(
  state: StackNavigationState<Record<string, object | undefined>>,
  action: Parameters<typeof router.getStateForAction>[1],
) {
  const nextState = router.getStateForAction(state, action, routerOptions);
  expect(nextState).not.toBeNull();
  return nextState as StackNavigationState<Record<string, object | undefined>>;
}

function selectThread(
  state: ReturnType<typeof initialState>,
  selectedThread: ThreadSelection,
  dismissingRouteKey: string | null = null,
) {
  return apply(
    state,
    createHomeThreadNavigationAction({
      state,
      dismissingRouteKey,
      thread: selectedThread,
    }),
  );
}

function dismissRoute(state: ReturnType<typeof initialState>, routeKey: string) {
  return apply(state, {
    ...StackActions.pop(),
    source: routeKey,
    target: state.key,
  });
}

describe("createHomeThreadNavigationAction", () => {
  it("coalesces ordinary repeat selections onto the current thread route", () => {
    const firstState = selectThread(initialState(), thread("thread-a"));
    const threadRouteKey = firstState.routes[firstState.index]?.key;
    const secondAction = createHomeThreadNavigationAction({
      state: firstState,
      dismissingRouteKey: null,
      thread: thread("thread-b"),
    });

    const secondState = apply(firstState, secondAction);
    expect(secondState.routes).toHaveLength(2);
    expect(secondState.routes[secondState.index]).toMatchObject({
      key: threadRouteKey,
      name: "Thread",
      params: { environmentId: "environment-1", threadId: "thread-b" },
    });
  });

  it("keeps an overlap selection after native dismisses the outgoing route", () => {
    const outgoingState = selectThread(initialState(), thread("thread-a"));
    const outgoingRouteKey = outgoingState.routes[outgoingState.index]?.key;
    expect(outgoingRouteKey).toBeDefined();

    const overlapAction = createHomeThreadNavigationAction({
      state: outgoingState,
      dismissingRouteKey: outgoingRouteKey ?? null,
      thread: thread("thread-b"),
    });
    const overlapState = apply(outgoingState, overlapAction);
    const incomingRoute = overlapState.routes[overlapState.index];
    expect(incomingRoute?.key).not.toBe(outgoingRouteKey);

    const dismissedState = dismissRoute(overlapState, outgoingRouteKey!);
    expect(dismissedState.routes).toHaveLength(2);
    expect(dismissedState.routes[dismissedState.index]).toMatchObject({
      key: incomingRoute?.key,
      name: "Thread",
      params: { environmentId: "environment-1", threadId: "thread-b" },
    });
  });

  it("uses a fresh key for the same thread selected during dismissal", () => {
    const outgoingState = selectThread(initialState(), thread("thread-a"));
    const outgoingRouteKey = outgoingState.routes[outgoingState.index]?.key;
    expect(outgoingRouteKey).toBeDefined();

    const overlapState = selectThread(outgoingState, thread("thread-a"), outgoingRouteKey ?? null);
    const incomingRouteKey = overlapState.routes[overlapState.index]?.key;
    expect(incomingRouteKey).not.toBe(outgoingRouteKey);

    const dismissedState = dismissRoute(overlapState, outgoingRouteKey!);
    expect(dismissedState.routes[dismissedState.index]).toMatchObject({
      key: incomingRouteKey,
      params: { environmentId: "environment-1", threadId: "thread-a" },
    });
  });

  it("coalesces a second overlap selection onto the fresh incoming route", () => {
    const outgoingState = selectThread(initialState(), thread("thread-a"));
    const outgoingRouteKey = outgoingState.routes[outgoingState.index]?.key;
    expect(outgoingRouteKey).toBeDefined();

    const firstOverlapState = selectThread(
      outgoingState,
      thread("thread-b"),
      outgoingRouteKey ?? null,
    );
    const incomingRouteKey = firstOverlapState.routes[firstOverlapState.index]?.key;
    const secondOverlapAction = createHomeThreadNavigationAction({
      state: firstOverlapState,
      dismissingRouteKey: outgoingRouteKey ?? null,
      thread: thread("thread-c"),
    });

    const secondOverlapState = apply(firstOverlapState, secondOverlapAction);
    expect(secondOverlapState.routes).toHaveLength(3);
    expect(secondOverlapState.routes[secondOverlapState.index]).toMatchObject({
      key: incomingRouteKey,
      params: { environmentId: "environment-1", threadId: "thread-c" },
    });

    const dismissedState = dismissRoute(secondOverlapState, outgoingRouteKey!);
    expect(dismissedState.routes).toHaveLength(2);
    expect(dismissedState.routes[dismissedState.index]).toMatchObject({
      key: incomingRouteKey,
      params: { environmentId: "environment-1", threadId: "thread-c" },
    });
  });

  it("uses ordinary navigation when native pops before the selection", () => {
    const outgoingState = selectThread(initialState(), thread("thread-a"));
    const outgoingRouteKey = outgoingState.routes[outgoingState.index]?.key;
    expect(outgoingRouteKey).toBeDefined();

    const poppedState = dismissRoute(outgoingState, outgoingRouteKey!);
    const action = createHomeThreadNavigationAction({
      state: poppedState,
      dismissingRouteKey: outgoingRouteKey ?? null,
      thread: thread("thread-b"),
    });

    const selectedState = apply(poppedState, action);
    expect(selectedState.routes).toHaveLength(2);
    expect(selectedState.routes[selectedState.index]).toMatchObject({
      name: "Thread",
      params: { environmentId: "environment-1", threadId: "thread-b" },
    });
  });
});
