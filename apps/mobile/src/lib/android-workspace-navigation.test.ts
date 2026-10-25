import * as NodeModule from "node:module";
import { describe, expect, it } from "vite-plus/test";
import {
  androidWorkspaceTabFromNavigationState,
  androidWorkspaceTabNavigationState,
  type AndroidWorkspaceNavigationTab,
} from "../features/workspace/android-workspace-tabs";
import {
  androidWorkspaceNavigationState,
  linkedThreadStep,
  parentThreadIsBelow,
  resetAndroidWorkspace,
  returnToAndroidWorkspaceList,
} from "./android-workspace-navigation";
import type { RootStackResetAction } from "./root-stack-reset";

const require = NodeModule.createRequire(import.meta.url);
const nativePackage = require.resolve("@react-navigation/native/package.json");
const requireFromNative = NodeModule.createRequire(nativePackage);
const corePackage = requireFromNative.resolve("@react-navigation/core/package.json");
const requireFromCore = NodeModule.createRequire(corePackage);
const { CommonActions, StackActions, StackRouter } = requireFromCore(
  "@react-navigation/routers",
) as {
  readonly CommonActions: typeof import("@react-navigation/native").CommonActions;
  readonly StackActions: typeof import("@react-navigation/native").StackActions;
  readonly StackRouter: typeof import("@react-navigation/native").StackRouter;
};
const router = StackRouter({});
const options = {
  routeNames: [
    "Home",
    "Thread",
    "ThreadFiles",
    "ThreadTerminal",
    "GitOverview",
    "PullRequest",
    "PullRequestFile",
    "PullRequestReviewers",
    "Settings",
    "SettingsUsage",
    "SettingsUsageAccount",
  ],
  routeParamList: {},
  routeGetIdList: {},
};
const thread = {
  name: "Thread",
  params: { environmentId: "environment-a", threadId: "thread-a" },
} as const;
const pullRequest = {
  name: "PullRequest",
  params: {
    environmentId: "environment-a",
    projectId: "project-a",
    repository: "owner/repository",
    number: 42,
    host: "github.com",
  },
} as const;

function apply(
  state: ReturnType<typeof router.getInitialState>,
  action: Parameters<typeof router.getStateForAction>[1],
) {
  const result = router.getStateForAction(state, action, options);
  if (!result) throw new Error(`Router rejected ${action.type}`);
  return router.getRehydratedState(result, options);
}

function withThread() {
  return apply(router.getInitialState(options), StackActions.push(thread.name, thread.params));
}

function legacyHistory() {
  let state = router.getInitialState(options);
  state = apply(state, StackActions.push(thread.name, thread.params));
  state = apply(state, StackActions.push(pullRequest.name, pullRequest.params));
  return state;
}

function names(state: ReturnType<typeof router.getInitialState>) {
  return state.routes.map((route) => route.name);
}

