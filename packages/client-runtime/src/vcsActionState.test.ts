import {
  EnvironmentId,
  type GitActionProgressEvent,
  type GitRunStackedActionResult,
  type VcsCreateRefResult,
  type VcsCreateWorktreeResult,
  type VcsFetchResult,
  type VcsPullResult,
  type VcsPushResult,
  type VcsSyncResult,
  type VcsStatusResult,
  type VcsSwitchRefResult,
} from "@t3tools/contracts";
import { AtomRegistry } from "effect/unstable/reactivity";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  type VcsActionClient,
  createVcsActionManager,
  EMPTY_VCS_ACTION_STATE,
} from "./vcsActionState.ts";

let atomRegistry = AtomRegistry.make();

function resetAtomRegistry() {
  atomRegistry.dispose();
  atomRegistry = AtomRegistry.make();
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const TARGET = { environmentId: EnvironmentId.make("env-local"), cwd: "/repo" } as const;

const BASE_STATUS: VcsStatusResult = {
  isRepo: true,
  hasPrimaryRemote: true,
  isDefaultRef: false,
  refName: "feature/test",
  hasWorkingTreeChanges: true,
  workingTree: { files: [], insertions: 0, deletions: 0 },
  hasUpstream: true,
  aheadCount: 0,
  behindCount: 0,
  pr: null,
};

function createPhaseStartedEvent(): Extract<GitActionProgressEvent, { kind: "phase_started" }> {
  return {
    actionId: "action-123",
    cwd: "/repo",
    action: "commit_push",
    kind: "phase_started",
    phase: "commit",
    label: "Committing...",
  };
}

function createHookStartedEvent(): Extract<GitActionProgressEvent, { kind: "hook_started" }> {
  return {
    actionId: "action-123",
    cwd: "/repo",
    action: "commit_push",
    kind: "hook_started",
    hookName: "post-commit",
  };
}

function createHookOutputEvent(): Extract<GitActionProgressEvent, { kind: "hook_output" }> {
  return {
    actionId: "action-123",
    cwd: "/repo",
    action: "commit_push",
    kind: "hook_output",
    hookName: "post-commit",
    stream: "stdout",
    text: "hook output",
  };
}

function createHookFinishedEvent(): Extract<GitActionProgressEvent, { kind: "hook_finished" }> {
  return {
    actionId: "action-123",
    cwd: "/repo",
    action: "commit_push",
    kind: "hook_finished",
    hookName: "post-commit",
    exitCode: 0,
    durationMs: 12,
  };
}

function createActionFinishedEvent(): Extract<GitActionProgressEvent, { kind: "action_finished" }> {
  return {
    actionId: "action-123",
    cwd: "/repo",
    action: "commit_push",
    kind: "action_finished",
    result: {
      action: "commit_push",
      branch: { status: "skipped_not_requested" },
      commit: { status: "created", commitSha: "abc123", subject: "Test commit" },
      push: {
        status: "pushed",
        branch: "feature/test",
        upstreamBranch: "origin/feature/test",
      },
      pr: { status: "skipped_not_requested" },
      toast: {
        title: "Done",
        description: "Action finished",
        cta: { kind: "none" },
      },
    } satisfies GitRunStackedActionResult,
  };
}

function createMockClient() {
  const refreshDeferred = createDeferred<VcsStatusResult>();
  const pullDeferred = createDeferred<VcsPullResult>();
  const fetchDeferred = createDeferred<VcsFetchResult>();
  const pushDeferred = createDeferred<VcsPushResult>();
  const syncDeferred = createDeferred<VcsSyncResult>();
  const switchRefDeferred = createDeferred<VcsSwitchRefResult>();
  const createRefDeferred = createDeferred<VcsCreateRefResult>();
  const createWorktreeDeferred = createDeferred<VcsCreateWorktreeResult>();
  const initDeferred = createDeferred<void>();
  const runChangeRequestDeferred = createDeferred<GitRunStackedActionResult>();
  let runChangeRequestProgressListener: ((event: GitActionProgressEvent) => void) | null = null;

  const client: VcsActionClient = {
    refreshStatus: vi.fn(() => refreshDeferred.promise),
    pull: vi.fn(() => pullDeferred.promise),
    fetch: vi.fn(() => fetchDeferred.promise),
    push: vi.fn(() => pushDeferred.promise),
    sync: vi.fn(() => syncDeferred.promise),
    switchRef: vi.fn(() => switchRefDeferred.promise),
    createRef: vi.fn(() => createRefDeferred.promise),
    createWorktree: vi.fn(() => createWorktreeDeferred.promise),
    init: vi.fn(() => initDeferred.promise),
    runChangeRequest: vi.fn((_, options) => {
      runChangeRequestProgressListener = options?.onProgress ?? null;
      return runChangeRequestDeferred.promise;
    }),
  };

  return {
    client,
    refreshDeferred,
    pullDeferred,
    fetchDeferred,
    pushDeferred,
    syncDeferred,
    switchRefDeferred,
    createRefDeferred,
    createWorktreeDeferred,
    initDeferred,
    runChangeRequestDeferred,
    emitProgress(event: GitActionProgressEvent) {
      runChangeRequestProgressListener?.(event);
    },
  };
}

describe("createVcsActionManager", () => {
  afterEach(() => {
    resetAtomRegistry();
  });

  it("tracks refreshStatus progress and clears state on success", async () => {
    const mock = createMockClient();
    const manager = createVcsActionManager({
      getRegistry: () => atomRegistry,
      getClient: () => mock.client,
    });

    const promise = manager.refreshStatus(TARGET, mock.client);

    expect(manager.getSnapshot(TARGET)).toMatchObject({
      isRunning: true,
      operation: "refresh_status",
      currentLabel: "Refreshing source control status",
      error: null,
    });

    mock.refreshDeferred.resolve(BASE_STATUS);

    await expect(promise).resolves.toEqual(BASE_STATUS);
    expect(manager.getSnapshot(TARGET)).toEqual(EMPTY_VCS_ACTION_STATE);
  });

  it("tracks runChangeRequest progress events", async () => {
    const mock = createMockClient();
    const onProgress = vi.fn();
    const manager = createVcsActionManager({
      getRegistry: () => atomRegistry,
      getClient: () => mock.client,
      getActionId: () => "action-123",
    });

    const promise = manager.runChangeRequest(
      TARGET,
      { action: "commit_push", commitMessage: "Test commit" },
      { client: mock.client, gitStatus: BASE_STATUS, onProgress },
    );

    expect(manager.getSnapshot(TARGET)).toMatchObject({
      isRunning: true,
      operation: "run_change_request",
      actionId: "action-123",
      currentLabel: "Committing...",
      error: null,
    });

    mock.emitProgress(createPhaseStartedEvent());
    expect(manager.getSnapshot(TARGET).currentLabel).toBe("Committing...");
    expect(onProgress).toHaveBeenLastCalledWith(createPhaseStartedEvent());

    mock.emitProgress(createHookStartedEvent());
    expect(manager.getSnapshot(TARGET)).toMatchObject({
      currentLabel: "Running post-commit...",
      hookName: "post-commit",
      isRunning: true,
    });

    mock.emitProgress(createHookOutputEvent());
    expect(manager.getSnapshot(TARGET).lastOutputLine).toBe("hook output");

    mock.emitProgress(createHookFinishedEvent());
    expect(manager.getSnapshot(TARGET)).toMatchObject({
      currentLabel: "Committing...",
      hookName: null,
      lastOutputLine: null,
    });

    const result = createActionFinishedEvent().result;
    mock.runChangeRequestDeferred.resolve(result);

    await expect(promise).resolves.toEqual(result);
    expect(manager.getSnapshot(TARGET)).toEqual(EMPTY_VCS_ACTION_STATE);
  });

  it("stores the error when an operation fails", async () => {
    const mock = createMockClient();
    const manager = createVcsActionManager({
      getRegistry: () => atomRegistry,
      getClient: () => mock.client,
    });

    const promise = manager.pull(TARGET, mock.client);

    mock.pullDeferred.reject(new Error("Pull failed."));

    await expect(promise).rejects.toThrow("Pull failed.");
    expect(manager.getSnapshot(TARGET)).toMatchObject({
      isRunning: false,
      operation: "pull",
      currentLabel: null,
      error: "Pull failed.",
    });
  });

  it("invalidates after successful mutations but not refreshStatus", async () => {
    const mock = createMockClient();
    const onInvalidate = vi.fn();
    const manager = createVcsActionManager({
      getRegistry: () => atomRegistry,
      getClient: () => mock.client,
      onInvalidate,
    });

    const refreshPromise = manager.refreshStatus(TARGET, mock.client);
    mock.refreshDeferred.resolve(BASE_STATUS);
    await expect(refreshPromise).resolves.toEqual(BASE_STATUS);
    expect(onInvalidate).not.toHaveBeenCalled();

    const pullPromise = manager.pull(TARGET, mock.client);
    const pullResult: VcsPullResult = {
      status: "skipped_up_to_date",
      refName: "main",
      upstreamRef: null,
    };
    mock.pullDeferred.resolve(pullResult);
    await expect(pullPromise).resolves.toEqual(pullResult);
    expect(onInvalidate).toHaveBeenCalledWith(TARGET);
  });

  it("returns null when no client is available", async () => {
    const manager = createVcsActionManager({
      getRegistry: () => atomRegistry,
      getClient: () => null,
    });

    await expect(manager.switchRef(TARGET, { refName: "main" })).resolves.toBeNull();
    expect(manager.getSnapshot(TARGET)).toEqual(EMPTY_VCS_ACTION_STATE);
  });
});
