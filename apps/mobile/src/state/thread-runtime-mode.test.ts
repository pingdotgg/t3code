import {
  AuthOrchestrationOperateScope,
  EnvironmentId,
  ThreadId,
  type OrchestrationV2ShellSnapshot,
  type RuntimeMode,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult, Atom } from "effect/reactivity";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  runAtomCommand: vi.fn(),
  dialogAlert: vi.fn(),
  canOperate: true,
  draftSettings: new Map<string, { runtimeMode?: RuntimeMode }>(),
}));

const durableSnapshotAtom = Atom.family((_envId: string) =>
  Atom.make<OrchestrationV2ShellSnapshot | null>(null).pipe(Atom.keepAlive),
);

vi.mock("@t3tools/client-runtime/state/runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@t3tools/client-runtime/state/runtime")>();
  return {
    ...actual,
    runAtomCommand: (...args: unknown[]) => mocks.runAtomCommand(...args),
  };
});

vi.mock("../components/ui/Dialog", () => ({
  alert: (...args: unknown[]) => mocks.dialogAlert(...args),
}));

vi.mock("./session", () => ({
  readEnvironmentScope: (_envId: EnvironmentId, scope: unknown) =>
    scope === AuthOrchestrationOperateScope && mocks.canOperate,
}));

vi.mock("./threads", () => ({
  threadEnvironment: {
    setRuntimeMode: { label: "setRuntimeMode" },
    durableSnapshotAtom: (envId: string) => durableSnapshotAtom(envId),
  },
}));

vi.mock("./use-composer-drafts", () => ({
  getComposerDraftSnapshot: (key: string) => mocks.draftSettings.get(key) ?? {},
  updateComposerDraftSettings: (key: string, patch: { runtimeMode?: RuntimeMode }) => {
    const current = mocks.draftSettings.get(key) ?? {};
    const next = { ...current, ...patch };
    if (next.runtimeMode === undefined) {
      delete next.runtimeMode;
    }
    mocks.draftSettings.set(key, next);
  },
  releaseComposerDraftRuntimeMode: (key: string, mode: RuntimeMode) => {
    const current = mocks.draftSettings.get(key);
    if (current?.runtimeMode !== mode) return;
    const { runtimeMode: _removed, ...rest } = current;
    mocks.draftSettings.set(key, rest);
  },
}));

import { scopedThreadKey } from "../lib/scopedEntities";
import { appAtomRegistry } from "./atom-registry";
import { selectThreadRuntimeMode } from "./thread-runtime-mode";

const envId = EnvironmentId.make("env-mobile");

function makeScenario(input: {
  readonly id: string;
  readonly runtimeMode: RuntimeMode;
  readonly durableRuntimeMode?: RuntimeMode;
  readonly running?: boolean;
  readonly supportsInSession?: boolean;
  readonly includeInSnapshot?: boolean;
}) {
  const threadId = ThreadId.make(input.id);
  const key = scopedThreadKey(envId, threadId);
  if (input.includeInSnapshot !== false) {
    appAtomRegistry.set(durableSnapshotAtom(envId), {
      threads: [{ id: threadId, runtimeMode: input.durableRuntimeMode ?? input.runtimeMode }],
    } as unknown as OrchestrationV2ShellSnapshot);
  } else {
    appAtomRegistry.set(durableSnapshotAtom(envId), null);
  }
  const thread = {
    environmentId: envId,
    id: threadId,
    runtimeMode: input.runtimeMode,
    runtime: input.running ? ({ status: "running", activeRunId: "run-1" } as never) : null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    pendingBackgroundTasks: [],
  };
  const projection = {
    thread: { id: threadId, activeProviderThreadId: null },
    runs: input.running ? [{ id: "run-1", status: "running" }] : [],
    providerSessions:
      input.supportsInSession === undefined
        ? []
        : [
            {
              id: "session-1",
              status: "ready",
              capabilities: {
                sessions: { supportsRuntimeModeSwitchInSession: input.supportsInSession },
              },
            },
          ],
    providerThreads: [],
    runtimeRequests: [],
  } as never;
  return { thread, projection, key };
}

beforeEach(() => {
  mocks.runAtomCommand.mockReset();
  mocks.dialogAlert.mockReset();
  mocks.canOperate = true;
  mocks.draftSettings.clear();
  appAtomRegistry.set(durableSnapshotAtom(envId), null);
});

