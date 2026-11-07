import * as NodeModule from "node:module";
import { describe, expect, it } from "vite-plus/test";
import {
  selectWorkspaceDetail,
  setNativelyPoppingWorkspaceRoute,
  workspaceDetailLinkAction,
  workspaceDetailOpenStep,
  workspaceDetailRouter,
  type WorkspaceDetail,
} from "./workspace-detail-selection";

const require = NodeModule.createRequire(import.meta.url);
const requireFromNative = NodeModule.createRequire(
  require.resolve("@react-navigation/native/package.json"),
);
const requireFromCore = NodeModule.createRequire(
  requireFromNative.resolve("@react-navigation/core/package.json"),
);
const { StackActions, StackRouter } = requireFromCore("@react-navigation/routers") as {
  readonly StackActions: typeof import("@react-navigation/native").StackActions;
  readonly StackRouter: typeof import("@react-navigation/native").StackRouter;
};

const base = StackRouter({});
const router = { ...base, ...workspaceDetailRouter(base) };
const options = {
  routeNames: [
    "Home",
    "Thread",
    "ThreadFiles",
    "PullRequest",
    "PullRequestReviewers",
    "Settings",
    "SettingsAppearance",
    "GitOverview",
  ],
  routeParamList: {},
  routeGetIdList: {},
};
type State = ReturnType<typeof base.getInitialState>;
type RouterAction = Parameters<typeof base.getStateForAction>[1];

const threadA = { name: "Thread", params: { environmentId: "env", threadId: "a" } } as const;
const threadB = { name: "Thread", params: { environmentId: "env", threadId: "b" } } as const;
const pullRequest = {
  name: "PullRequest",
  params: { environmentId: "env", projectId: "p", repository: "o/r", number: 1, host: "h" },
} as const;

function apply(state: State, action: Parameters<typeof base.getStateForAction>[1]) {
  const next = router.getStateForAction(state, action, options);
  if (!next) throw new Error(`Router rejected ${action.type}`);
  // React Navigation rehydrates every state a router returns, as a stale RESET needs.
  return base.getRehydratedState(next as State, options);
}

function select(
  state: State,
  detail: WorkspaceDetail,
  sheet?: Parameters<typeof selectWorkspaceDetail>[1],
) {
  return apply(state, selectWorkspaceDetail(detail, sheet) as unknown as RouterAction);
}

function push(state: State, name: string, params?: object) {
  return apply(state, StackActions.push(name, params));
}

const home = () => base.getInitialState(options);
const page = (state: State) => ({
  names: state.routes.map((route) => route.name),
  index: state.index,
});

describe("selectWorkspaceDetail", () => {
  it("swaps the open thread in place instead of pushing another", () => {
    const first = select(home(), threadA);
    const second = select(first, threadB);
    expect(page(second)).toEqual({ names: ["Home", "Thread"], index: 1 });
    expect(second.routes[1]?.key).toBe(first.routes[1]?.key);
    expect(second.routes[1]?.params).toEqual(threadB.params);
  });

  it.each([
    ["a page drilled into from the thread", (state: State) => push(state, "ThreadFiles")],
    ["a linked thread", (state: State) => push(state, "Thread", threadB.params)],
    ["a pull request opened from the thread", (state: State) => push(state, "PullRequest")],
    ["a sheet", (state: State) => push(state, "GitOverview")],
  ])("leaves only the selection when %s is on top", (_, drillIn) => {
    const thread = select(home(), threadA);
    const selected = select(drillIn(thread), threadA);
    expect(page(selected)).toEqual({ names: ["Home", "Thread"], index: 1 });
    expect(selected.routes[1]?.key).toBe(thread.routes[1]?.key);
  });

  it("replaces another tab's page and Settings with the selection", () => {
    const settings = push(push(select(home(), threadA), "Settings"), "SettingsAppearance");
    const selected = select(settings, pullRequest);
    expect(page(selected)).toEqual({ names: ["Home", "PullRequest"], index: 1 });
    expect(selected.routes[0]?.key).toBe(settings.routes[0]?.key);
  });

  it("puts Home under a cold-linked page and a sheet over the selection", () => {
    const cold = apply(home(), { type: "RESET", payload: { index: 0, routes: [pullRequest] } });
    const selected = select(cold, pullRequest, {
      name: "PullRequestReviewers",
      params: pullRequest.params,
    });
    expect(page(selected)).toEqual({
      names: ["Home", "PullRequest", "PullRequestReviewers"],
      index: 2,
    });
  });

  it("never reuses the page native Back is popping", () => {
    const thread = select(home(), threadA);
    setNativelyPoppingWorkspaceRoute(thread.routes[1]!.key);
    try {
      const selected = select(thread, threadA);
      expect(page(selected)).toEqual({ names: ["Home", "Thread"], index: 1 });
      expect(selected.routes[1]?.key).not.toBe(thread.routes[1]?.key);
    } finally {
      setNativelyPoppingWorkspaceRoute(null);
    }
  });
});

