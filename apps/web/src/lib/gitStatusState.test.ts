import { EnvironmentId, type GitStatusResult } from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { WsRpcClient } from "../rpc/wsRpcClient";
import { resetAppAtomRegistryForTests } from "../rpc/atomRegistry";
import {
  getGitStatusSnapshot,
  resetGitStatusStateForTests,
  refreshGitStatus,
  watchGitStatus,
} from "./gitStatusState";

const serviceHarness = vi.hoisted(() => ({
  connections: new Map<string, any>(),
  listeners: new Set<() => void>(),
}));

vi.mock("../environments/runtime/service", () => ({
  readEnvironmentConnection: (environmentId: string) =>
    serviceHarness.connections.get(environmentId) ?? null,
  subscribeEnvironmentConnections: (listener: () => void) => {
    serviceHarness.listeners.add(listener);
    return () => {
      serviceHarness.listeners.delete(listener);
    };
  },
}));

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

function createRegisteredGitStatusClient(environmentId: EnvironmentId) {
  const listeners = new Set<(event: GitStatusResult) => void>();
  const client = {
    dispose: vi.fn(async () => undefined),
    reconnect: vi.fn(async () => undefined),
    terminal: {
      open: vi.fn(async () => undefined),
      write: vi.fn(async () => undefined),
      resize: vi.fn(async () => undefined),
      clear: vi.fn(async () => undefined),
      restart: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
      onEvent: vi.fn(() => () => undefined),
    },
    projects: {
      searchEntries: vi.fn(async () => []),
      writeFile: vi.fn(async () => undefined),
    },
    shell: {
      openInEditor: vi.fn(async () => undefined),
    },
    git: {
      pull: vi.fn(async () => undefined),
      refreshStatus: vi.fn(async (input: { cwd: string }) => ({
        ...BASE_STATUS,
        branch: `${input.cwd}-refreshed`,
      })),
      onStatus: vi.fn((_: { cwd: string }, listener: (event: GitStatusResult) => void) =>
        registerListener(listeners, listener),
      ),
      runStackedAction: vi.fn(async () => ({}) as any),
      listBranches: vi.fn(async () => []),
      createWorktree: vi.fn(async () => undefined),
      removeWorktree: vi.fn(async () => undefined),
      createBranch: vi.fn(async () => undefined),
      checkout: vi.fn(async () => undefined),
      init: vi.fn(async () => undefined),
      resolvePullRequest: vi.fn(async () => undefined),
      preparePullRequestThread: vi.fn(async () => undefined),
    },
    server: {
      getConfig: vi.fn(async () => ({
        environment: {
          environmentId,
        },
      })),
      refreshProviders: vi.fn(async () => undefined),
      upsertKeybinding: vi.fn(async () => undefined),
      getSettings: vi.fn(async () => undefined),
      updateSettings: vi.fn(async () => undefined),
      subscribeConfig: vi.fn(() => () => undefined),
      subscribeLifecycle: vi.fn(() => () => undefined),
      subscribeAuthAccess: vi.fn(() => () => undefined),
    },
    orchestration: {
      getSnapshot: vi.fn(async () => ({ snapshotSequence: 1, projects: [], threads: [] }) as any),
      dispatchCommand: vi.fn(async () => undefined),
      getTurnDiff: vi.fn(async () => undefined),
      getFullThreadDiff: vi.fn(async () => undefined),
      replayEvents: vi.fn(async () => []),
      onDomainEvent: vi.fn(() => () => undefined),
    },
  } as unknown as WsRpcClient;

  serviceHarness.connections.set(environmentId, {
    kind: "saved" as const,
    knownEnvironment: {
      id: environmentId,
      label: `Environment ${environmentId}`,
      source: "manual" as const,
      environmentId,
      target: {
        httpBaseUrl: "http://example.test",
        wsBaseUrl: "ws://example.test",
      },
    },
    client,
    environmentId,
    ensureBootstrapped: async () => undefined,
    reconnect: async () => undefined,
    dispose: async () => undefined,
  });
  for (const listener of serviceHarness.listeners) {
    listener();
  }

  return {
    client,
    emit: (event: GitStatusResult) => {
      for (const listener of listeners) {
        listener(event);
      }
    },
  };
}

afterEach(async () => {
  gitStatusListeners.clear();
  serviceHarness.connections.clear();
  serviceHarness.listeners.clear();
  gitClient.onStatus.mockClear();
  gitClient.refreshStatus.mockClear();
  resetGitStatusStateForTests();
  resetAppAtomRegistryForTests();
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

  it("waits for a delayed environment client registration instead of throwing", () => {
    const release = watchGitStatus(TARGET);

    expect(getGitStatusSnapshot(TARGET)).toEqual({
      data: null,
      error: null,
      cause: null,
      isPending: true,
    });

    const registered = createRegisteredGitStatusClient(ENVIRONMENT_ID);
    registered.emit(BASE_STATUS);

    expect(getGitStatusSnapshot(TARGET)).toEqual({
      data: BASE_STATUS,
      error: null,
      cause: null,
      isPending: false,
    });

    release();
  });

  it("resubscribes after the environment client is removed and re-registered", async () => {
    const firstClient = createRegisteredGitStatusClient(ENVIRONMENT_ID);
    const release = watchGitStatus(TARGET);

    firstClient.emit(BASE_STATUS);
    expect(getGitStatusSnapshot(TARGET).data?.branch).toBe("feature/push-status");

    serviceHarness.connections.delete(ENVIRONMENT_ID);
    for (const listener of serviceHarness.listeners) {
      listener();
    }

    expect(getGitStatusSnapshot(TARGET)).toEqual({
      data: BASE_STATUS,
      error: null,
      cause: null,
      isPending: true,
    });

    const secondClient = createRegisteredGitStatusClient(ENVIRONMENT_ID);
    secondClient.emit({ ...BASE_STATUS, branch: "reconnected-branch" });

    expect(getGitStatusSnapshot(TARGET)).toEqual({
      data: { ...BASE_STATUS, branch: "reconnected-branch" },
      error: null,
      cause: null,
      isPending: false,
    });

    release();
  });

  it("returns the cached snapshot when refresh is requested before the client is registered", async () => {
    await expect(refreshGitStatus(TARGET)).resolves.toBeNull();
  });
});
