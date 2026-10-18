import * as NodeModule from "node:module";
import { describe, expect, it } from "vite-plus/test";
import {
  androidWorkspaceNavigationState,
  resetAndroidWorkspace,
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

  it("dismisses nested content and overlays when the sidebar selects a peer", () => {
    let state = legacyHistory();
    state = apply(
      state,
      StackActions.push("PullRequestFile", { ...pullRequest.params, path: "src/main.ts" }),
    );
    state = apply(state, StackActions.push("SettingsSheet"));
    const selected = select(state, thread);
    expect(names(selected)).toEqual(["Home", "Thread"]);
    expect(selected.routes[1]?.params).toEqual(thread.params);
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

  it("preserves normal nested PR Back behavior", () => {
    const detail = select(legacyHistory(), pullRequest);
    const nested = apply(
      detail,
      StackActions.push("PullRequestFile", { ...pullRequest.params, path: "file.ts" }),
    );
    const back = apply(nested, StackActions.pop());
    expect(back.routes[back.index]?.key).toBe(detail.routes[detail.index]?.key);
    expect(names(back)).toEqual(["Home", "PullRequest"]);
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

  it.each([
    { environmentId: "environment-b" },
    { projectId: "project-b" },
    { repository: "owner/other" },
    { host: "git.example.test" },
    { number: 43 },
  ])("does not reuse another PR's key when its scope differs: %o", (change) => {
    const previous = select(router.getInitialState(options), pullRequest);
    const state = select(previous, {
      name: "PullRequest",
      params: { ...pullRequest.params, ...change },
    });
    expect(state.routes[1]?.key).not.toBe(previous.routes[1]?.key);
    expect(state.routes[1]?.params).toEqual({ ...pullRequest.params, ...change });
  });

  it("does not reuse a thread key from another environment", () => {
    const previous = select(router.getInitialState(options), thread);
    const state = select(previous, {
      name: "Thread",
      params: { ...thread.params, environmentId: "environment-b" },
    });
    expect(state.routes[1]?.key).not.toBe(previous.routes[1]?.key);
  });

  it("drops stale detail history on a tab switch while retaining Home", () => {
    const previous = legacyHistory();
    const state = select(previous);
    expect(names(state)).toEqual(["Home"]);
    expect(state.routes[0]?.key).toBe(previous.routes[0]?.key);
    expect(state.index).toBe(0);
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
