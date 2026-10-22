import {
  CommandId,
  EnvironmentId,
  ProjectId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  type OrchestrationV2ShellSnapshot,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { Atom, AtomRegistry } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import { PrimaryConnectionTarget } from "../connection/model.ts";
import { v2Now, v2ShellSnapshot, v2ThreadShell } from "./orchestrationV2TestFixtures.ts";
import { applyShellStreamEvent } from "./shellReducer.ts";
import { isThreadWorking } from "./threadInbox.ts";
import { waitForTitleRegenerationFailure } from "./titleRegeneration.ts";
import { childThreadInputsTitle, createEnvironmentThreadShellAtoms } from "./threadShell.ts";

const environmentId = EnvironmentId.make("environment-v2");
const remoteEnvironmentId = EnvironmentId.make("remote-environment-v2");
const otherProjectId = ProjectId.make("other-project");

function makeHarness(environmentIds: ReadonlyArray<EnvironmentId> = [environmentId]) {
  const snapshotAtom = Atom.family((_environmentId: EnvironmentId) =>
    Atom.make<OrchestrationV2ShellSnapshot | null>(v2ShellSnapshot),
  );
  const catalogValueAtom = Atom.make({
    isReady: true,
    entries: new Map(
      environmentIds.map((id) => [
        id,
        {
          target: new PrimaryConnectionTarget({
            environmentId: id,
            label: "Environment",
            httpBaseUrl: "https://example.test",
            wsBaseUrl: "wss://example.test",
          }),
          profile: Option.none(),
          enabled: true,
        },
      ]),
    ),
  });
  return {
    registry: AtomRegistry.make(),
    snapshotAtom,
    catalogValueAtom,
    threads: createEnvironmentThreadShellAtoms({ catalogValueAtom, snapshotAtom }),
  };
}

describe("v2 thread shell lists", () => {
  it("preserves ordered reference arrays when a middle thread changes", () => {
    const { registry, threads, snapshotAtom } = makeHarness();
    const snapshot = {
      ...v2ShellSnapshot,
      threads: ["a", "b", "c"].map((id) => ({ ...v2ThreadShell, id: ThreadId.make(id) })),
    };
    registry.set(snapshotAtom(environmentId), snapshot);
    const dispose = registry.mount(threads.threadRefsAtom);
    const before = registry.get(threads.threadRefsAtom);
    registry.set(
      snapshotAtom(environmentId),
      applyShellStreamEvent(snapshot, {
        kind: "thread.updated",
        location: "active",
        sequence: 1,
        thread: { ...snapshot.threads[1]!, title: "Updated" },
      }),
    );
    expect(registry.get(threads.threadRefsAtom)).toBe(before);
    dispose();
    registry.dispose();
  });

  it("keeps navigation stable on hidden subagent updates and retains user forks", () => {
    const { registry, threads, snapshotAtom } = makeHarness();
    const root = v2ThreadShell;
    const child = {
      ...root,
      id: ThreadId.make("child"),
      lineage: {
        ...root.lineage,
        parentThreadId: root.id,
        relationshipToParent: "subagent" as const,
      },
    };
    const fork = {
      ...child,
      id: ThreadId.make("fork"),
      lineage: { ...child.lineage, relationshipToParent: "fork" as const },
    };
    const snapshot = { ...v2ShellSnapshot, threads: [root, child, fork] };
    registry.set(snapshotAtom(environmentId), snapshot);
    const dispose = registry.mount(threads.navigationThreadShellsAtom);
    const before = registry.get(threads.navigationThreadShellsAtom);
    expect(before.map((thread) => thread.id)).toEqual([root.id, fork.id]);
    registry.set(snapshotAtom(environmentId), {
      ...snapshot,
      threads: [root, { ...child, title: "Child streaming" }, fork],
    });
    expect(registry.get(threads.navigationThreadShellsAtom)).toBe(before);
    expect(registry.get(threads.threadShellsAtom)).toHaveLength(3);
    dispose();
    registry.dispose();
  });

  it("counts a subagent question on its parent only while the subagent runs", () => {
    const { registry, threads, snapshotAtom } = makeHarness();
    const root = v2ThreadShell;
    const child = {
      ...root,
      id: ThreadId.make("child"),
      creationSource: "mcp" as const,
      status: "running" as const,
      activityRunStatus: "running" as const,
      lineage: {
        ...root.lineage,
        parentThreadId: root.id,
        relationshipToParent: "subagent" as const,
      },
      pendingRuntimeRequest: {
        id: RuntimeRequestId.make("question"),
        kind: "user_input" as const,
        createdAt: v2Now,
      },
    };
    const inputs = threads.childThreadInputsAtom({ environmentId, threadId: root.id });
    const dispose = registry.mount(inputs);
    registry.set(snapshotAtom(environmentId), { ...v2ShellSnapshot, threads: [root, child] });
    expect(registry.get(inputs).map((thread) => thread.id)).toEqual([child.id]);
    registry.set(snapshotAtom(environmentId), {
      ...v2ShellSnapshot,
      threads: [root, { ...child, status: "queued" as const }],
    });
    expect(registry.get(inputs).map((thread) => thread.id)).toEqual([child.id]);
    registry.set(snapshotAtom(environmentId), {
      ...v2ShellSnapshot,
      threads: [root, { ...child, status: "completed" as const, activityRunStatus: null }],
    });
    expect(registry.get(inputs)).toEqual([]);
    const { activityRunStatus: _omitted, ...legacyChild } = child;
    registry.set(snapshotAtom(environmentId), {
      ...v2ShellSnapshot,
      threads: [root, { ...legacyChild, status: "completed" as const }],
    });
    expect(registry.get(inputs)).toEqual([]);
    dispose();
    registry.dispose();
  });

  it("brings a parent back from Working while a nested subagent waits for approval", () => {
    const { registry, threads, snapshotAtom } = makeHarness();
    const child = {
      ...v2ThreadShell,
      id: ThreadId.make("review"),
      creationSource: "mcp" as const,
      status: "running" as const,
      activityRunStatus: "running" as const,
      lineage: {
        ...v2ThreadShell.lineage,
        parentThreadId: v2ThreadShell.id,
        relationshipToParent: "subagent" as const,
      },
    };
    const grandchild = {
      ...child,
      id: ThreadId.make("review-helper"),
      lineage: { ...child.lineage, parentThreadId: child.id },
    };
    const root = {
      ...v2ThreadShell,
      latestRunId: RunId.make("root-run"),
      status: "completed" as const,
      pendingBackgroundTasks: [
        { taskId: "review", kind: "subagent" as const, childThreadId: child.id },
      ],
    };
    const approval = {
      id: RuntimeRequestId.make("cat-file"),
      kind: "command" as const,
      createdAt: v2Now,
    };
    const parent = threads.threadShellAtom({ environmentId, threadId: root.id });
    const inputs = threads.childThreadInputsAtom({ environmentId, threadId: root.id });
    const disposeParent = registry.mount(parent);
    const disposeInputs = registry.mount(inputs);
    registry.set(snapshotAtom(environmentId), {
      ...v2ShellSnapshot,
      threads: [root, child, grandchild],
    });
    expect(isThreadWorking(registry.get(parent)!)).toBe(true);

    registry.set(snapshotAtom(environmentId), {
      ...v2ShellSnapshot,
      threads: [root, child, { ...grandchild, pendingRuntimeRequest: approval }],
    });
    expect(registry.get(parent)?.pendingSubagentRequest).toBe("approval");
    expect(isThreadWorking(registry.get(parent)!)).toBe(false);
    const asking = registry.get(inputs);
    expect(asking.map((thread) => thread.id)).toEqual([grandchild.id]);
    expect(childThreadInputsTitle(asking)).toBe("Subagent needs approval");

    registry.set(snapshotAtom(environmentId), {
      ...v2ShellSnapshot,
      threads: [root, child, grandchild],
    });
    expect(registry.get(parent)?.pendingSubagentRequest).toBeNull();
    expect(isThreadWorking(registry.get(parent)!)).toBe(true);
    disposeInputs();
    disposeParent();
    registry.dispose();
  });

  it.each([
    { reason: "switched-off", state: { enabled: false } },
    {
      reason: "unsupported",
      state: { enabled: true, unsupportedReason: "Use a compatible client." },
    },
  ])("leaves $reason environments out of navigation until restored", ({ state }) => {
    const { registry, threads, catalogValueAtom } = makeHarness([
      environmentId,
      remoteEnvironmentId,
    ]);
    const dispose = registry.mount(threads.navigationThreadShellsAtom);
    const environmentsOf = () =>
      new Set(registry.get(threads.navigationThreadShellsAtom).map((t) => t.environmentId));
    expect(environmentsOf()).toEqual(new Set([environmentId, remoteEnvironmentId]));

    const setRemotePaused = (paused: boolean) => {
      const catalog = registry.get(catalogValueAtom);
      const entries = new Map(catalog.entries);
      entries.set(remoteEnvironmentId, {
        ...entries.get(remoteEnvironmentId)!,
        ...(paused ? state : { enabled: true, unsupportedReason: undefined }),
      });
      registry.set(catalogValueAtom, { ...catalog, entries });
    };
    setRemotePaused(true);
    expect(environmentsOf()).toEqual(new Set([environmentId]));
    setRemotePaused(false);
    expect(environmentsOf()).toEqual(new Set([environmentId, remoteEnvironmentId]));
    dispose();
    registry.dispose();
  });

  it("preserves project memberships on updates and keeps the same thread separate per environment", () => {
    const harness = makeHarness([environmentId, remoteEnvironmentId]);
    const otherThread = {
      ...v2ThreadShell,
      id: ThreadId.make("other-thread"),
      projectId: otherProjectId,
    };
    const snapshot = { ...v2ShellSnapshot, threads: [v2ThreadShell, otherThread] };
    harness.registry.set(harness.snapshotAtom(environmentId), snapshot);
    const membershipAtom = harness.threads.environmentThreadRefsByProjectAtom(environmentId);
    const listAtom = harness.threads.threadShellsForProjectRefsAtom([
      { environmentId: remoteEnvironmentId, projectId: v2ThreadShell.projectId },
      { environmentId, projectId: v2ThreadShell.projectId },
    ]);
    const disposeList = harness.registry.mount(listAtom);
    try {
      const membership = harness.registry.get(membershipAtom);
      const before = harness.registry.get(listAtom);
      expect(before).toHaveLength(2);
      expect(before[0]).not.toBe(before[1]);
      expect(before.map((thread) => thread.environmentId)).toEqual([
        remoteEnvironmentId,
        environmentId,
      ]);

      harness.registry.set(harness.snapshotAtom(environmentId), {
        ...snapshot,
        threads: [v2ThreadShell, { ...otherThread, title: "Changed elsewhere" }],
      });
      expect(harness.registry.get(membershipAtom)).toBe(membership);
      expect(harness.registry.get(listAtom)).toBe(before);

      harness.registry.set(harness.snapshotAtom(environmentId), {
        ...snapshot,
        threads: [{ ...v2ThreadShell, projectId: otherProjectId }, otherThread],
      });
      expect(harness.registry.get(listAtom)).toEqual([before[0]]);
      harness.registry.set(harness.snapshotAtom(remoteEnvironmentId), {
        ...v2ShellSnapshot,
        threads: [],
      });
      expect(harness.registry.get(listAtom)).toEqual([]);
    } finally {
      disposeList();
      harness.registry.dispose();
    }
  });

  it("keeps the quiet shell through streaming ticks and follows every change once the run stops", () => {
    const harness = makeHarness();
    const runId = RunId.make("streaming-run");
    const running: OrchestrationV2ThreadShell = {
      ...v2ThreadShell,
      latestRunId: runId,
      activeRunId: runId,
      status: "running",
      itemCount: 1,
      visibleItemCount: 1,
    };
    const setThread = (thread: OrchestrationV2ThreadShell, sequence: number) =>
      harness.registry.set(harness.snapshotAtom(environmentId), {
        ...v2ShellSnapshot,
        snapshotSequence: sequence,
        threads: [thread],
      });
    const at = (seconds: number) => DateTime.add(v2Now, { seconds });
    setThread(running, 1);
    const ref = { environmentId, threadId: v2ThreadShell.id };
    const quietAtom = harness.threads.quietThreadShellAtom(ref);
    const dispose = harness.registry.mount(quietAtom);
    try {
      const first = harness.registry.get(quietAtom);
      setThread({ ...running, updatedAt: at(1), itemCount: 4, visibleItemCount: 3 }, 2);
      expect(harness.registry.get(quietAtom)).toBe(first);
      expect(harness.registry.get(harness.threads.threadShellAtom(ref))?.itemCount).toBe(4);

      setThread({ ...running, updatedAt: at(2), itemCount: 5, title: "Renamed" }, 3);
      const renamed = harness.registry.get(quietAtom);
      expect(renamed?.title).toBe("Renamed");

      const stopped: OrchestrationV2ThreadShell = {
        ...running,
        activeRunId: null,
        status: "completed",
      };
      setThread({ ...stopped, title: "Renamed", updatedAt: at(3) }, 4);
      const completed = harness.registry.get(quietAtom);
      expect(completed).not.toBe(renamed);
      setThread({ ...stopped, title: "Renamed", updatedAt: at(4) }, 5);
      expect(harness.registry.get(quietAtom)?.updatedAt).toBe(DateTime.formatIso(at(4)));
      expect(harness.registry.get(quietAtom)).not.toBe(completed);
    } finally {
      dispose();
      harness.registry.dispose();
    }
  });

  it("keeps the quiet shell list through streaming ticks", () => {
    const harness = makeHarness();
    const runId = RunId.make("streaming-list-run");
    const running: OrchestrationV2ThreadShell = {
      ...v2ThreadShell,
      latestRunId: runId,
      activeRunId: runId,
      status: "running",
      itemCount: 1,
      visibleItemCount: 1,
    };
    const setThread = (thread: OrchestrationV2ThreadShell, sequence: number) =>
      harness.registry.set(harness.snapshotAtom(environmentId), {
        ...v2ShellSnapshot,
        snapshotSequence: sequence,
        threads: [thread],
      });
    setThread(running, 1);
    const listAtom = harness.threads.quietThreadShellsAtom;
    const dispose = harness.registry.mount(listAtom);
    try {
      const first = harness.registry.get(listAtom);
      expect(first).toHaveLength(1);
      setThread({ ...running, updatedAt: DateTime.add(v2Now, { seconds: 1 }), itemCount: 4 }, 2);
      expect(harness.registry.get(listAtom)).toBe(first);

      setThread({ ...running, title: "Renamed" }, 3);
      expect(harness.registry.get(listAtom)).not.toBe(first);
      expect(harness.registry.get(listAtom)[0]?.title).toBe("Renamed");
    } finally {
      dispose();
      harness.registry.dispose();
    }
  });
});

describe("title regeneration on thread shells", () => {
  const requestId = CommandId.make("manual-title");
  const message = "The thread title could not be generated.";

  it("reports a fast failure independently of an unseen bulk success and ignores unrelated requests", async () => {
    const { registry, threads, snapshotAtom } = makeHarness();
    const controller = new AbortController();
    const other = { ...v2ThreadShell, id: ThreadId.make("other-thread"), title: "Fast success" };
    registry.set(snapshotAtom(environmentId), {
      ...v2ShellSnapshot,
      threads: [v2ThreadShell, { ...other, title: v2ThreadShell.title }],
    });
    const watch = (threadId: ThreadId) =>
      waitForTitleRegenerationFailure({
        registry,
        atom: threads.threadShellAtom({ environmentId, threadId }),
        requestId: threadId === v2ThreadShell.id ? requestId : CommandId.make("other-title"),
        timeoutMs: 60_000,
        signal: controller.signal,
      });
    try {
      const failed = watch(v2ThreadShell.id);
      let successSettled = false;
      const success = watch(other.id).then((reason) => {
        successSettled = true;
        return reason;
      });
      registry.set(snapshotAtom(environmentId), {
        ...v2ShellSnapshot,
        threads: [
          {
            ...v2ThreadShell,
            titleRegenerationFailure: {
              requestId: CommandId.make("unrelated"),
              message: "Old failure",
            },
          },
          other,
        ],
      });
      registry.set(snapshotAtom(environmentId), {
        ...v2ShellSnapshot,
        threads: [{ ...v2ThreadShell, titleRegenerationFailure: { requestId, message } }, other],
      });
      await expect(failed).resolves.toBe(message);
      expect(successSettled).toBe(false);
      controller.abort();
      await expect(success).resolves.toBeNull();
    } finally {
      controller.abort();
      registry.dispose();
    }
  });

  it("keeps a queued request past the deadline and observes success after arming", async () => {
    vi.useFakeTimers();
    const { registry, threads, snapshotAtom } = makeHarness();
    const controller = new AbortController();
    const atom = threads.threadShellAtom({ environmentId, threadId: v2ThreadShell.id });
    const watch = () =>
      waitForTitleRegenerationFailure({
        registry,
        atom,
        requestId,
        timeoutMs: 60_000,
        signal: controller.signal,
      });
    const set = (thread: OrchestrationV2ThreadShell) =>
      registry.set(snapshotAtom(environmentId), { ...v2ShellSnapshot, threads: [thread] });
    try {
      const wait = watch();
      const settled = vi.fn();
      void wait.then(settled);
      set({ ...v2ThreadShell, titleRegeneration: { requestId, startedAt: v2Now } });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(settled).not.toHaveBeenCalled();
      set({ ...v2ThreadShell, titleRegenerationFailure: { requestId, message } });
      await expect(wait).resolves.toBe(message);

      set(v2ThreadShell);
      const success = watch();
      set({ ...v2ThreadShell, titleRegeneration: { requestId, startedAt: v2Now } });
      set({ ...v2ThreadShell, title: "Generated title" });
      await expect(success).resolves.toBeNull();
    } finally {
      controller.abort();
      registry.dispose();
      vi.useRealTimers();
    }
  });

  it("observes a failure after reconnect or an index gap and releases disconnected requests at their deadline", async () => {
    vi.useFakeTimers();
    const { registry, threads, snapshotAtom } = makeHarness();
    const unmountSnapshot = registry.mount(snapshotAtom(environmentId));
    const controller = new AbortController();
    const statusAtom = Atom.make<"live" | "cached" | "empty">("live");
    const atom = Atom.make((get) => {
      const status = get(statusAtom);
      return status === "cached" || status === "empty"
        ? undefined
        : get(threads.threadShellAtom({ environmentId, threadId: v2ThreadShell.id }));
    });
    const set = (thread: OrchestrationV2ThreadShell) =>
      registry.set(snapshotAtom(environmentId), { ...v2ShellSnapshot, threads: [thread] });
    const stop = vi.fn();
    const subscribe = registry.subscribe.bind(registry);
    const subscribeSpy = vi.spyOn(registry, "subscribe");
    const watch = () => {
      const ready = Promise.withResolvers<void>();
      subscribeSpy.mockImplementationOnce((...args) => {
        const unsubscribe = subscribe(...args);
        ready.resolve();
        return () => {
          stop();
          unsubscribe();
        };
      });
      const result = waitForTitleRegenerationFailure({
        registry,
        atom,
        requestId,
        timeoutMs: 5 * 60_000,
        signal: controller.signal,
      });
      return { result, ready: ready.promise };
    };
    const inFlight = { ...v2ThreadShell, titleRegeneration: { requestId, startedAt: v2Now } };
    try {
      set(inFlight);
      const reconnect = watch();
      await reconnect.ready;
      const settled = vi.fn();
      void reconnect.result.then(settled);
      registry.set(statusAtom, "cached");
      set({ ...v2ThreadShell, titleRegenerationFailure: { requestId, message } });
      await vi.advanceTimersByTimeAsync(30_000);
      expect(settled).not.toHaveBeenCalled();
      registry.set(statusAtom, "live");
      await expect(reconnect.result).resolves.toBe(message);
      expect(stop).toHaveBeenCalledTimes(1);

      set(inFlight);
      const unindexed = watch();
      await unindexed.ready;
      registry.set(snapshotAtom(environmentId), { ...v2ShellSnapshot, threads: [] });
      set({ ...v2ThreadShell, titleRegenerationFailure: { requestId, message } });
      await expect(unindexed.result).resolves.toBe(message);
      expect(stop).toHaveBeenCalledTimes(2);

      set(inFlight);
      const disconnected = watch();
      await disconnected.ready;
      registry.set(statusAtom, "empty");
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      await expect(disconnected.result).resolves.toBeNull();
      expect(stop).toHaveBeenCalledTimes(3);

      registry.set(statusAtom, "live");
      const overdue = watch();
      await overdue.ready;
      settled.mockClear();
      void overdue.result.then(settled);
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect(settled).not.toHaveBeenCalled();
      registry.set(statusAtom, "cached");
      await expect(overdue.result).resolves.toBeNull();
      expect(stop).toHaveBeenCalledTimes(4);
    } finally {
      controller.abort();
      unmountSnapshot();
      registry.dispose();
      vi.restoreAllMocks();
      vi.useRealTimers();
    }
  });

  it("releases the shell subscription on command rejection or an unobserved request timeout", async () => {
    vi.useFakeTimers();
    const { registry, threads } = makeHarness();
    const controller = new AbortController();
    const atom = threads.threadShellAtom({ environmentId, threadId: v2ThreadShell.id });
    const get = vi.spyOn(registry, "get");
    const stop = vi.fn();
    const subscribe = registry.subscribe.bind(registry);
    vi.spyOn(registry, "subscribe").mockImplementation((...args) => {
      const unsubscribe = subscribe(...args);
      return () => {
        stop();
        unsubscribe();
      };
    });
    const watch = () =>
      waitForTitleRegenerationFailure({
        registry,
        atom,
        requestId,
        timeoutMs: 60_000,
        signal: controller.signal,
      });
    try {
      const timedOut = watch();
      await vi.advanceTimersByTimeAsync(60_000);
      await expect(timedOut).resolves.toBeNull();
      expect(stop).toHaveBeenCalledTimes(1);

      const rejected = watch();
      controller.abort();
      await expect(rejected).resolves.toBeNull();
      expect(stop).toHaveBeenCalledTimes(2);
      get.mockClear();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(get).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      controller.abort();
      registry.dispose();
      vi.restoreAllMocks();
      vi.useRealTimers();
    }
  });
});
