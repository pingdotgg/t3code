import * as NodeModule from "node:module";
import { act, useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

const harness = vi.hoisted(() => ({
  dispatch: (_action: unknown) => {},
  getState: (): unknown => undefined,
  getRoute: (): unknown => undefined,
}));

vi.mock("react-native", () => ({ Platform: { OS: "ios" } }));
vi.mock("../layout/AdaptiveWorkspaceLayout", () => ({
  useAdaptiveWorkspaceLayout: () => ({ fileInspector: { supported: true } }),
}));
vi.mock("@react-navigation/native", async () => {
  const { createRequire } = await import("node:module");
  const requireNavigation = createRequire(
    createRequire(import.meta.url).resolve("@react-navigation/native/package.json"),
  );
  return {
    StackActions: requireNavigation("@react-navigation/routers").StackActions,
    useNavigation: () => ({ dispatch: harness.dispatch, getState: harness.getState }),
    useRoute: () => harness.getRoute(),
  };
});

import { useOpenThreadInspector } from "./thread-inspector-navigation";
import { useOpenLinkedThread } from "./useOpenLinkedThread";

const requireNavigation = NodeModule.createRequire(
  NodeModule.createRequire(import.meta.url).resolve("@react-navigation/native/package.json"),
);
const { StackRouter, StackActions } = requireNavigation("@react-navigation/routers") as {
  StackRouter: typeof import("@react-navigation/native").StackRouter;
  StackActions: typeof import("@react-navigation/native").StackActions;
};

function setup(fromAgents: boolean, fullscreen = false) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const router = StackRouter({});
  const options = {
    routeNames: ["Home", "Thread", "ThreadAgents", "ThreadInspectorFullscreen"],
    routeParamList: {},
    routeGetIdList: {},
  };
  let state = router.getInitialState(options);
  const dispatch = (action: Parameters<typeof router.getStateForAction>[1]) => {
    const next = router.getStateForAction(state, action, options);
    if (!next) throw new Error(`Rejected ${action.type}`);
    state = router.getRehydratedState(next, options);
  };
  harness.dispatch = (action) => dispatch(action as Parameters<typeof dispatch>[0]);
  harness.getState = () => state;
  harness.getRoute = () => state.routes.at(-1);
  const source = { environmentId: "remote-environment", threadId: "parent" };
  dispatch(StackActions.push("Thread", { ...source, prompt: "retained prompt" }));
  const parentKey = state.routes.at(-1)!.key;
  if (fullscreen)
    dispatch(StackActions.push("ThreadInspectorFullscreen", { ...source, threadId: "child" }));
  if (fromAgents)
    dispatch(
      StackActions.push("ThreadAgents", fullscreen ? { ...source, threadId: "child" } : source),
    );
  let openInspector: ReturnType<typeof useOpenThreadInspector>;
  let openLinkedThread: ReturnType<typeof useOpenLinkedThread>;
  function Probe() {
    const open = useOpenThreadInspector();
    const openLinked = useOpenLinkedThread();
    useLayoutEffect(() => {
      openInspector = open;
      openLinkedThread = openLinked;
    });
    return null;
  }
  const root = createRoot(document.createElement("div"));
  act(() => root.render(<Probe />));
  return {
    source,
    parentKey,
    dispatch,
    get state() {
      return state;
    },
    open(target: Parameters<typeof openInspector>[1], from = source) {
      let opened = false;
      act(() => {
        opened = openInspector(from, target);
      });
      return opened;
    },
    openLinked(threadId: string) {
      act(() => openLinkedThread({ environmentId: source.environmentId, threadId }));
    },
    [Symbol.dispose]() {
      act(() => root.unmount());
    },
  };
}

it("opens a subagent from the Agents sheet without replacing the parent thread", () => {
  using screen = setup(true);
  const inspector = {
    type: "thread",
    environmentId: screen.source.environmentId,
    threadId: "child",
  } as const;
  screen.open(inspector);
  expect(screen.state.routes.map((route) => route.name)).toEqual(["Home", "Thread"]);
  expect(screen.state.routes.at(-1)).toMatchObject({
    key: screen.parentKey,
    params: { ...screen.source, prompt: "retained prompt", inspector },
  });
  screen.dispatch(StackActions.push("ThreadInspectorFullscreen", inspector));
  screen.dispatch(StackActions.pop());
  expect(screen.state.routes.at(-1)).toMatchObject({
    key: screen.parentKey,
    params: { ...screen.source, inspector },
  });
});

it("opens a completion link in the parent inspector", () => {
  using screen = setup(false);
  screen.openLinked("child");
  expect(screen.state.routes).toHaveLength(2);
  expect(screen.state.routes.at(-1)).toMatchObject({
    key: screen.parentKey,
    params: {
      ...screen.source,
      inspector: { type: "thread", environmentId: screen.source.environmentId, threadId: "child" },
    },
  });
});

it("switches between subagents and devices in the same parent route", () => {
  using screen = setup(false);
  screen.open({ type: "thread", environmentId: screen.source.environmentId, threadId: "child" });
  const inspector = { type: "device", ...screen.source } as const;
  screen.open(inspector);
  expect(screen.state.routes).toHaveLength(2);
  expect(screen.state.routes.at(-1)).toMatchObject({
    key: screen.parentKey,
    params: { ...screen.source, inspector },
  });
});

it.each(["thread", "device"] as const)(
  "keeps the parent when a maximized child opens a %s preview",
  (type) => {
    using screen = setup(false, true);
    const child = { ...screen.source, threadId: "child" };
    const originalState = screen.state;
    expect(screen.open({ type, ...child, threadId: "grandchild" }, child)).toBe(false);
    expect(screen.state).toEqual(originalState);
    screen.dispatch(StackActions.pop());
    expect(screen.state.routes.at(-1)).toMatchObject({
      key: screen.parentKey,
      params: screen.source,
    });
  },
);

it("keeps the parent when the maximized child's Agents sheet opens another child", () => {
  using screen = setup(true, true);
  const child = { ...screen.source, threadId: "child" };
  const originalState = screen.state;
  expect(screen.open({ type: "thread", ...child, threadId: "grandchild" }, child)).toBe(false);
  expect(screen.state).toEqual(originalState);
});
