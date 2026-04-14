import type {
  GitActionProgressEvent,
  GitCreateBranchResult,
  GitCreateWorktreeResult,
  GitCheckoutResult,
  GitPullResult,
  GitRunStackedActionResult,
  GitStatusResult,
} from "@t3tools/contracts";
import { AtomRegistry } from "effect/unstable/reactivity";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  type GitActionClient,
  createGitActionManager,
  EMPTY_GIT_ACTION_STATE,
} from "./gitActionState";

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

const TARGET = { environmentId: "env-local", cwd: "/repo" } as const;

const BASE_STATUS: GitStatusResult = {
  isRepo: true,
  hasOriginRemote: true,
  isDefaultBranch: false,
  branch: "feature/test",
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
  const refreshDeferred = createDeferred<GitStatusResult>();
  const pullDeferred = createDeferred<GitPullResult>();
  const checkoutDeferred = createDeferred<GitCheckoutResult>();
  const createBranchDeferred = createDeferred<GitCreateBranchResult>();
  const createWorktreeDeferred = createDeferred<GitCreateWorktreeResult>();
  const initDeferred = createDeferred<void>();
  const runStackedActionDeferred = createDeferred<GitRunStackedActionResult>();
  let runStackedActionProgressListener: ((event: GitActionProgressEvent) => void) | null = null;

  const client: GitActionClient = {
    refreshStatus: vi.fn(() => refreshDeferred.promise),
    pull: vi.fn(() => pullDeferred.promise),
    checkout: vi.fn(() => checkoutDeferred.promise),
    createBranch: vi.fn(() => createBranchDeferred.promise),
    createWorktree: vi.fn(() => createWorktreeDeferred.promise),
    init: vi.fn(() => initDeferred.promise),
    runStackedAction: vi.fn((_, options) => {
      runStackedActionProgressListener = options?.onProgress ?? null;
      return runStackedActionDeferred.promise;
    }),
  };

  return {
    client,
    refreshDeferred,
    pullDeferred,
    checkoutDeferred,
    createBranchDeferred,
    createWorktreeDeferred,
    initDeferred,
    runStackedActionDeferred,
    emitProgress(event: GitActionProgressEvent) {
      runStackedActionProgressListener?.(event);
    },
  };
}

describe("createGitActionManager", () => {
  afterEach(() => {
    resetAtomRegistry();
  });

  it("tracks refreshStatus progress and clears state on success", async () => {
    const mock = createMockClient();
    const manager = createGitActionManager({
      getRegistry: () => atomRegistry,
      getClient: () => mock.client,
    });

    const promise = manager.refreshStatus(TARGET, mock.client);

    expect(manager.getSnapshot(TARGET)).toMatchObject({
      isRunning: true,
      operation: "refresh_status",
      currentLabel: "Refreshing git status",
      error: null,
    });

    mock.refreshDeferred.resolve(BASE_STATUS);

    await expect(promise).resolves.toEqual(BASE_STATUS);
    expect(manager.getSnapshot(TARGET)).toEqual(EMPTY_GIT_ACTION_STATE);
  });

  it("tracks runStackedAction progress events", async () => {
    const mock = createMockClient();
    const manager = createGitActionManager({
      getRegistry: () => atomRegistry,
      getClient: () => mock.client,
      getActionId: () => "action-123",
    });

    const promise = manager.runStackedAction(
      TARGET,
      { action: "commit_push", commitMessage: "Test commit" },
      { client: mock.client, gitStatus: BASE_STATUS },
    );

    expect(manager.getSnapshot(TARGET)).toMatchObject({
      isRunning: true,
      operation: "run_stacked_action",
      actionId: "action-123",
      currentLabel: "Committing...",
      error: null,
    });

    mock.emitProgress(createPhaseStartedEvent());
    expect(manager.getSnapshot(TARGET).currentLabel).toBe("Committing...");

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
    mock.runStackedActionDeferred.resolve(result);

    await expect(promise).resolves.toEqual(result);
    expect(manager.getSnapshot(TARGET)).toEqual(EMPTY_GIT_ACTION_STATE);
  });

  it("stores the error when an operation fails", async () => {
    const mock = createMockClient();
    const manager = createGitActionManager({
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

  it("returns null when no client is available", async () => {
    const manager = createGitActionManager({
      getRegistry: () => atomRegistry,
      getClient: () => null,
    });

    await expect(manager.checkout(TARGET, { branch: "main" })).resolves.toBeNull();
    expect(manager.getSnapshot(TARGET)).toEqual(EMPTY_GIT_ACTION_STATE);
  });
});