describe("Android workspace navigation", () => {
  it("returns to a distinct previous thread, otherwise to the workspace list", () => {
    const parent = withThread();
    let state = apply(
      parent,
      StackActions.push("Thread", { ...thread.params, threadId: "child-a" }),
    );
    let listSelected = false;
    const navigation = {
      dispatch: (action: RootStackResetAction) => {
        state = apply(state, action);
      },
      getParent: () => undefined,
      getState: () => state,
      goBack: () => {
        state = apply(state, StackActions.pop());
      },
    };
    const back = () =>
      returnToAndroidWorkspaceList(navigation, () => {
        listSelected = true;
      });

    back();
    expect(state.routes).toEqual(parent.routes);
    expect(state.index).toBe(parent.index);
    expect(listSelected).toBe(false);

    back();
    expect(state.routes).toEqual([parent.routes[0]]);
    expect(state.index).toBe(0);
    expect(listSelected).toBe(true);

    state = apply(
      parent,
      StackActions.push("Thread", { ...thread.params, environmentId: "environment-b" }),
    );
    listSelected = false;
    back();
    expect(state.routes).toEqual(parent.routes);
    expect(state.index).toBe(parent.index);
    expect(listSelected).toBe(false);

    // Confirming a Git action from the inline inspector can duplicate the current thread.
    state = apply(parent, StackActions.push("Thread", thread.params));
    back();
    expect({ routes: names(state), index: state.index, listSelected }).toEqual({
      routes: ["Home"],
      index: 0,
      listSelected: true,
    });
  });

  it("opens a linked thread above the current one so Back returns to it", () => {
    const parent = withThread();
    const child = { ...thread.params, threadId: "child-a" };
    const open = (
      state: ReturnType<typeof router.getInitialState>,
      target: ReactNavigation.RootParamList["Thread"],
    ) => {
      const step = linkedThreadStep(state, target);
      if (step === "stay") return state;
      return apply(
        state,
        step === "pop" ? StackActions.pop() : StackActions.push("Thread", target),
      );
    };

    const inChild = open(parent, child);
    expect(inChild.routes.map((route) => route.params)).toEqual([undefined, thread.params, child]);
    expect(open(inChild, child)).toBe(inChild);

    const backInParent = open(inChild, thread.params);
    expect(backInParent.routes).toEqual(parent.routes);
    expect(backInParent.index).toBe(parent.index);
  });

  it("recognizes a parent only when its environment and thread are immediately below", () => {
    const parent = withThread();
    const child = apply(
      parent,
      StackActions.push("Thread", { ...thread.params, threadId: "child-a" }),
    );

    expect(parentThreadIsBelow(child, thread.params)).toBe(true);
    expect(parentThreadIsBelow(child, { ...thread.params, environmentId: "environment-b" })).toBe(
      false,
    );
    expect(parentThreadIsBelow(child, { ...thread.params, threadId: "other" })).toBe(false);
    expect(parentThreadIsBelow(parent, thread.params)).toBe(false);
    expect(
      parentThreadIsBelow(
        apply(child, StackActions.push("Thread", { ...thread.params, threadId: "grandchild-a" })),
        thread.params,
      ),
    ).toBe(false);
  });

  it("resets the root stack when a nested stack has focus", () => {
    const root = apply(router.getInitialState(options), StackActions.push("Thread", thread.params));
    const nested = router.getInitialState({ ...options, routeNames: ["Nested", "NestedChild"] });
    const actions: RootStackResetAction[] = [];
    const rootNavigation = {
      dispatch: () => undefined,
      getParent: () => undefined,
      getState: () => root,
    };
    resetAndroidWorkspace({
      dispatch: (action) => actions.push(action),
      getParent: () => rootNavigation,
      getState: () => nested,
    });
    const [action] = actions;
    expect(action?.target).toBe(root.key);
    expect(names(apply(root, action!))).toEqual(["Home"]);
  });

  it("resets from the navigation container before any navigation action", () => {
    const root = router.getInitialState(options);
    const actions: RootStackResetAction[] = [];
    // The container only learns the root state after the first action.
    resetAndroidWorkspace({
      dispatch: (action) => actions.push(action),
      getParent: () => undefined,
      getState: () => undefined,
      getRootState: () => root,
    });
    const [action] = actions;
    expect(action?.target).toBe(root.key);
    expect(names(apply(root, action!))).toEqual(["Home"]);
  });
});

describe("Android Settings tab", () => {
  type State = ReturnType<typeof router.getInitialState>;
  type Tab = AndroidWorkspaceNavigationTab;
  const openTab = (state: State, tab: Tab) =>
    apply(state, CommonActions.reset(androidWorkspaceTabNavigationState(state, tab)));
  const selectedTab = (state: State, previous: Tab) =>
    androidWorkspaceTabFromNavigationState(state, previous);

  it("opens over Home alone, dropping chat and PR history, and Back returns to Home", () => {
    const previous = legacyHistory();
    const settings = openTab(previous, "settings");
    expect(names(settings)).toEqual(["Home", "Settings"]);
    expect(settings.routes[0]?.key).toBe(previous.routes[0]?.key);
    expect(selectedTab(settings, "threads")).toBe("settings");
    const back = apply(settings, StackActions.pop());
    expect(names(back)).toEqual(["Home"]);
    expect(back.routes[0]?.key).toBe(previous.routes[0]?.key);
    expect(selectedTab(back, "settings")).not.toBe("settings");
  });

  it("stays selected under a settings page until a list tab returns to Home", () => {
    const previous = legacyHistory();
    const usage = apply(openTab(previous, "settings"), StackActions.push("SettingsUsage"));
    expect(selectedTab(usage, "threads")).toBe("settings");
    const list = openTab(usage, "pullRequests");
    expect(names(list)).toEqual(["Home"]);
    expect(list.routes[0]?.key).toBe(previous.routes[0]?.key);
    expect(selectedTab(list, "pullRequests")).toBe("pullRequests");
  });

  it("leaves a settings page opened from the Usage tab in that tab", () => {
    const account = apply(
      router.getInitialState(options),
      StackActions.push("SettingsUsageAccount"),
    );
    expect(selectedTab(account, "usage")).toBe("usage");
  });
});
