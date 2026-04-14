import type { GitStatusResult } from "@t3tools/contracts";
import { AtomRegistry } from "effect/unstable/reactivity";
import { afterEach, describe, expect, it, vi } from "vitest";

import { type GitStatusClient, createGitStatusManager } from "./gitStatusState";

/* ─── Test helpers ──────────────────────────────────────────────────── */

let atomRegistry = AtomRegistry.make();

function resetAtomRegistry() {
  atomRegistry.dispose();
  atomRegistry = AtomRegistry.make();
}

function registerListener<T>(listeners: Set<(event: T) => void>, listener: (event: T) => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

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

function createMockClient(): {
  client: GitStatusClient;
  listeners: Set<(event: GitStatusResult) => void>;
  emit: (event: GitStatusResult) => void;
} {
  const listeners = new Set<(event: GitStatusResult) => void>();
  const client: GitStatusClient = {
    refreshStatus: vi.fn(async (input: { cwd: string }) => ({
      ...BASE_STATUS,
      branch: `${input.cwd}-refreshed`,
    })),
    onStatus: vi.fn((_: { cwd: string }, listener: (event: GitStatusResult) => void) =>
      registerListener(listeners, listener),
    ),
  };
  return {
    client,
    listeners,
    emit: (event) => {
      for (const listener of listeners) listener(event);
    },
  };
}

const PENDING = { data: null, error: null, cause: null, isPending: true };
const EMPTY = { data: null, error: null, cause: null, isPending: false };

const TARGET = { environmentId: "env-local", cwd: "/repo" } as const;
const FRESH_TARGET = { environmentId: "env-local", cwd: "/fresh" } as const;
const OTHER_ENV_TARGET = { environmentId: "env-remote", cwd: "/repo" } as const;

/* ─── Tests ─────────────────────────────────────────────────────────── */

describe("createGitStatusManager", () => {
  afterEach(() => {
    resetAtomRegistry();
  });

  describe("with explicit client (no reconnection)", () => {
    it("starts in a pending state when watching", () => {
      const { client } = createMockClient();
      const manager = createGitStatusManager({
        getRegistry: () => atomRegistry,
        getClient: () => null,
      });

      manager.watch(TARGET, client);
      expect(manager.getSnapshot(TARGET)).toEqual(PENDING);
      manager.reset();
    });

    it("shares one subscription per cwd and updates the snapshot", () => {
      const { client, listeners, emit } = createMockClient();
      const manager = createGitStatusManager({
        getRegistry: () => atomRegistry,
        getClient: () => null,
      });

      const releaseA = manager.watch(TARGET, client);
      const releaseB = manager.watch(TARGET, client);

      expect(client.onStatus).toHaveBeenCalledOnce();
      expect(manager.getSnapshot(TARGET)).toEqual(PENDING);

      emit(BASE_STATUS);
      expect(manager.getSnapshot(TARGET)).toEqual({
        data: BASE_STATUS,
        error: null,
        cause: null,
        isPending: false,
      });

      releaseA();
      expect(listeners.size).toBe(1);

      releaseB();
      expect(listeners.size).toBe(0);
    });

    it("refreshes via unary RPC without restarting the stream", async () => {
      const { client, emit } = createMockClient();
      const manager = createGitStatusManager({
        getRegistry: () => atomRegistry,
        getClient: () => null,
      });

      const release = manager.watch(TARGET, client);
      emit(BASE_STATUS);

      const refreshed = await manager.refresh(TARGET, client);

      expect(client.onStatus).toHaveBeenCalledOnce();
      expect(client.refreshStatus).toHaveBeenCalledWith({ cwd: "/repo" });
      expect(refreshed).toEqual({ ...BASE_STATUS, branch: "/repo-refreshed" });

      // Snapshot still reflects stream data, not the refresh response
      expect(manager.getSnapshot(TARGET)).toEqual({
        data: BASE_STATUS,
        error: null,
        cause: null,
        isPending: false,
      });

      release();
    });

    it("keeps subscriptions isolated by environment when cwds match", () => {
      const local = createMockClient();
      const remote = createMockClient();
      const manager = createGitStatusManager({
        getRegistry: () => atomRegistry,
        getClient: () => null,
      });

      const releaseLocal = manager.watch(TARGET, local.client);
      const releaseRemote = manager.watch(OTHER_ENV_TARGET, remote.client);

      local.emit(BASE_STATUS);
      remote.emit({ ...BASE_STATUS, branch: "remote-branch" });

      expect(manager.getSnapshot(TARGET).data?.branch).toBe("feature/push-status");
      expect(manager.getSnapshot(OTHER_ENV_TARGET).data?.branch).toBe("remote-branch");

      releaseLocal();
      releaseRemote();
    });

    it("returns null from refresh when no client is available", async () => {
      const manager = createGitStatusManager({
        getRegistry: () => atomRegistry,
        getClient: () => null,
      });

      await expect(manager.refresh(TARGET)).resolves.toBeNull();
    });

    it("returns empty state for null targets", () => {
      const manager = createGitStatusManager({
        getRegistry: () => atomRegistry,
        getClient: () => null,
      });

      expect(manager.getSnapshot({ environmentId: null, cwd: null })).toEqual(EMPTY);
    });
  });

  describe("with subscribeClientChanges (reconnection)", () => {
    it("waits for a delayed client registration", () => {
      const connectionListeners = new Set<() => void>();
      const clients = new Map<string, ReturnType<typeof createMockClient>>();

      const manager = createGitStatusManager({
        getRegistry: () => atomRegistry,
        getClient: (envId) => clients.get(envId)?.client ?? null,
        getClientIdentity: (envId) => (clients.has(envId) ? envId : null),
        subscribeClientChanges: (listener) => {
          connectionListeners.add(listener);
          return () => connectionListeners.delete(listener);
        },
      });

      const release = manager.watch(TARGET);
      expect(manager.getSnapshot(TARGET)).toEqual(PENDING);

      // Register the client
      const mock = createMockClient();
      clients.set("env-local", mock);
      for (const listener of connectionListeners) listener();

      mock.emit(BASE_STATUS);
      expect(manager.getSnapshot(TARGET)).toEqual({
        data: BASE_STATUS,
        error: null,
        cause: null,
        isPending: false,
      });

      release();
    });

    it("resubscribes after client is removed and re-registered", () => {
      const connectionListeners = new Set<() => void>();
      const clients = new Map<string, ReturnType<typeof createMockClient>>();

      const manager = createGitStatusManager({
        getRegistry: () => atomRegistry,
        getClient: (envId) => clients.get(envId)?.client ?? null,
        getClientIdentity: (envId) =>
          clients.get(envId) ? `identity:${envId}:${clients.size}` : null,
        subscribeClientChanges: (listener) => {
          connectionListeners.add(listener);
          return () => connectionListeners.delete(listener);
        },
      });

      // Register first client and watch
      const first = createMockClient();
      clients.set("env-local", first);
      const release = manager.watch(TARGET);

      first.emit(BASE_STATUS);
      expect(manager.getSnapshot(TARGET).data?.branch).toBe("feature/push-status");

      // Remove client
      clients.delete("env-local");
      for (const listener of connectionListeners) listener();

      expect(manager.getSnapshot(TARGET)).toEqual({
        data: BASE_STATUS,
        error: null,
        cause: null,
        isPending: true,
      });

      // Register new client (different identity)
      const second = createMockClient();
      clients.set("env-local", second);
      for (const listener of connectionListeners) listener();

      second.emit({ ...BASE_STATUS, branch: "reconnected-branch" });
      expect(manager.getSnapshot(TARGET).data?.branch).toBe("reconnected-branch");

      release();
    });

    it("cleans up connection listener on unwatch", () => {
      const connectionListeners = new Set<() => void>();
      const mock = createMockClient();

      const manager = createGitStatusManager({
        getRegistry: () => atomRegistry,
        getClient: () => mock.client,
        getClientIdentity: () => "id",
        subscribeClientChanges: (listener) => {
          connectionListeners.add(listener);
          return () => connectionListeners.delete(listener);
        },
      });

      const release = manager.watch(TARGET);
      expect(connectionListeners.size).toBe(1);

      release();
      expect(connectionListeners.size).toBe(0);
      expect(mock.listeners.size).toBe(0);
    });
  });

  describe("with getClient config (one-shot)", () => {
    it("resolves client from config and subscribes", () => {
      const mock = createMockClient();
      const manager = createGitStatusManager({
        getRegistry: () => atomRegistry,
        getClient: (envId) => (envId === "env-local" ? mock.client : null),
      });

      const release = manager.watch(TARGET);
      expect(mock.client.onStatus).toHaveBeenCalledOnce();

      mock.emit(BASE_STATUS);
      expect(manager.getSnapshot(TARGET).data?.branch).toBe("feature/push-status");

      release();
      expect(mock.listeners.size).toBe(0);
    });

    it("returns noop when client is not available", () => {
      const manager = createGitStatusManager({
        getRegistry: () => atomRegistry,
        getClient: () => null,
      });

      const release = manager.watch(TARGET);
      expect(manager.getSnapshot(TARGET)).toEqual(PENDING);
      release(); // should not throw
    });
  });

  describe("reset", () => {
    it("tears down all active subscriptions", () => {
      const mock = createMockClient();
      const manager = createGitStatusManager({
        getRegistry: () => atomRegistry,
        getClient: () => mock.client,
      });

      manager.watch(TARGET);
      manager.watch(FRESH_TARGET);
      expect(mock.listeners.size).toBe(2);

      manager.reset();
      expect(mock.listeners.size).toBe(0);
    });
  });
});
