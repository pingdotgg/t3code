import * as NodeModule from "node:module";
import type { NavigationState } from "@react-navigation/native";
import type { PullRequestDetail, PullRequestLinkedThreadsResult } from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

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
  useRoute: () => state.routes[state.index],
  useNavigationState: (selector: (state: NavigationState) => unknown) => selector(state),
  useFocusEffect: (callback: () => unknown) => callback(),
}));
vi.mock("react", () => ({
  useCallback: (callback: unknown) => callback,
  useRef: (current: unknown) => ({ current }),
  useState: (initial: unknown) => [initial, () => {}],
}));
vi.mock("react-native", () => ({
  Platform: { OS: "android" },
  Alert: { alert: vi.fn() },
  Keyboard: {
    isVisible: () => keyboardVisible,
    dismiss: () => {
      keyboardVisible = false;
    },
  },
  BackHandler: {
    addEventListener: (_event: string, callback: () => boolean) => {
      hardwareBack = callback;
      return { remove: () => {} };
    },
  },
}));
vi.mock("../workspace/WorkspaceTabsContext", () => ({
  useWorkspaceTabs: () => ({ dispatch: selectTab }),
}));
vi.mock("../../state/entities", () => ({
  useThreadShell: () => ({ projectId: "project-a" }),
  useEnvironmentServerConfig: () => null,
}));
vi.mock("../../state/query", () => ({ useEnvironmentQuery: () => ({ data: null }) }));
vi.mock("../../state/session", () => ({ useEnvironmentScope: () => true }));
vi.mock("../../state/pull-requests", () => ({ composerPullRequests: {} }));
vi.mock("../../state/use-composer-drafts", () => ({
  waitForComposerDraftsLoaded: async () => {},
  createNewTaskDraft: () => "draft-pr",
  getComposerDraftSnapshot: () => ({ text: "", context: { records: [] } }),
  insertComposerDraftContext: () => true,
  setComposerDraftText: () => {},
  updateComposerDraftSettings: () => {},
}));
vi.mock("../../lib/openExternalUrl", () => ({ tryOpenExternalUrl: async () => true }));
vi.mock("../../lib/uuid", () => ({ uuidv4: () => "context-pr" }));
vi.mock("./usePullRequestConnected", () => ({ usePullRequestConnected: () => true }));
vi.mock("./usePullRequestDiff", () => ({
  pullRequestTarget: (params: { environmentId: string; projectId: string }) => ({
    environmentId: params.environmentId,
    input: { projectId: params.projectId },
  }),
}));

import { useOpenPullRequest } from "../../native/useOpenPullRequest";
import { useAndroidWorkspaceBack } from "../workspace/useAndroidWorkspaceNavigation";
import { newTaskSubmitNavigationAction } from "../threads/new-task-submit-navigation";
import { usePullRequestThreads } from "./usePullRequestThreads";

const { CommonActions, StackActions, StackRouter } = loadRouters();
const router = StackRouter({});
const options = {
  routeNames: ["Home", "Thread", "GitOverview", "PullRequest", "NewTaskSheet"],
  routeParamList: {},
  routeGetIdList: {},
};
const thread = { environmentId: "environment-a", threadId: "thread-a" };
const pullRequest = {
  environmentId: "environment-a",
  projectId: "project-a",
  repository: "owner/repository",
  number: 42,
  host: "github.com",
};
const pr = {
  number: pullRequest.number,
  url: "https://github.com/owner/repository/pull/42",
  title: "Fix the back stack",
  headBranch: "fix/back-stack",
  baseBranch: "main",
  state: "open",
  isDraft: false,
} as PullRequestDetail;
let state = router.getInitialState(options);
let keyboardVisible = false;
let hardwareBack: (() => boolean) | undefined;
const selectTab = vi.fn();
type RouterAction = Parameters<typeof router.getStateForAction>[1];

function apply(action: RouterAction) {
  const next = router.getStateForAction(state, action, options);
  if (!next) throw new Error(`Router rejected ${action.type}`);
  state = router.getRehydratedState(next, options);
}

const navigation = {
  getState: () => state,
  canGoBack: () => router.getStateForAction(state, CommonActions.goBack(), options) !== null,
  goBack: () => apply(CommonActions.goBack()),
  navigate: (name: string, params: object) => apply(CommonActions.navigate(name, params)),
  dispatch: (action: RouterAction | ((state: NavigationState) => RouterAction)) =>
    apply(typeof action === "function" ? action(state) : action),
};

function names() {
  return state.routes.map((route) => route.name);
}

function openChat() {
  apply(StackActions.push("Thread", thread));
  return state.routes[state.index]?.key;
}

async function openPullRequest() {
  await useOpenPullRequest()(pr.url);
}

beforeEach(() => {
  state = router.getInitialState(options);
  keyboardVisible = false;
  hardwareBack = undefined;
  selectTab.mockClear();
});

