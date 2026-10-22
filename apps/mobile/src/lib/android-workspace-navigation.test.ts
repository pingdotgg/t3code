import * as NodeModule from "node:module";
import type { NavigationState } from "@react-navigation/native";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  androidWorkspaceTabFromNavigationState,
  androidWorkspaceTabNavigationState,
  type AndroidWorkspaceNavigationTab,
} from "../features/workspace/android-workspace-tabs";
import {
  androidWorkspaceNavigationState,
  parentThreadIsBelow,
  resetAndroidWorkspace,
  returnToAndroidWorkspaceList,
  type AndroidWorkspaceDestination,
  type AndroidWorkspaceResetAction,
} from "./android-workspace-navigation";

function loadRouters() {
  const require = NodeModule.createRequire(import.meta.url);
  const nativePackage = require.resolve("@react-navigation/native/package.json");
  const corePackage = NodeModule.createRequire(nativePackage).resolve(
    "@react-navigation/core/package.json",
  );
  return NodeModule.createRequire(corePackage)("@react-navigation/routers") as {
    readonly CommonActions: typeof import("@react-navigation/native").CommonActions;
    readonly StackActions: typeof import("@react-navigation/native").StackActions;
    readonly StackRouter: typeof import("@react-navigation/native").StackRouter;
  };
}

vi.mock("@react-navigation/native", () => ({
  ...loadRouters(),
  useNavigation: () => navigation,
  useRoute: () => current.routes[current.index],
  useFocusEffect: (callback: () => unknown) => callback(),
}));
vi.mock("react", () => ({ useCallback: (callback: unknown) => callback }));
vi.mock("react-native", () => ({
  Platform: { OS: "android" },
  Keyboard: { isVisible: () => false },
  BackHandler: {
    addEventListener: (_event: string, callback: () => boolean) => {
      hardwareBack = callback;
      return { remove: () => {} };
    },
  },
}));
vi.mock("../features/workspace/WorkspaceTabsContext", () => ({
  useWorkspaceTabs: () => ({ dispatch: selectTab }),
}));
vi.mock("../state/entities", () => ({ useThreadShell: () => ({ projectId: "project-a" }) }));
vi.mock("./openExternalUrl", () => ({ tryOpenExternalUrl: vi.fn() }));

import { useOpenPullRequest } from "../native/useOpenPullRequest";
import {
  useAndroidWorkspaceBack,
  useWorkspaceListNavigation,
} from "../features/workspace/useAndroidWorkspaceNavigation";
import { newTaskSubmitNavigationAction } from "../features/threads/new-task-submit-navigation";

const { CommonActions, StackActions, StackRouter } = loadRouters();
const router = StackRouter({});
const options = {
  routeNames: [
    "Home",
    "Thread",
    "ThreadFiles",
    "ThreadTerminal",
    "GitOverview",
    "ThreadPullRequests",
    "PullRequest",
    "PullRequestFile",
    "PullRequestReviewers",
    "SettingsSheet",
    "NewTaskSheet",
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

let current = router.getInitialState(options);
let hardwareBack: (() => boolean) | undefined;
const selectTab = vi.fn();
type RouterAction = Parameters<typeof router.getStateForAction>[1];
const navigation = {
  getState: () => current,
  getParent: () => undefined,
  canGoBack: () => router.getStateForAction(current, CommonActions.goBack(), options) !== null,
  goBack: () => {
    current = apply(current, CommonActions.goBack());
  },
  navigate: (name: string, params: object) => {
    current = apply(current, CommonActions.navigate(name, params));
  },
  dispatch: (action: RouterAction | ((state: NavigationState) => RouterAction)) => {
    current = apply(current, typeof action === "function" ? action(current) : action);
  },
};

beforeEach(() => {
  current = router.getInitialState(options);
  hardwareBack = undefined;
  selectTab.mockClear();
});

describe("Android workspace navigation", () => {
  it("clears unrelated detail history when selecting a PR from the sidebar badge sheet", async () => {
    current = apply(current, StackActions.push(thread.name, thread.params));
    current = apply(
      current,
      StackActions.push("ThreadPullRequests", {
        environmentId: "environment-b",
        threadId: "thread-b",
      }),
    );
    const home = current.routes[0];
    const context = { environmentId: "environment-b", projectId: "project-b" };
    await useOpenPullRequest({ replace: true, mode: "workspace", context })(
      "https://github.com/owner/repository/pull/42",
    );
    expect(names(current)).toEqual(["Home", "PullRequest"]);
    expect(current.routes[0]).toEqual(home);
    expect(current.routes[1]?.params).toEqual({ ...pullRequest.params, ...context });
    navigation.goBack();
    expect(current.routes).toEqual([home]);
    expect(navigation.canGoBack()).toBe(false);
  });

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

describe("Android contextual navigation", () => {
  it.each([false, true])(
    "restores the original chat history after a PR link (replace sheet: %s)",
    async (replace) => {
      current = apply(
        current,
        StackActions.push("Thread", { ...thread.params, environmentId: "environment-b" }),
      );
      current = apply(current, StackActions.push(thread.name, thread.params));
      const previous = current.routes;
      if (replace) current = apply(current, StackActions.push("GitOverview", thread.params));
      await useOpenPullRequest({ replace })("https://github.com/owner/repository/pull/42");
      expect(current.routes.slice(0, -1)).toEqual(previous);
      expect(current.routes.at(-1)).toMatchObject(pullRequest);
      const back = useAndroidWorkspaceBack("pullRequests");
      if (replace) {
        if (!hardwareBack?.()) navigation.goBack();
      } else back();
      expect(current.routes).toEqual(previous);
      expect(selectTab).not.toHaveBeenCalled();
    },
  );

  it("returns through detail history on Back but clears it on an explicit list switch", () => {
    const previous = legacyHistory();
    current = apply(
      previous,
      StackActions.push("Thread", { ...thread.params, environmentId: "environment-b" }),
    );
    useAndroidWorkspaceBack("threads")();
    expect(current.routes).toEqual(previous.routes);
    expect(selectTab).not.toHaveBeenCalled();
    useWorkspaceListNavigation("threads")();
    expect(current.routes).toEqual([previous.routes[0]]);
    expect(selectTab).toHaveBeenLastCalledWith({ type: "select", tab: "threads" });
    expect(navigation.canGoBack()).toBe(false);
  });

  it.each([
    { android: true, queued: false },
    { android: true, queued: true },
    { android: false, queued: false },
  ])(
    "preserves the appropriate return destination after saving a PR draft: %o",
    ({ android, queued }) => {
      const previous = legacyHistory();
      const draft = apply(
        previous,
        StackActions.push("NewTaskSheet", {
          screen: "NewTaskDraft",
          params: { draftId: "draft-pr" },
        }),
      );
      const params = { ...thread.params, threadId: "new-thread" };
      const saved = apply(
        draft,
        newTaskSubmitNavigationAction({ state: draft, params, android, queued }),
      );
      if (queued) {
        expect(saved.routes).toEqual(previous.routes);
        expect(apply(saved, CommonActions.goBack()).routes).toEqual(previous.routes.slice(0, -1));
      } else {
        expect(saved.routes.at(-1)).toMatchObject({ name: "Thread", params });
        expect(saved.routes.at(-1)?.key).not.toBe(previous.routes[1]?.key);
        const back = apply(saved, CommonActions.goBack());
        expect(back.routes).toEqual(android ? [previous.routes[0]] : previous.routes);
        if (android)
          expect(router.getStateForAction(back, CommonActions.goBack(), options)).toBeNull();
      }
    },
  );
});
