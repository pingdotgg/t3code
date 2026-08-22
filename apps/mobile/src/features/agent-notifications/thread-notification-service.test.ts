import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { EnvironmentId, ProjectId, ThreadId, TurnId } from "@t3tools/contracts";
import { AsyncResult, type AtomRegistry } from "effect/unstable/reactivity";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const atoms = vi.hoisted(() => ({
  preferences: { name: "preferences" },
  threads: { name: "threads" },
}));

vi.mock("../../state/preferences", () => ({ mobilePreferencesAtom: atoms.preferences }));
vi.mock("../../state/threads", () => ({
  environmentThreadShells: { threadShellsAtom: atoms.threads },
}));
vi.mock("../../persistence/imperative", () => ({ savePreferencesPatch: vi.fn() }));
vi.mock("./android-thread-notifications", () => ({
  presentAndroidThreadNotification: vi.fn(),
}));

import { createThreadNotificationService } from "./thread-notification-service";

const environmentId = EnvironmentId.make("environment-1");
const projectId = ProjectId.make("project-1");

function shell(turnId: string, state: "running" | "completed"): EnvironmentThreadShell {
  const completed = state === "completed";
  return {
    environmentId,
    id: ThreadId.make("thread-1"),
    projectId,
    title: "Prepare release",
    updatedAt: completed ? "2026-08-02T00:00:04.000Z" : "2026-08-02T00:00:01.000Z",
    latestTurn: {
      turnId: TurnId.make(turnId),
      state,
      requestedAt: "2026-08-02T00:00:00.000Z",
      startedAt: "2026-08-02T00:00:01.000Z",
      completedAt: completed ? "2026-08-02T00:00:04.000Z" : null,
      assistantMessageId: null,
    },
    session: { status: completed ? "ready" : "running", updatedAt: "2026-08-02T00:00:04.000Z" },
    hasPendingApprovals: false,
    hasPendingUserInput: false,
  } as EnvironmentThreadShell;
}

function createRegistry(input: {
  readonly enabled: boolean;
  readonly eventIds?: readonly string[];
}) {
  let preferences = {
    androidAgentNotificationsEnabled: input.enabled,
    androidAgentNotificationEventIds: input.eventIds ?? [],
  };
  let threads: ReadonlyArray<EnvironmentThreadShell> = [shell("turn-1", "running")];
  const callbacks = new Map<unknown, Set<(value: unknown) => void>>();
  const value = (atom: unknown): unknown =>
    atom === atoms.preferences ? AsyncResult.success(preferences) : threads;
  const registry = {
    get: value,
    subscribe(
      atom: unknown,
      callback: (value: unknown) => void,
      options?: { readonly immediate?: boolean },
    ) {
      const listeners = callbacks.get(atom) ?? new Set();
      listeners.add(callback);
      callbacks.set(atom, listeners);
      if (options?.immediate) callback(value(atom));
      return () => listeners.delete(callback);
    },
  } as unknown as AtomRegistry.AtomRegistry;

  return {
    registry,
    setEnabled(enabled: boolean) {
      preferences = { ...preferences, androidAgentNotificationsEnabled: enabled };
      for (const callback of callbacks.get(atoms.preferences) ?? []) {
        callback(AsyncResult.success(preferences));
      }
    },
    setThreads(next: ReadonlyArray<EnvironmentThreadShell>) {
      threads = next;
      for (const callback of callbacks.get(atoms.threads) ?? []) callback(threads);
    },
  };
}

beforeEach(() => vi.clearAllMocks());

describe("thread notification service", () => {
  it("delivers and persists one event after the initial shell snapshot", async () => {
    const harness = createRegistry({ enabled: true });
    const present = vi.fn(async () => undefined);
    const persistEventIds = vi.fn(async () => undefined);
    const service = createThreadNotificationService(harness.registry, {
      present,
      persistEventIds,
    });

    service.start();
    expect(present).not.toHaveBeenCalled();
    harness.setThreads([shell("turn-1", "completed")]);

    await vi.waitFor(() => expect(present).toHaveBeenCalledOnce());
    expect(present).toHaveBeenCalledWith(
      expect.objectContaining({ id: "environment-1:thread-1:completed:turn-1" }),
    );
    expect(persistEventIds).toHaveBeenCalledWith(["environment-1:thread-1:completed:turn-1"]);
    service.stop();
  });

  it("tracks transitions while disabled instead of replaying stale alerts when enabled", async () => {
    const harness = createRegistry({ enabled: false });
    const present = vi.fn(async () => undefined);
    const service = createThreadNotificationService(harness.registry, {
      present,
      persistEventIds: vi.fn(async () => undefined),
    });

    service.start();
    harness.setThreads([shell("turn-1", "completed")]);
    harness.setEnabled(true);
    await Promise.resolve();
    expect(present).not.toHaveBeenCalled();

    harness.setThreads([shell("turn-2", "running")]);
    harness.setThreads([shell("turn-2", "completed")]);
    await vi.waitFor(() => expect(present).toHaveBeenCalledOnce());
    expect(present).toHaveBeenCalledWith(
      expect.objectContaining({ id: "environment-1:thread-1:completed:turn-2" }),
    );
    service.stop();
  });
});