describe("Android contextual PR navigation", () => {
  it("opens a chat link above the same chat and toolbar Back restores it", async () => {
    const chatKey = openChat();
    await openPullRequest();
    expect(names()).toEqual(["Home", "Thread", "PullRequest"]);
    const back = useAndroidWorkspaceBack("pullRequests");
    expect(selectTab).not.toHaveBeenCalled();
    back();
    expect(names()).toEqual(["Home", "Thread"]);
    expect(state.routes[state.index]?.key).toBe(chatKey);
  });

  it("replaces GitOverview and native Back returns to the same chat", async () => {
    const chatKey = openChat();
    apply(StackActions.push("GitOverview", thread));
    await useOpenPullRequest({ replace: true })(pr.url);
    expect(names()).toEqual(["Home", "Thread", "PullRequest"]);
    useAndroidWorkspaceBack("pullRequests");
    expect(hardwareBack?.()).toBe(false);
    apply(CommonActions.goBack());
    expect(state.routes[state.index]?.key).toBe(chatKey);
  });

  it("dismisses the keyboard before yielding subsequent Back to the native stack", async () => {
    openChat();
    await openPullRequest();
    const previous = state;
    useAndroidWorkspaceBack("pullRequests");
    keyboardVisible = true;
    expect(hardwareBack?.()).toBe(true);
    expect(keyboardVisible).toBe(false);
    expect(state).toBe(previous);
    expect(hardwareBack?.()).toBe(false);
    expect(state).toBe(previous);
    apply(CommonActions.goBack());
    expect(names()).toEqual(["Home", "Thread"]);
  });

  it("gives a cold-linked PR a route back to its list", () => {
    apply(
      CommonActions.reset({ index: 0, routes: [{ name: "PullRequest", params: pullRequest }] }),
    );
    useAndroidWorkspaceBack("pullRequests");
    expect(selectTab).toHaveBeenCalledWith({ type: "select", tab: "pullRequests" });
    expect(hardwareBack?.()).toBe(true);
    expect(names()).toEqual(["Home"]);
  });

  it("opens a linked thread without losing the PR or switching tabs", async () => {
    openChat();
    await openPullRequest();
    const prKey = state.routes[state.index]?.key;
    const linked = { id: "thread-b" } as PullRequestLinkedThreadsResult["threads"][number];
    usePullRequestThreads(pullRequest, pr).openThread(linked);
    expect(names()).toEqual(["Home", "Thread", "PullRequest", "Thread"]);
    const back = useAndroidWorkspaceBack("threads");
    expect(selectTab).not.toHaveBeenCalled();
    back();
    expect(state.routes[state.index]?.key).toBe(prKey);
  });

  it("keeps the old chat and PR intact when a new PR draft is cancelled", async () => {
    openChat();
    await openPullRequest();
    const previous = state.routes;
    await usePullRequestThreads(pullRequest, pr).ask();
    expect(names()).toEqual(["Home", "Thread", "PullRequest", "NewTaskSheet"]);
    expect(selectTab).not.toHaveBeenCalled();
    apply(CommonActions.goBack());
    expect(state.routes).toEqual(previous);
  });

  it("clears old Android history on an accepted immediate first send", async () => {
    const oldChatKey = openChat();
    await openPullRequest();
    const homeKey = state.routes[0]?.key;
    await usePullRequestThreads(pullRequest, pr).ask();
    apply(
      newTaskSubmitNavigationAction({
        state,
        params: { ...thread, threadId: "new-thread" },
        queued: false,
        android: true,
      }),
    );
    expect(names()).toEqual(["Home", "Thread"]);
    expect(state.routes[0]?.key).toBe(homeKey);
    expect(state.routes[1]?.key).not.toBe(oldChatKey);
    expect(state.routes[1]?.params).toEqual({ ...thread, threadId: "new-thread" });
    expect(state.routes.some((route) => route.key === oldChatKey)).toBe(false);
    useAndroidWorkspaceBack("threads");
    expect(hardwareBack?.()).toBe(false);
    apply(CommonActions.goBack());
    expect(names()).toEqual(["Home"]);
    expect(navigation.canGoBack()).toBe(false);
  });

  it("keeps old history when a first send queues offline or waits for uploads", async () => {
    openChat();
    await openPullRequest();
    const previous = state.routes;
    await usePullRequestThreads(pullRequest, pr).ask();
    apply(
      newTaskSubmitNavigationAction({
        state,
        params: { ...thread, threadId: "queued-thread" },
        queued: true,
        android: true,
      }),
    );
    expect(state.routes).toEqual(previous);
  });

  it("retains the existing iOS sheet replacement", async () => {
    openChat();
    await openPullRequest();
    await usePullRequestThreads(pullRequest, pr).ask();
    apply(
      newTaskSubmitNavigationAction({
        state,
        params: { ...thread, threadId: "new-thread" },
        queued: false,
        android: false,
      }),
    );
    expect(names()).toEqual(["Home", "Thread", "PullRequest", "Thread"]);
  });
});
