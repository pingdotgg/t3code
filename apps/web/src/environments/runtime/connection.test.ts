import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vitest";

import { createEnvironmentConnection } from "./connection";
import type { WsRpcClient } from "~/rpc/wsRpcClient";

function createTestClient(options?: {
  readonly getSnapshot?: () => Promise<{ readonly snapshotSequence: number }>;
}) {
  const lifecycleListeners = new Set<(event: any) => void>();
  const configListeners = new Set<(event: any) => void>();
  const terminalListeners = new Set<(event: any) => void>();

  const getSnapshot = vi.fn(
    options?.getSnapshot ??
      (async () =>
        ({
          snapshotSequence: 1,
          projects: [],
          threads: [],
        }) as any),
  );

  const client = {
    dispose: vi.fn(async () => undefined),
    reconnect: vi.fn(async () => undefined),
    server: {
      getConfig: vi.fn(async () => ({
        environment: {
          environmentId: EnvironmentId.makeUnsafe("env-1"),
        },
      })),
      subscribeConfig: (listener: (event: any) => void) => {
        configListeners.add(listener);
        return () => configListeners.delete(listener);
      },
      subscribeLifecycle: (listener: (event: any) => void) => {
        lifecycleListeners.add(listener);
        return () => lifecycleListeners.delete(listener);
      },
      subscribeAuthAccess: () => () => undefined,
      refreshProviders: vi.fn(async () => undefined),
      upsertKeybinding: vi.fn(async () => undefined),
      getSettings: vi.fn(async () => undefined),
      updateSettings: vi.fn(async () => undefined),
    },
    orchestration: {
      getSnapshot,
      dispatchCommand: vi.fn(async () => undefined),
      getTurnDiff: vi.fn(async () => undefined),
      getFullThreadDiff: vi.fn(async () => undefined),
      replayEvents: vi.fn(async () => []),
      onDomainEvent: () => () => undefined,
    },
    terminal: {
      open: vi.fn(async () => undefined),
      write: vi.fn(async () => undefined),
      resize: vi.fn(async () => undefined),
      clear: vi.fn(async () => undefined),
      restart: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
      onEvent: (listener: (event: any) => void) => {
        terminalListeners.add(listener);
        return () => terminalListeners.delete(listener);
      },
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
      refreshStatus: vi.fn(async () => undefined),
      onStatus: vi.fn(() => () => undefined),
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
  } as unknown as WsRpcClient;

  return {
    client,
    getSnapshot,
    emitWelcome: (environmentId: EnvironmentId) => {
      for (const listener of lifecycleListeners) {
        listener({
          type: "welcome",
          payload: {
            environment: {
              environmentId,
            },
          },
        });
      }
    },
    emitConfigSnapshot: (environmentId: EnvironmentId) => {
      for (const listener of configListeners) {
        listener({
          type: "snapshot",
          config: {
            environment: {
              environmentId,
            },
          },
        });
      }
    },
  };
}

describe("createEnvironmentConnection", () => {
  it("bootstraps a snapshot immediately for a new connection", async () => {
    const environmentId = EnvironmentId.makeUnsafe("env-1");
    const { client, getSnapshot } = createTestClient();
    const syncSnapshot = vi.fn();

    const connection = createEnvironmentConnection({
      kind: "saved",
      knownEnvironment: {
        id: "env-1",
        label: "Remote env",
        source: "manual",
        target: {
          httpBaseUrl: "http://example.test",
          wsBaseUrl: "ws://example.test",
        },
        environmentId,
      },
      client,
      applyEventBatch: vi.fn(),
      syncSnapshot,
      applyTerminalEvent: vi.fn(),
    });

    await Promise.resolve();
    await Promise.resolve();

    expect(getSnapshot).toHaveBeenCalledTimes(1);
    expect(syncSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ snapshotSequence: 1 }),
      environmentId,
    );

    await connection.dispose();
  });

  it("rejects welcome/config identity drift", async () => {
    const environmentId = EnvironmentId.makeUnsafe("env-1");
    const { client, emitWelcome } = createTestClient();

    const connection = createEnvironmentConnection({
      kind: "saved",
      knownEnvironment: {
        id: "env-1",
        label: "Remote env",
        source: "manual",
        target: {
          httpBaseUrl: "http://example.test",
          wsBaseUrl: "ws://example.test",
        },
        environmentId,
      },
      client,
      applyEventBatch: vi.fn(),
      syncSnapshot: vi.fn(),
      applyTerminalEvent: vi.fn(),
    });

    expect(() => emitWelcome(EnvironmentId.makeUnsafe("env-2"))).toThrow(
      "Environment connection env-1 changed identity to env-2 via server lifecycle welcome.",
    );

    await connection.dispose();
  });

  it("rejects ensureBootstrapped when snapshot recovery fails", async () => {
    const environmentId = EnvironmentId.makeUnsafe("env-1");
    const snapshotError = new Error("snapshot failed");
    const { client } = createTestClient({
      getSnapshot: async () => {
        throw snapshotError;
      },
    });

    const connection = createEnvironmentConnection({
      kind: "saved",
      knownEnvironment: {
        id: "env-1",
        label: "Remote env",
        source: "manual",
        target: {
          httpBaseUrl: "http://example.test",
          wsBaseUrl: "ws://example.test",
        },
        environmentId,
      },
      client,
      applyEventBatch: vi.fn(),
      syncSnapshot: vi.fn(),
      applyTerminalEvent: vi.fn(),
    });

    await expect(connection.ensureBootstrapped()).rejects.toThrow("snapshot failed");

    await connection.dispose();
  });
});