describe("workspaceDetailLinkAction", () => {
  it("selects a linked thread or pull request, and leaves other links alone", () => {
    expect(workspaceDetailLinkAction({ routes: [{ name: "Home" }, threadA] })).toEqual(
      selectWorkspaceDetail(threadA),
    );
    expect(workspaceDetailLinkAction({ routes: [pullRequest] })).toEqual(
      selectWorkspaceDetail(pullRequest),
    );
    expect(
      workspaceDetailLinkAction({
        routes: [{ name: "Home" }, { name: "Settings" }, { name: "SettingsAppearance" }],
      }),
    ).toBeUndefined();
  });
});

describe("workspaceDetailOpenStep", () => {
  it("stays when the detail is already focused", () => {
    const state = select(home(), threadA);
    expect(workspaceDetailOpenStep(state, threadA)).toEqual({ type: "stay" });
  });

  it("pops back to a thread under a drilled-in pull request", () => {
    const state = push(select(home(), threadA), "PullRequest", pullRequest.params);
    expect(workspaceDetailOpenStep(state, threadA)).toEqual({ type: "pop", count: 1 });
  });

  it("pops past several pages to the matching thread", () => {
    const state = push(
      push(select(home(), threadA), "PullRequest", pullRequest.params),
      "GitOverview",
    );
    expect(workspaceDetailOpenStep(state, threadA)).toEqual({ type: "pop", count: 2 });
  });

  it("pushes when the thread is not on the stack", () => {
    const state = select(home(), pullRequest);
    expect(workspaceDetailOpenStep(state, threadA)).toEqual({ type: "push" });
  });

  it("does not treat a different thread as a match", () => {
    const state = push(select(home(), threadA), "PullRequest", pullRequest.params);
    expect(workspaceDetailOpenStep(state, threadB)).toEqual({ type: "push" });
  });

  it("pushes a new-task draft instead of reusing a thread", () => {
    const state = push(select(home(), threadA), "PullRequest", pullRequest.params);
    expect(
      workspaceDetailOpenStep(state, {
        name: "Thread",
        params: { draft: { draftId: "new-task:ask", title: "Ask about #1" } },
      }),
    ).toEqual({ type: "push" });
  });

  it("pushes a new draft when a different draft is under the current page", () => {
    const earlier = {
      name: "Thread" as const,
      params: { draft: { draftId: "new-task:earlier", title: "Earlier ask" } },
    };
    const next = {
      name: "Thread" as const,
      params: { draft: { draftId: "new-task:next", title: "Ask about #1" } },
    };
    const state = push(select(home(), earlier), "PullRequest", pullRequest.params);
    expect(workspaceDetailOpenStep(state, next)).toEqual({ type: "push" });
  });

  it("pops back to the same draft under a drilled-in page", () => {
    const draft = {
      name: "Thread" as const,
      params: { draft: { draftId: "new-task:ask", title: "Ask about #1" } },
    };
    const state = push(select(home(), draft), "PullRequest", pullRequest.params);
    expect(workspaceDetailOpenStep(state, draft)).toEqual({ type: "pop", count: 1 });
  });

  it("stays when the pull request is already focused", () => {
    const state = select(home(), pullRequest);
    expect(workspaceDetailOpenStep(state, pullRequest)).toEqual({ type: "stay" });
  });

  it("pops back to a pull request under a drilled-in page", () => {
    const state = push(select(home(), pullRequest), "GitOverview");
    expect(workspaceDetailOpenStep(state, pullRequest)).toEqual({ type: "pop", count: 1 });
  });

  it("does not treat a different pull request as a match", () => {
    const other = {
      name: "PullRequest" as const,
      params: { ...pullRequest.params, number: 2 },
    };
    const state = push(select(home(), pullRequest), "GitOverview");
    expect(workspaceDetailOpenStep(state, other)).toEqual({ type: "push" });
  });
});