describe("selectThreadRuntimeMode", () => {
  it("persists immediately for a running in-session thread and releases the draft on success", async () => {
    mocks.runAtomCommand.mockResolvedValue(AsyncResult.success({ sequence: 2 }));
    const { thread, projection, key } = makeScenario({
      id: "thread-in-session",
      runtimeMode: "auto",
      running: true,
      supportsInSession: true,
    });

    selectThreadRuntimeMode({ thread, projection, runtimeMode: "full-access" });

    expect(mocks.runAtomCommand).toHaveBeenCalledTimes(1);
    expect(mocks.runAtomCommand.mock.calls[0]?.[2]).toEqual({
      environmentId: envId,
      input: expect.objectContaining({
        threadId: thread.id,
        runtimeMode: "full-access",
        preserveActiveSession: true,
      }),
    });
    await vi.waitFor(() => {
      expect(mocks.draftSettings.get(key)?.runtimeMode).toBeUndefined();
    });
  });

  it("defers to draft while running on a provider that cannot switch in session, or while creation is pending", () => {
    const { thread, projection, key } = makeScenario({
      id: "thread-restart-required",
      runtimeMode: "auto",
      running: true,
      supportsInSession: false,
    });

    selectThreadRuntimeMode({ thread, projection, runtimeMode: "full-access" });
    expect(mocks.runAtomCommand).not.toHaveBeenCalled();
    expect(mocks.draftSettings.get(key)?.runtimeMode).toBe("full-access");

    // Switching back to the thread's durable mode drops the redundant draft override.
    selectThreadRuntimeMode({ thread, projection, runtimeMode: "auto" });
    expect(mocks.runAtomCommand).not.toHaveBeenCalled();
    expect(mocks.draftSettings.get(key)?.runtimeMode).toBeUndefined();

    // Pending thread creations stay draft-only even when idle.
    const pending = makeScenario({
      id: "thread-pending-creation",
      runtimeMode: "auto",
      running: false,
    });
    selectThreadRuntimeMode({
      thread: pending.thread,
      projection: null,
      isPendingCreation: true,
      runtimeMode: "full-access",
    });
    expect(mocks.runAtomCommand).not.toHaveBeenCalled();
    expect(mocks.draftSettings.get(pending.key)?.runtimeMode).toBe("full-access");
  });

  it("skips redundant writes when tapping the already-durable mode and persists deep-linked threads", async () => {
    mocks.runAtomCommand.mockResolvedValue(AsyncResult.success({ sequence: 2 }));
    const idle = makeScenario({ id: "thread-redundant", runtimeMode: "auto", running: false });
    selectThreadRuntimeMode({
      thread: idle.thread,
      projection: idle.projection,
      runtimeMode: "auto",
    });
    expect(mocks.runAtomCommand).not.toHaveBeenCalled();

    // Deep-linked thread loaded without a shell snapshot still persists using its resolved thread.
    const deepLink = makeScenario({
      id: "thread-deep-link",
      runtimeMode: "auto",
      running: false,
      includeInSnapshot: false,
    });
    selectThreadRuntimeMode({
      thread: deepLink.thread,
      projection: deepLink.projection,
      runtimeMode: "full-access",
    });
    expect(mocks.runAtomCommand).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => {
      expect(mocks.draftSettings.get(deepLink.key)?.runtimeMode).toBeUndefined();
    });
  });

  it("keeps the pick in draft without alerting when the server reports provider_selection_busy", async () => {
    mocks.runAtomCommand.mockResolvedValue(
      AsyncResult.failure(
        Cause.fail({ code: "provider_selection_busy", message: "Thread has an active turn." }),
      ),
    );
    const { thread, projection, key } = makeScenario({
      id: "thread-busy-race",
      runtimeMode: "auto",
      running: false,
    });

    selectThreadRuntimeMode({ thread, projection, runtimeMode: "full-access" });
    await vi.waitFor(() => {
      expect(mocks.runAtomCommand).toHaveBeenCalledTimes(1);
    });
    expect(mocks.draftSettings.get(key)?.runtimeMode).toBe("full-access");
    expect(mocks.dialogAlert).not.toHaveBeenCalled();
  });

  it("alerts and clears draft on failure without clobbering a newer pick", async () => {
    let resolveFirst!: (value: unknown) => void;
    let resolveSecond!: (value: unknown) => void;
    mocks.runAtomCommand
      .mockImplementationOnce(() => new Promise((resolve) => (resolveFirst = resolve)))
      .mockImplementationOnce(() => new Promise((resolve) => (resolveSecond = resolve)));
    const { thread, projection, key } = makeScenario({
      id: "thread-overlap",
      runtimeMode: "auto",
      running: false,
    });

    selectThreadRuntimeMode({ thread, projection, runtimeMode: "full-access" });
    selectThreadRuntimeMode({ thread, projection, runtimeMode: "approval-required" });
    expect(mocks.draftSettings.get(key)?.runtimeMode).toBe("approval-required");

    resolveFirst(AsyncResult.failure(Cause.fail(new Error("stale failure"))));
    await Promise.resolve();
    expect(mocks.draftSettings.get(key)?.runtimeMode).toBe("approval-required");
    expect(mocks.dialogAlert).not.toHaveBeenCalled();

    resolveSecond(AsyncResult.failure(Cause.fail(new Error("policy ceiling"))));
    await vi.waitFor(() => {
      expect(mocks.draftSettings.get(key)?.runtimeMode).toBeUndefined();
      expect(mocks.dialogAlert).toHaveBeenCalledTimes(1);
    });
  });
});
