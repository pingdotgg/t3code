import {
  AuthOrchestrationOperateScope,
  AuthSourceControlWriteScope,
  EnvironmentId,
  ProjectId,
  ThreadId,
  type ThreadPullRequestLink,
  type ThreadPullRequestSnapshot,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { pullRequestEnvironment } from "../state/pullRequests";
import { threadEnvironment } from "../state/threads";
import { useThreadActions } from "./useThreadActions";

const state = vi.hoisted(() => ({
  scopes: new Set<string>(),
  confirm: vi.fn<(message: string) => Promise<boolean>>(),
  settle: vi.fn(),
  close: vi.fn(),
  toasts: [] as { type?: string; title?: string; description?: string }[],
  pullRequests: [] as ThreadPullRequestLink[],
  closePullRequestsOnSettle: true,
}));

vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useCallback: (callback: unknown) => callback,
  useMemo: (create: () => unknown) => create(),
  useRef: (value: unknown) => ({ current: value }),
}));
vi.mock("@tanstack/react-router", () => ({
  useRouter: () => ({ state: { location: { href: "/" }, matches: [] }, navigate: async () => {} }),
}));
vi.mock("../state/session", async (original) => ({
  ...(await original<typeof import("../state/session")>()),
  readEnvironmentScope: (_environmentId: string, scope: string) => state.scopes.has(scope),
}));
vi.mock("../state/entities", async (original) => ({
  ...(await original<typeof import("../state/entities")>()),
  readEnvironmentServerConfigLoaded: () => true,
  readThreadShell: () => ({
    title: "Thread",
    projectId: ProjectId.make("project"),
    environmentId: "settle-close-env",
    pullRequests: state.pullRequests,
    pinnedAt: null,
    snoozedUntil: null,
    session: null,
  }),
}));
vi.mock("../localApi", () => ({
  readLocalApi: () => ({ dialogs: { confirm: state.confirm } }),
}));
vi.mock("../components/ui/toast", () => ({
  stackedThreadToast: (toast: unknown) => toast,
  toastManager: {
    add: (toast: { type?: string; title?: string; description?: string }) => {
      state.toasts.push(toast);
    },
  },
}));
vi.mock("./useSettings", () => ({
  useClientSettings: (select: (settings: { closePullRequestsOnSettle: boolean }) => unknown) =>
    select({ closePullRequestsOnSettle: state.closePullRequestsOnSettle }),
}));
vi.mock("./useHandleNewThread", () => ({ useNewThreadHandler: () => async () => {} }));
vi.mock("../composerDraftStore", () => ({ useComposerDraftStore: () => vi.fn() }));
vi.mock("../lib/composerDraftUploads", () => ({ releaseComposerDraftUploads: vi.fn() }));
vi.mock("../terminalUiStateStore", () => ({ useTerminalUiStateStore: () => vi.fn() }));
vi.mock("../uiStateStore", () => ({
  useUiStateStore: (select: (store: { markThreadVisited: () => void }) => unknown) =>
    select({ markThreadVisited: () => {} }),
}));
vi.mock("../lib/archivedThreadsState", () => ({ refreshArchivedThreadsForEnvironment: vi.fn() }));
vi.mock("../state/use-atom-query-runner", () => ({ useAtomQueryRunner: () => vi.fn() }));
vi.mock("../state/use-atom-command", () => ({
  useAtomCommand: (command: unknown) => {
    if (command === pullRequestEnvironment.runAction) return state.close;
    return vi.fn();
  },
}));
vi.mock("../state/use-orchestration-command", () => ({
  useOrchestrationCommand: (command: unknown) => {
    if (command === threadEnvironment.settle) return state.settle;
    return vi.fn().mockResolvedValue(AsyncResult.success(undefined));
  },
}));

const target = {
  environmentId: EnvironmentId.make("settle-close-env"),
  threadId: ThreadId.make("thread"),
};

