import {
  AuthOrchestrationOperateScope,
  AuthSourceControlWriteScope,
  EnvironmentAuthorizationError,
  EnvironmentId,
  ProjectId,
  ThreadId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

const state = vi.hoisted(() => ({
  scopes: new Map<string, Set<string>>(),
  threads: [] as {
    environmentId: EnvironmentId;
    id: ThreadId;
    projectId: ProjectId;
    title: string;
    worktreePath: string | null;
    session: { status: "ready" | "stopped" } | null;
    latestTurn: null;
  }[],
  requests: [] as { action: string; environmentId: string; input: { threadId?: string } }[],
  localEffects: [] as string[],
  confirm: vi.fn<(message: string) => Promise<boolean>>(),
  afterRequest: undefined as ((action: string) => void) | undefined,
}));

vi.mock("react", () => ({
  useCallback: (callback: unknown) => callback,
  useMemo: (factory: () => unknown) => factory(),
  useRef: (current: unknown) => ({ current }),
}));
vi.mock("@tanstack/react-router", () => ({
  useRouter: () => ({ state: { matches: [] }, navigate: async () => {} }),
}));
vi.mock("../state/session", () => ({
  environmentSession: { sessionStateAtom: "session" },
  readEnvironmentScope: (environmentId: string, scope: string) =>
    state.scopes.get(environmentId)?.has(scope) === true,
}));
vi.mock("../state/use-atom-command", () => ({
  useAtomCommand:
    (action: string) =>
    async (request: { environmentId: string; input: { threadId?: string } }) => {
      state.requests.push({ action, ...request });
      const scope =
        action === "removeWorktree" ? AuthSourceControlWriteScope : AuthOrchestrationOperateScope;
      if (!state.scopes.get(request.environmentId)?.has(scope)) {
        return AsyncResult.failure(Cause.fail(new Error("Server denied the request")));
      }
      state.afterRequest?.(action);
      return AsyncResult.success(undefined);
    },
}));
vi.mock("../state/use-atom-query-runner", () => ({
  useAtomQueryRunner: () => async (environmentId: string) =>
    AsyncResult.success({
      authenticated: true,
      scopes: [...(state.scopes.get(environmentId) ?? [])],
    }),
}));
vi.mock("../state/threads", () => ({
  threadEnvironment: Object.fromEntries(
    [
      "archive",
      "unarchive",
      "delete",
      "settle",
      "unsettle",
      "pin",
      "unpin",
      "reorderPin",
      "snooze",
      "unsnooze",
      "stopSession",
    ].map((action) => [action, action]),
  ),
}));
vi.mock("../state/vcs", () => ({
  vcsEnvironment: { removeWorktree: "removeWorktree", refreshStatus: "refreshStatus" },
}));
vi.mock("../state/entities", () => ({
  readEnvironmentSupportsPinning: () => true,
  readEnvironmentSupportsPinReorder: () => true,
  readEnvironmentSupportsSettlement: () => true,
  readEnvironmentSupportsSnooze: () => true,
  readThreadShell: (ref: ScopedThreadRef) =>
    state.threads.find(
      (thread) => thread.environmentId === ref.environmentId && thread.id === ref.threadId,
    ) ?? null,
  readThreadShells: () => state.threads,
  readEnvironmentThreadRefs: (environmentId: EnvironmentId) =>
    state.threads
      .filter((thread) => thread.environmentId === environmentId)
      .map((thread) => ({ environmentId, threadId: thread.id })),
  readProject: () => ({ workspaceRoot: "/project" }),
}));
vi.mock("../components/Sidebar.logic", () => ({
  getFallbackThreadIdAfterDelete: () => null,
  pinOrderKeyBetween: () => "a",
}));
vi.mock("../composerDraftStore", () => ({
  useComposerDraftStore: (select: (store: unknown) => unknown) =>
    select({
      clearDraftThread: () => state.localEffects.push("clear-draft"),
      clearProjectDraftThreadById: () => state.localEffects.push("clear-project-draft"),
    }),
}));
vi.mock("../terminalUiStateStore", () => ({
  useTerminalUiStateStore: (select: (store: unknown) => unknown) =>
    select({
      clearTerminalUiState: () => state.localEffects.push("clear-terminal-ui"),
    }),
}));
vi.mock("../uiStateStore", () => ({
  useUiStateStore: (select: (store: unknown) => unknown) =>
    select({
      markThreadVisited: () => state.localEffects.push("mark-visited"),
    }),
}));
vi.mock("../lib/archivedThreadsState", () => ({
  refreshArchivedThreadsForEnvironment: () => state.localEffects.push("refresh-archive"),
}));
vi.mock("../lib/composerDraftUploads", () => ({
  releaseComposerDraftUploads: () => state.localEffects.push("release-uploads"),
}));
vi.mock("../localApi", () => ({
  readLocalApi: () => ({ dialogs: { confirm: state.confirm } }),
}));
vi.mock("../threadRoutes", () => ({
  resolveThreadRouteRef: () => null,
  buildThreadRouteParams: (ref: ScopedThreadRef) => ref,
}));
vi.mock("../components/ui/toast", () => ({
  stackedThreadToast: (toast: unknown) => toast,
  toastManager: { add: () => {} },
}));
vi.mock("./useHandleNewThread", () => ({ useNewThreadHandler: () => async () => {} }));
vi.mock("./useSettings", () => ({
  useClientSettings: (select: (settings: unknown) => unknown) =>
    select({
      sidebarThreadSortOrder: "createdAt",
      confirmThreadDelete: true,
      confirmThreadUnpin: true,
    }),
}));

import { useThreadActions } from "./useThreadActions";

const primary = EnvironmentId.make("primary");
const secondary = EnvironmentId.make("secondary");
const target = { environmentId: secondary, threadId: ThreadId.make("thread") };
type ThreadActions = ReturnType<typeof useThreadActions>;
const operations = [
  {
    name: "archive",
    run: (actions: ThreadActions, ref: ScopedThreadRef) => actions.archiveThread(ref),
  },
  {
    name: "unarchive",
    run: (actions: ThreadActions, ref: ScopedThreadRef) => actions.unarchiveThread(ref),
  },
  {
    name: "settle",
    run: (actions: ThreadActions, ref: ScopedThreadRef) => actions.settleThread(ref),
  },
  {
    name: "unsettle",
    run: (actions: ThreadActions, ref: ScopedThreadRef) => actions.unsettleThread(ref),
  },
  {
    name: "snooze",
    run: (actions: ThreadActions, ref: ScopedThreadRef) =>
      actions.snoozeThread(ref, "2099-01-01T00:00:00Z"),
  },
  {
    name: "unsnooze",
    run: (actions: ThreadActions, ref: ScopedThreadRef) => actions.unsnoozeThread(ref),
  },
  { name: "pin", run: (actions: ThreadActions, ref: ScopedThreadRef) => actions.pinThread(ref) },
  {
    name: "unpin",
    run: (actions: ThreadActions, ref: ScopedThreadRef) => actions.unpinThread(ref),
  },
  {
    name: "reorderPin",
    run: (actions: ThreadActions, ref: ScopedThreadRef) => actions.reorderPinnedThread(ref, "b"),
  },
] as const;

beforeEach(() => {
  state.scopes = new Map([
    [primary, new Set([AuthOrchestrationOperateScope])],
    [secondary, new Set<string>()],
  ]);
  state.threads = [
    {
      environmentId: secondary,
      id: target.threadId,
      projectId: ProjectId.make("project"),
      title: "Thread",
      worktreePath: null,
      session: null,
      latestTurn: null,
    },
  ];
  state.requests = [];
  state.localEffects = [];
  state.confirm.mockReset().mockResolvedValue(true);
  state.afterRequest = undefined;
});

describe("thread action permissions", () => {
  it.each(operations)("$name requires the target environment's grant", async ({ run }) => {
    const result = await run(useThreadActions(), target);
    expect(result._tag).toBe("Failure");
    expect(state.requests).toEqual([]);
    expect(state.localEffects).toEqual([]);
  });

  it.each(operations)("$name rechecks a retained callback after revocation", async ({ run }) => {
    state.scopes.get(secondary)!.add(AuthOrchestrationOperateScope);
    const actions = useThreadActions();
    state.scopes.get(secondary)!.clear();
    await run(actions, target);
    expect(state.requests).toEqual([]);
  });

  it.each(operations)(
    "$name works after the target gains only task permission",
    async ({ name, run }) => {
      const actions = useThreadActions();
      state.scopes.get(primary)!.clear();
      state.scopes.get(secondary)!.add(AuthOrchestrationOperateScope);
      expect((await run(actions, target))._tag).toBe("Success");
      expect(state.requests).toEqual([
        expect.objectContaining({ action: name, environmentId: secondary }),
      ]);
    },
  );

  it.each(["confirmAndDeleteThread", "confirmAndUnpinThread"] as const)(
    "%s blocks a forbidden confirmation",
    async (action) => {
      await useThreadActions()[action](target);
      expect(state.confirm).not.toHaveBeenCalled();
      expect(state.requests).toEqual([]);
    },
  );

  it.each(["confirmAndDeleteThread", "confirmAndUnpinThread"] as const)(
    "%s rechecks after the confirmation",
    async (action) => {
      state.scopes.get(secondary)!.add(AuthOrchestrationOperateScope);
      const confirmation = deferred<boolean>();
      state.confirm.mockReturnValue(confirmation.promise);
      const result = useThreadActions()[action](target);
      expect(state.confirm).toHaveBeenCalledOnce();
      state.scopes.get(secondary)!.clear();
      confirmation.resolve(true);
      await result;
      expect(state.requests).toEqual([]);
      expect(state.localEffects).toEqual([]);
    },
  );

  it("identifies the missing task scope when thread deletion is denied", async () => {
    const result = await useThreadActions().deleteThread(target);

    expect(result._tag).toBe("Failure");
    if (result._tag !== "Failure") throw new Error("Expected permission denial");
    const error = Cause.squash(result.cause);
    expect(error).toBeInstanceOf(EnvironmentAuthorizationError);
    expect(error).toMatchObject({ requiredScope: AuthOrchestrationOperateScope });
    expect(state.requests).toEqual([]);
    expect(state.localEffects).toEqual([]);
  });

  it("deletes an archived thread only with its own environment's grant", async () => {
    state.threads = [];
    const actions = useThreadActions();
    await actions.deleteThread(target);
    expect(state.requests).toEqual([]);
    state.scopes.get(secondary)!.add(AuthOrchestrationOperateScope);
    expect((await actions.deleteThread(target))._tag).toBe("Success");
    expect(state.requests).toEqual([
      expect.objectContaining({ action: "delete", environmentId: secondary }),
    ]);
  });

  it("stops before delete and local cleanup when permission is revoked during session stop", async () => {
    state.scopes.get(secondary)!.add(AuthOrchestrationOperateScope);
    state.threads[0]!.session = { status: "ready" };
    state.afterRequest = () => state.scopes.get(secondary)!.clear();
    expect((await useThreadActions().deleteThread(target))._tag).toBe("Failure");
    expect(state.requests.map((request) => request.action)).toEqual(["stopSession"]);
    expect(state.localEffects).toEqual([]);
  });

  it("deletes a thread without terminal or source-control permission", async () => {
    state.scopes.get(secondary)!.add(AuthOrchestrationOperateScope);
    state.threads[0]!.worktreePath = "/worktrees/thread";
    expect((await useThreadActions().deleteThread(target))._tag).toBe("Success");
    expect(state.confirm).not.toHaveBeenCalled();
    expect(state.requests.map((request) => request.action)).toEqual(["delete"]);
    expect(state.localEffects).toContain("clear-terminal-ui");
  });

  it("does not request worktree removal after its grant is revoked during delete", async () => {
    state.scopes
      .get(secondary)!
      .add(AuthOrchestrationOperateScope)
      .add(AuthSourceControlWriteScope);
    state.threads[0]!.worktreePath = "/worktrees/thread";
    state.afterRequest = () => state.scopes.get(secondary)!.delete(AuthSourceControlWriteScope);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = await useThreadActions().deleteThread(target);
      expect(result._tag).toBe("Failure");
      if (result._tag !== "Failure") throw new Error("Expected permission denial");
      const error = Cause.squash(result.cause);
      expect(error).toBeInstanceOf(EnvironmentAuthorizationError);
      expect(error).toMatchObject({ requiredScope: AuthSourceControlWriteScope });
      expect(state.requests.map((request) => request.action)).toEqual(["delete"]);
      expect(state.localEffects).toContain("clear-terminal-ui");
    } finally {
      consoleError.mockRestore();
    }
  });
});
