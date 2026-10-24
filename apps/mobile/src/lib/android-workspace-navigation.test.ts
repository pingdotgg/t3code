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
  type AndroidWorkspaceDestination,
  type AndroidWorkspaceResetAction,
} from "./android-workspace-navigation";

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
    "SettingsSheet",
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

function select(
  state: ReturnType<typeof router.getInitialState>,
  destination?: AndroidWorkspaceDestination,
  reviewers?: ReactNavigation.RootParamList["PullRequestReviewers"],
) {
  return apply(
    state,
    CommonActions.reset(androidWorkspaceNavigationState(state, destination, reviewers)),
  );
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
  it("replaces cross-tab history with one detail and returns directly to its list", () => {
    const previous = legacyHistory();
    const state = select(previous, pullRequest);
    expect(names(state)).toEqual(["Home", "PullRequest"]);
    expect(state.routes[0]?.key).toBe(previous.routes[0]?.key);
    expect(state.routes[1]?.key).toBe(previous.routes[2]?.key);
    expect(names(apply(state, StackActions.pop()))).toEqual(["Home"]);
  });

  it("replaces peer thread selections without leaving the previous thread underneath", () => {
    const first = select(router.getInitialState(options), thread);
    const second = select(first, {
      name: "Thread",
      params: { ...thread.params, threadId: "thread-b" },
    });
    expect(names(second)).toEqual(["Home", "Thread"]);
    expect(second.routes[1]?.params).toEqual({ ...thread.params, threadId: "thread-b" });
    expect(second.routes[1]?.key).not.toBe(first.routes[1]?.key);
    expect(names(apply(second, StackActions.pop()))).toEqual(["Home"]);
  });

  it("creates Home beneath cold-linked details and gives direct list escape", () => {
    const initial = router.getInitialState(options);
    const cold = apply(initial, CommonActions.reset({ index: 0, routes: [pullRequest] }));
    expect(names(select(cold, pullRequest))).toEqual(["Home", "PullRequest"]);
    expect(names(select(cold))).toEqual(["Home"]);
  });

  it("keeps a request-review flow above the chosen PR instead of an old chat", () => {
    const state = select(legacyHistory(), pullRequest, pullRequest.params);
    expect(names(state)).toEqual(["Home", "PullRequest", "PullRequestReviewers"]);
    const back = apply(state, StackActions.pop());
    expect(names(back)).toEqual(["Home", "PullRequest"]);
    expect(back.routes[back.index]?.params).toEqual(pullRequest.params);
  });

  it.each(["ThreadFiles", "ThreadTerminal", "GitOverview"])(
    "returns to chat when its sidebar row is selected from %s",
    (route) => {
      const detail = select(router.getInitialState(options), thread);
      const nested = apply(detail, StackActions.push(route, thread.params));
      const selected = select(nested, thread);
      expect(names(selected)).toEqual(["Home", "Thread"]);
      expect(selected.routes[1]?.key).toBe(detail.routes[1]?.key);
      expect(names(apply(selected, StackActions.pop()))).toEqual(["Home"]);
    },
  );

  it.each([{ environmentId: "environment-b" }, { repository: "owner/other" }])(
    "does not reuse another PR's key when its scope differs: %o",
    (change) => {
      const previous = select(router.getInitialState(options), pullRequest);
      const state = select(previous, {
        name: "PullRequest",
        params: { ...pullRequest.params, ...change },
      });
      expect(state.routes[1]?.key).not.toBe(previous.routes[1]?.key);
      expect(state.routes[1]?.params).toEqual({ ...pullRequest.params, ...change });
    },
  );

  it("returns to a distinct previous thread, otherwise to the workspace list", () => {
    const parent = select(router.getInitialState(options), thread);
    let state = apply(
      parent,
      StackActions.push("Thread", { ...thread.params, threadId: "child-a" }),
    );
    let listSelected = false;
    const navigation = {
      dispatch: (action: AndroidWorkspaceResetAction) => {
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
    const parent = select(router.getInitialState(options), thread);
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
    const parent = select(router.getInitialState(options), thread);
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

  it("resets the root stack when a nested Settings stack has focus", () => {
    const root = apply(router.getInitialState(options), StackActions.push("SettingsSheet"));
    const settings = router.getInitialState({
      ...options,
      routeNames: ["SettingsContent", "SettingsEnvironments"],
    });
    const actions: AndroidWorkspaceResetAction[] = [];
    const rootNavigation = {
      dispatch: () => undefined,
      getParent: () => undefined,
      getState: () => root,
    };
    resetAndroidWorkspace(
      {
        dispatch: (action) => actions.push(action),
        getParent: () => rootNavigation,
        getState: () => settings,
      },
      thread,
    );
    const [action] = actions;
    expect(action?.target).toBe(root.key);
    expect(names(apply(root, action!))).toEqual(["Home", "Thread"]);
  });

  it("resets from the navigation container before any navigation action", () => {
    const root = router.getInitialState(options);
    const actions: AndroidWorkspaceResetAction[] = [];
    // The container only learns the root state after the first action.
    resetAndroidWorkspace(
      {
        dispatch: (action) => actions.push(action),
        getParent: () => undefined,
        getState: () => undefined,
        getRootState: () => root,
      },
      thread,
    );
    const [action] = actions;
    expect(action?.target).toBe(root.key);
    expect(names(apply(root, action!))).toEqual(["Home", "Thread"]);
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
    expect(names(settings)).toEqual(["Home", "SettingsSheet"]);
    expect(settings.routes[0]?.key).toBe(previous.routes[0]?.key);
    expect(selectedTab(settings, "threads")).toBe("settings");
    const back = apply(settings, StackActions.pop());
    expect(names(back)).toEqual(["Home"]);
    expect(back.routes[0]?.key).toBe(previous.routes[0]?.key);
    expect(selectedTab(back, "settings")).not.toBe("settings");
  });

  it("stays selected under a nested settings page until a list tab returns to Home", () => {
    const previous = legacyHistory();
    const settings = openTab(previous, "settings");
    // Usage pushes inside the nested settings navigator, which the root router never sees.
    const usage: State = {
      ...settings,
      routes: settings.routes.map((route) =>
        route.name === "SettingsSheet"
          ? {
              ...route,
              state: {
                routes: [
                  {
                    name: "SettingsContent",
                    state: { index: 1, routes: [{ name: "Settings" }, { name: "SettingsUsage" }] },
                  },
                ],
              },
            }
          : route,
      ),
    };
    expect(selectedTab(usage, "threads")).toBe("settings");
    const list = openTab(usage, "pullRequests");
    expect(names(list)).toEqual(["Home"]);
    expect(list.routes[0]?.key).toBe(previous.routes[0]?.key);
    expect(selectedTab(list, "pullRequests")).toBe("pullRequests");
  });
});
