import { EnvironmentId, type GitStatusResult } from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  getGitStatusSnapshot,
  resetGitStatusStateForTests,
  refreshGitStatus,
  watchGitStatus,
} from "./gitStatusState";

function registerListener<T>(listeners: Set<(event: T) => void>, listener: (event: T) => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const gitStatusListeners = new Set<(event: GitStatusResult) => void>();
const ENVIRONMENT_ID = EnvironmentId.makeUnsafe("environment-local");
const OTHER_ENVIRONMENT_ID = EnvironmentId.makeUnsafe("environment-remote");
const TARGET = { environmentId: ENVIRONMENT_ID, cwd: "/repo" } as const;
const FRESH_TARGET = { environmentId: ENVIRONMENT_ID, cwd: "/fresh" } as const;

const BASE_STATUS: GitStatusResult = {
  isRepo: true,
  hasOriginRemote: true,
  isDefaultBranch: false,
  branch: "feature/push-status",
  hasWorkingTreeChanges: false,
  workingTree: { files: [], insertions: 0, deletions: 0 },
  hasUpstream: true,
  aheadCount: 0,
  behindCount: 0,
  pr: null,
};

const gitClient = {
  refreshStatus: vi.fn(async (input: { cwd: string }) => ({
    ...BASE_STATUS,
    branch: `${input.cwd}-refreshed`,
  })),
  onStatus: vi.fn((input: { cwd: string }, listener: (event: GitStatusResult) => void) =>
    registerListener(gitStatusListeners, listener),
  ),
};

function emitGitStatus(event: GitStatusResult) {
  for (const listener of gitStatusListeners) {
    listener(event);
  }
}

afterEach(() => {
  gitStatusListeners.clear();
  gitClient.onStatus.mockClear();
  gitClient.refreshStatus.mockClear();
  resetGitStatusStateForTests();
});

describe("gitStatusState", () => {
  it("starts fresh cwd state in a pending state", () => {
    expect(getGitStatusSnapshot(FRESH_TARGET)).toEqual({
      data: null,
      error: null,
      cause: null,
      isPending: true,
    });
  });

  it("shares one live subscription per cwd and updates the per-cwd atom snapshot", () => {
    const releaseA = watchGitStatus(TARGET, gitClient);
    const releaseB = watchGitStatus(TARGET, gitClient);

    expect(gitClient.onStatus).toHaveBeenCalledOnce();
    expect(getGitStatusSnapshot(TARGET)).toEqual({
      data: null,
      error: null,
      cause: null,
      isPending: true,
    });

    emitGitStatus(BASE_STATUS);

    expect(getGitStatusSnapshot(TARGET)).toEqual({
      data: BASE_STATUS,
      error: null,
      cause: null,
      isPending: false,
    });

    releaseA();
    expect(gitStatusListeners.size).toBe(1);

    releaseB();
    expect(gitStatusListeners.size).toBe(0);
  });

  it("refreshes git status through the unary RPC without restarting the stream", async () => {
    const release = watchGitStatus(TARGET, gitClient);

    emitGitStatus(BASE_STATUS);
    const refreshed = await refreshGitStatus(TARGET, gitClient);

    expect(gitClient.onStatus).toHaveBeenCalledOnce();
    expect(gitClient.refreshStatus).toHaveBeenCalledWith({ cwd: "/repo" });
    expect(refreshed).toEqual({ ...BASE_STATUS, branch: "/repo-refreshed" });
    expect(getGitStatusSnapshot(TARGET)).toEqual({
      data: BASE_STATUS,
      error: null,
      cause: null,
      isPending: false,
    });

    release();
  });

  it("keeps git status subscriptions isolated by environment when cwds match", () => {
    const localListeners = new Set<(event: GitStatusResult) => void>();
    const remoteListeners = new Set<(event: GitStatusResult) => void>();
    const localClient = {
      refreshStatus: vi.fn(),
      onStatus: vi.fn((_: { cwd: string }, listener: (event: GitStatusResult) => void) =>
        registerListener(localListeners, listener),
      ),
    };
    const remoteClient = {
      refreshStatus: vi.fn(),
      onStatus: vi.fn((_: { cwd: string }, listener: (event: GitStatusResult) => void) =>
        registerListener(remoteListeners, listener),
      ),
    };
    const remoteTarget = { environmentId: OTHER_ENVIRONMENT_ID, cwd: "/repo" } as const;

    const releaseLocal = watchGitStatus(TARGET, localClient);
    const releaseRemote = watchGitStatus(remoteTarget, remoteClient);

    for (const listener of localListeners) {
      listener(BASE_STATUS);
    }
    for (const listener of remoteListeners) {
      listener({ ...BASE_STATUS, branch: "remote-branch" });
    }

    expect(getGitStatusSnapshot(TARGET).data?.branch).toBe("feature/push-status");
    expect(getGitStatusSnapshot(remoteTarget).data?.branch).toBe("remote-branch");

    releaseLocal();
    releaseRemote();
  });
});