function snapshot(input: Partial<ThreadPullRequestSnapshot> = {}): ThreadPullRequestSnapshot {
  return {
    state: "open",
    title: "Change",
    headBranch: "feature",
    baseBranch: "main",
    isDraft: false,
    updatedAt: "2026-01-01T00:00:00.000Z",
    syncedAt: "2026-01-01T00:00:00.000Z",
    ...input,
  };
}

function link(
  number: number,
  input: Partial<Omit<ThreadPullRequestLink, "number">> = {},
): ThreadPullRequestLink {
  return {
    host: "github.com",
    repository: "pingdotgg/t3code",
    number,
    url: `https://github.com/pingdotgg/t3code/pull/${number}`,
    source: "manual",
    linkedAt: "2026-01-01T00:00:00.000Z",
    snapshot: snapshot(),
    stack: null,
    ...input,
  };
}

beforeEach(() => {
  state.scopes = new Set([AuthOrchestrationOperateScope, AuthSourceControlWriteScope]);
  state.confirm.mockReset().mockResolvedValue(false);
  state.settle.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  state.close.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  state.toasts = [];
  state.pullRequests = [];
  state.closePullRequestsOnSettle = true;
});

describe("settleThread close open pull requests", () => {
  it("settles without asking when there are no open pull requests", async () => {
    state.pullRequests = [link(1, { snapshot: snapshot({ state: "merged" }) })];
    await useThreadActions().settleThread(target);
    expect(state.confirm).not.toHaveBeenCalled();
    expect(state.settle).toHaveBeenCalledOnce();
    expect(state.close).not.toHaveBeenCalled();
  });

  it("settles without asking when the setting is off", async () => {
    state.closePullRequestsOnSettle = false;
    state.pullRequests = [link(1)];
    await useThreadActions().settleThread(target);
    expect(state.confirm).not.toHaveBeenCalled();
    expect(state.settle).toHaveBeenCalledOnce();
    expect(state.close).not.toHaveBeenCalled();
  });

  it("settles without asking when source-control write is unavailable", async () => {
    state.scopes = new Set([AuthOrchestrationOperateScope]);
    state.pullRequests = [link(1)];
    await useThreadActions().settleThread(target);
    expect(state.confirm).not.toHaveBeenCalled();
    expect(state.settle).toHaveBeenCalledOnce();
    expect(state.close).not.toHaveBeenCalled();
  });

  it("closes open pull requests after settle when confirmed", async () => {
    state.pullRequests = [link(7), link(8, { snapshot: snapshot({ state: "closed" }) })];
    state.confirm.mockResolvedValue(true);
    await useThreadActions().settleThread(target);
    expect(state.confirm).toHaveBeenCalledOnce();
    expect(state.settle).toHaveBeenCalledOnce();
    expect(state.close).toHaveBeenCalledExactlyOnceWith({
      environmentId: target.environmentId,
      input: {
        projectId: ProjectId.make("project"),
        host: "github.com",
        repository: "pingdotgg/t3code",
        number: 7,
        action: "close",
      },
    });
    expect(state.toasts).toEqual([{ type: "success", title: "Closed 1 pull request" }]);
  });

  it("settles without closing when the confirm is declined", async () => {
    state.pullRequests = [link(3)];
    state.confirm.mockResolvedValue(false);
    await useThreadActions().settleThread(target);
    expect(state.settle).toHaveBeenCalledOnce();
    expect(state.close).not.toHaveBeenCalled();
    expect(state.toasts).toEqual([]);
  });

  it("keeps the settle when a close fails", async () => {
    state.pullRequests = [link(9)];
    state.confirm.mockResolvedValue(true);
    state.close.mockResolvedValue(AsyncResult.failure(Cause.fail(new Error("denied"))));
    const result = await useThreadActions().settleThread(target);
    expect(result._tag).toBe("Success");
    expect(state.toasts).toEqual([
      {
        type: "error",
        title: "Closed 0 of 1 pull requests",
        description: "#9: denied",
      },
    ]);
  });
});
