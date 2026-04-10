import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vitest";

import { createEnvironmentConnection } from "./connection";
import type { WsRpcClient } from "~/rpc/wsRpcClient";

function createTestClient(options?: {
  readonly getSnapshot?: () => Promise<{ readonly snapshotSequence: number }>;
  readonly replayEvents?: () => Promise<ReadonlyArray<any>>;
}) {
  const lifecycleListeners = new Set<(event: any) => void>();
  const configListeners = new Set<(event: any) => void>();
  const terminalListeners = new Set<(event: any) => void>();
  let domainResubscribe: (() => void) | undefined;

  const getSnapshot = vi.fn(
    options?.getSnapshot ??
      (async () =>
        ({
          snapshotSequence: 1,
          projects: [],
          threads: [],
        }) as any),
  );
  const replayEvents = vi.fn(options?.replayEvents ?? (async () => []));

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
      replayEvents,
      onDomainEvent: vi.fn((_: (event: any) => void, options?: { onResubscribe?: () => void }) => {
        domainResubscribe = options?.onResubscribe;
        return () => {
          if (domainResubscribe === options?.onResubscribe) {
            domainResubscribe = undefined;
          }
        };
      }),
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
    replayEvents,
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
    triggerDomainResubscribe: () => {
      domainResubscribe?.();
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

  it("retries replay recovery after transport disconnects during resubscribe", async () => {
    const environmentId = EnvironmentId.makeUnsafe("env-1");
    let replayAttempts = 0;
    const applyEventBatch = vi.fn();
    const { client, replayEvents, triggerDomainResubscribe } = createTestClient({
      replayEvents: async () => {
        replayAttempts += 1;
        if (replayAttempts === 1) {
          throw new Error("SocketCloseError: 1006");
        }

        return [
          {
            sequence: 2,
            type: "thread.created",
            payload: {},
          },
        ];
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
      applyEventBatch,
      syncSnapshot: vi.fn(),
      applyTerminalEvent: vi.fn(),
    });

    await Promise.resolve();
    await Promise.resolve();

    triggerDomainResubscribe();

    await vi.waitFor(() => {
      expect(replayEvents).toHaveBeenCalledTimes(2);
      expect(applyEventBatch).toHaveBeenCalledWith(
        [
          expect.objectContaining({
            sequence: 2,
          }),
        ],
        environmentId,
      );
    });

    await connection.dispose();
  });
  it("swallows replay recovery failures triggered by resubscribe", async () => {
    const environmentId = EnvironmentId.makeUnsafe("env-1");
    const snapshotError = new Error("snapshot failed");
    let snapshotCalls = 0;
    const { client, triggerDomainResubscribe } = createTestClient({
      getSnapshot: async () => {
        snapshotCalls += 1;
        if (snapshotCalls === 1) {
          return {
            snapshotSequence: 1,
            projects: [],
            threads: [],
          } as any;
        }

        throw snapshotError;
      },
      replayEvents: async () => {
        throw new Error("SocketCloseError: 1006");
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

    await Promise.resolve();
    await Promise.resolve();

    const onUnhandledRejection = vi.fn();
    process.on("unhandledRejection", onUnhandledRejection);

    try {
      triggerDomainResubscribe();
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
    } finally {
      process.off("unhandledRejection", onUnhandledRejection);
    }

    expect(onUnhandledRejection).not.toHaveBeenCalled();

    await connection.dispose();
  });
});
