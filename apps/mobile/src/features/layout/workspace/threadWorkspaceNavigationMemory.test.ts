import * as NodeModule from "node:module";
import { describe, expect, it, vi } from "vite-plus/test";
import type {
  StackNavigationState,
  StackRouter as StackRouterType,
} from "@react-navigation/native";

vi.mock("@react-navigation/native", () => ({ useNavigation: vi.fn() }));

import {
  isFocusedThreadWorkspace,
  rememberFocusedThreadWorkspace,
  rememberedThreadWorkspaceNavigationState,
} from "./threadWorkspaceNavigationMemory";
import { readThreadWorkspaceLocation } from "./workspacePaneMemory";

function loadRouters() {
  const require = NodeModule.createRequire(import.meta.url);
  const nativePackage = require.resolve("@react-navigation/native/package.json");
  const requireFromNative = NodeModule.createRequire(nativePackage);
  const corePackage = requireFromNative.resolve("@react-navigation/core/package.json");
  const requireFromCore = NodeModule.createRequire(corePackage);
  return requireFromCore("@react-navigation/routers") as {
    readonly CommonActions: typeof import("@react-navigation/native").CommonActions;
    readonly StackActions: typeof import("@react-navigation/native").StackActions;
    readonly StackRouter: typeof StackRouterType;
  };
}

const { CommonActions, StackActions, StackRouter } = loadRouters();
const router = StackRouter({});
const routeNames = [
  "Home",
  "Thread",
  "ThreadReview",
  "ThreadReviewFile",
  "ThreadFiles",
  "ThreadFile",
  "ThreadReviewComment",
];
const options = {
  routeNames,
  routeParamList: Object.fromEntries(routeNames.map((name) => [name, undefined])),
  routeGetIdList: {},
};
type State = StackNavigationState<Record<string, object | undefined>>;
const initial = () => router.getInitialState(options);
function apply(state: State, action: Parameters<typeof router.getStateForAction>[1]) {
  const next = router.getStateForAction(state, action, options);
  if (!next) throw new Error("Router rejected the navigation action");
  return next as State;
}
const identity = (environmentId: string, threadId: string) => ({ environmentId, threadId });

function openReviewFile(
  state: State,
  params: { environmentId: string; threadId: string },
  scope: "staged" | "unstaged" = "unstaged",
) {
  let next = apply(state, StackActions.push("Thread", params));
  next = apply(next, StackActions.push("ThreadReview", params));
  return apply(
    next,
    StackActions.push("ThreadReviewFile", {
      ...params,
      reviewSectionId: "git:working-tree",
      reviewFilePath: "src/rates.ts",
      reviewWorkingTreeScope: scope,
    }),
  );
}

describe("native per-thread workspace restoration", () => {
  it("restores a diff above its own chat/tree and remembers explicit Back to tree then chat", () => {
    const first = identity("restore-env", "thread-a");
    const second = identity("restore-env", "thread-b");
    const opened = openReviewFile(initial(), first, "staged");
    rememberFocusedThreadWorkspace(opened);
    let switched = apply(initial(), StackActions.push("Thread", second));
    rememberFocusedThreadWorkspace(switched);
    const restored = rememberedThreadWorkspaceNavigationState(switched, first);
    expect(restored).not.toBeNull();
    switched = apply(switched, CommonActions.reset(restored!));
    expect(switched.routes.map((route) => route.name)).toEqual([
      "Home",
      "Thread",
      "ThreadReview",
      "ThreadReviewFile",
    ]);
    expect(switched.routes[1]?.params).toEqual(first);
    expect(switched.routes.at(-1)?.params).toMatchObject({
      ...first,
      reviewSectionId: "git:working-tree",
      reviewFilePath: "src/rates.ts",
      reviewWorkingTreeScope: "staged",
    });

    const backToTree = apply(switched, StackActions.pop());
    rememberFocusedThreadWorkspace(backToTree);
    const treeRestored = apply(
      backToTree,
      CommonActions.reset(rememberedThreadWorkspaceNavigationState(backToTree, first)!),
    );
    expect(treeRestored.routes.at(-1)?.name).toBe("ThreadReview");
    expect(treeRestored.routes.at(-1)?.params).not.toHaveProperty("reviewFilePath");

    const backToChat = apply(backToTree, StackActions.pop());
    rememberFocusedThreadWorkspace(backToChat);
    expect(backToChat.routes.at(-1)?.name).toBe("Thread");
    expect(rememberedThreadWorkspaceNavigationState(backToChat, first)).toBeNull();
  });

  it("keeps environments isolated and does not let the comment sheet overwrite its underlying diff", () => {
    const first = identity("isolated-env-one", "same-thread-id");
    const second = identity("isolated-env-two", "same-thread-id");
    const opened = openReviewFile(initial(), first);
    rememberFocusedThreadWorkspace(opened);
    const comment = apply(opened, StackActions.push("ThreadReviewComment", first));
    rememberFocusedThreadWorkspace(comment);
    expect(readThreadWorkspaceLocation(first.environmentId, first.threadId)?.name).toBe(
      "ThreadReviewFile",
    );
    const secondChat = apply(initial(), StackActions.push("Thread", second));
    rememberFocusedThreadWorkspace(secondChat);
    expect(rememberedThreadWorkspaceNavigationState(secondChat, second)).toBeNull();
    expect(rememberedThreadWorkspaceNavigationState(secondChat, first)?.routes.at(-1)?.name).toBe(
      "ThreadReviewFile",
    );
  });

  it("recognizes the current thread while its viewer is open and reconstructs an Android peer above Home", () => {
    const current = identity("android-restore-env", "active-thread");
    const opened = openReviewFile(initial(), current);
    rememberFocusedThreadWorkspace(opened);
    expect(isFocusedThreadWorkspace(opened, current)).toBe(true);
    expect(isFocusedThreadWorkspace(opened, identity("android-restore-env", "other-thread"))).toBe(
      false,
    );
    const peer = rememberedThreadWorkspaceNavigationState(opened, current, true);
    expect(peer?.routes.map((route) => route.name)).toEqual([
      "Home",
      "Thread",
      "ThreadReview",
      "ThreadReviewFile",
    ]);
  });

  it("restores all-files scope without turning it into a single-file view", () => {
    const params = identity("scope-restore-env", "all-files-thread");
    const opened = apply(
      initial(),
      StackActions.push("ThreadReviewFile", {
        ...params,
        reviewSectionId: "git:working-tree",
        reviewWorkingTreeScope: "unstaged",
      }),
    );
    rememberFocusedThreadWorkspace(opened);
    const restored = apply(
      initial(),
      CommonActions.reset(rememberedThreadWorkspaceNavigationState(initial(), params)!),
    );
    expect(restored.routes.at(-1)?.params).toMatchObject({
      ...params,
      reviewWorkingTreeScope: "unstaged",
    });
    expect(restored.routes.at(-1)?.params).not.toHaveProperty("reviewFilePath");
  });
});
