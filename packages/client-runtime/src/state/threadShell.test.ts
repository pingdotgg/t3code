import {
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
import { describe, expect, it } from "vite-plus/test";

import { PrimaryConnectionTarget } from "../connection/model.ts";
import { v2Now, v2ShellSnapshot, v2ThreadShell } from "./orchestrationV2TestFixtures.ts";
import { applyShellStreamEvent } from "./shellReducer.ts";
import { isThreadWorking } from "./threadInbox.ts";
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

  it("keeps a live subagent question inside the parent without flagging its thread", () => {
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
    expect(
      registry.get(threads.threadShellAtom({ environmentId, threadId: root.id }))
        ?.pendingSubagentRequest,
    ).toBeNull();
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

  it("rolls a side chat's questions and approvals up to its parent row", () => {
    const { registry, threads, snapshotAtom } = makeHarness();
    const root = v2ThreadShell;
    const sideChat = {
      ...root,
      id: ThreadId.make("side-chat"),
      status: "running" as const,
      activityRunStatus: "running" as const,
      latestRunId: RunId.make("side-chat-run"),
      lineage: {
        ...root.lineage,
        parentThreadId: root.id,
        relationshipToParent: "fork" as const,
        sideChat: true,
      },
    };
    const request = { id: RuntimeRequestId.make("ask"), createdAt: v2Now };
    const parentRef = { environmentId, threadId: root.id };
    const parent = threads.threadShellAtom(parentRef);
    const inputs = threads.childThreadInputsAtom(parentRef);
    const disposeParent = registry.mount(parent);
    const disposeInputs = registry.mount(inputs);
    const disposeNavigation = registry.mount(threads.navigationThreadShellsAtom);
    const withRequest = (
      kind: "user_input" | "command",
      options: { readonly blocking?: boolean; readonly settled?: boolean } = {},
    ) =>
      registry.set(snapshotAtom(environmentId), {
        ...v2ShellSnapshot,
        threads: [
          root,
          {
            ...sideChat,
            ...(options.settled ? { status: "completed" as const, activityRunStatus: null } : {}),
            pendingRuntimeRequest: {
              ...request,
              kind,
              ...(options.blocking === undefined ? {} : { blocking: options.blocking }),
            },
          },
        ],
      });

    withRequest("user_input");
    expect(registry.get(parent)?.pendingSubagentRequest).toBe("user_input");
    expect(childThreadInputsTitle(registry.get(inputs))).toBe("Side chat needs input");
    expect(registry.get(threads.navigationThreadShellsAtom).map((thread) => thread.id)).toEqual([
      root.id,
    ]);

    // An async question waits while the side chat works, like its own row's indicator.
    withRequest("user_input", { blocking: false });
    expect(registry.get(parent)?.pendingSubagentRequest).toBeNull();
    expect(registry.get(inputs)).toEqual([]);
    withRequest("user_input", { blocking: false, settled: true });
    expect(registry.get(parent)?.pendingSubagentRequest).toBe("user_input");

    withRequest("command");
    expect(registry.get(parent)?.pendingSubagentRequest).toBe("approval");
    expect(childThreadInputsTitle(registry.get(inputs))).toBe("Side chat needs approval");

    const helper = {
      ...sideChat,
      id: ThreadId.make("side-chat-helper"),
      creationSource: "mcp" as const,
      lineage: {
        ...sideChat.lineage,
        parentThreadId: sideChat.id,
        relationshipToParent: "subagent" as const,
        sideChat: false,
      },
      pendingRuntimeRequest: { ...request, kind: "command" as const },
    };
    const sideChats = threads.sideChatsAtom(parentRef);
    const disposeSideChats = registry.mount(sideChats);
    registry.set(snapshotAtom(environmentId), {
      ...v2ShellSnapshot,
      threads: [root, sideChat, helper],
    });
    expect(registry.get(parent)?.pendingSubagentRequest).toBe("approval");
    expect(
      registry.get(sideChats).map((thread) => [thread.id, thread.pendingSubagentRequest]),
    ).toEqual([[sideChat.id, "approval"]]);

    registry.set(snapshotAtom(environmentId), { ...v2ShellSnapshot, threads: [root, sideChat] });
    expect(registry.get(parent)?.pendingSubagentRequest).toBeNull();
    expect(registry.get(sideChats).map((thread) => thread.pendingSubagentRequest)).toEqual([null]);
    expect(registry.get(inputs)).toEqual([]);
    disposeSideChats();
    disposeNavigation();
    disposeInputs();
    disposeParent();
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

  it("lists a task a linked environment runs for a listed thread under that thread", () => {
    const { registry, threads, snapshotAtom, catalogValueAtom } = makeHarness([
      environmentId,
      remoteEnvironmentId,
    ]);
    const parent = v2ThreadShell;
    const task = {
      ...v2ThreadShell,
      id: ThreadId.make("remote-task"),
      creationSource: "mcp" as const,
      status: "running" as const,
      activityRunStatus: "running" as const,
      delegatedFrom: { environmentId, threadId: parent.id, title: parent.title },
    };
    const helper = {
      ...task,
      id: ThreadId.make("remote-helper"),
      delegatedFrom: undefined,
      lineage: {
        ...task.lineage,
        parentThreadId: task.id,
        relationshipToParent: "subagent" as const,
      },
    };
    const approval = {
      id: RuntimeRequestId.make("cat-file"),
      kind: "command" as const,
      createdAt: v2Now,
    };
    registry.set(snapshotAtom(environmentId), { ...v2ShellSnapshot, threads: [parent] });
    registry.set(snapshotAtom(remoteEnvironmentId), {
      ...v2ShellSnapshot,
      threads: [task, helper],
    });
    const parentRef = { environmentId, threadId: parent.id };
    const inputs = threads.childThreadInputsAtom(parentRef);
    const disposeNavigation = registry.mount(threads.navigationThreadShellsAtom);
    const disposeParent = registry.mount(threads.threadShellAtom(parentRef));
    const disposeInputs = registry.mount(inputs);
    const listed = () =>
      registry
        .get(threads.navigationThreadShellsAtom)
        .map((thread) => `${thread.environmentId}/${thread.id}`);
    expect(listed()).toEqual([`${environmentId}/${parent.id}`]);

    // The helper the task started there asks for approval: the parent here hears of it.
    registry.set(snapshotAtom(remoteEnvironmentId), {
      ...v2ShellSnapshot,
      threads: [task, { ...helper, pendingRuntimeRequest: approval }],
    });
    expect(registry.get(threads.threadShellAtom(parentRef))?.pendingSubagentRequest).toBe(
      "approval",
    );
    expect(registry.get(inputs).map((thread) => `${thread.environmentId}/${thread.id}`)).toEqual([
      `${remoteEnvironmentId}/${helper.id}`,
    ]);

    registry.set(snapshotAtom(remoteEnvironmentId), {
      ...v2ShellSnapshot,
      threads: [
        task,
        { ...helper, pendingRuntimeRequest: { ...approval, kind: "user_input" as const } },
      ],
    });
    expect(registry.get(threads.threadShellAtom(parentRef))?.pendingSubagentRequest).toBeNull();
    expect(registry.get(inputs).map((thread) => thread.id)).toEqual([helper.id]);

    // A task whose parent is gone there is listed on its own, as is one whose
    // parent's environment is switched off.
    registry.set(snapshotAtom(environmentId), { ...v2ShellSnapshot, threads: [] });
    expect(listed()).toEqual([`${remoteEnvironmentId}/${task.id}`]);
    // Archiving the parent here leaves the task there unarchived, so it is listed on its own.
    registry.set(snapshotAtom(environmentId), {
      ...v2ShellSnapshot,
      threads: [{ ...parent, archivedAt: v2Now }],
    });
    expect(listed()).toEqual([`${remoteEnvironmentId}/${task.id}`]);
    registry.set(snapshotAtom(environmentId), { ...v2ShellSnapshot, threads: [parent] });
    expect(listed()).toEqual([`${environmentId}/${parent.id}`]);
    const catalog = registry.get(catalogValueAtom);
    const entries = new Map(catalog.entries);
    entries.set(environmentId, { ...entries.get(environmentId)!, enabled: false });
    registry.set(catalogValueAtom, { ...catalog, entries });
    expect(listed()).toEqual([`${remoteEnvironmentId}/${task.id}`]);
    disposeInputs();
    disposeParent();
    disposeNavigation();
    registry.dispose();
  });

  it("brings an approval up a chain of tasks across three environments to its root", () => {
    const thirdEnvironmentId = EnvironmentId.make("third-environment-v2");
    const { registry, threads, snapshotAtom } = makeHarness([
      environmentId,
      remoteEnvironmentId,
      thirdEnvironmentId,
    ]);
    const root = v2ThreadShell;
    const running = {
      creationSource: "mcp" as const,
      status: "running" as const,
      activityRunStatus: "running" as const,
    };
    const task = {
      ...v2ThreadShell,
      ...running,
      id: ThreadId.make("remote-task"),
      delegatedFrom: { environmentId, threadId: root.id, title: root.title },
    };
    const nestedTask = {
      ...v2ThreadShell,
      ...running,
      id: ThreadId.make("third-task"),
      delegatedFrom: { environmentId: remoteEnvironmentId, threadId: task.id, title: task.title },
    };
    // A task the middle one delegates back to the root's own environment.
    const returningTask = {
      ...nestedTask,
      id: ThreadId.make("returning-task"),
    };
    const approval = {
      id: RuntimeRequestId.make("cat-file"),
      kind: "command" as const,
      createdAt: v2Now,
    };
    registry.set(snapshotAtom(environmentId), { ...v2ShellSnapshot, threads: [root] });
    registry.set(snapshotAtom(remoteEnvironmentId), { ...v2ShellSnapshot, threads: [task] });
    registry.set(snapshotAtom(thirdEnvironmentId), {
      ...v2ShellSnapshot,
      threads: [{ ...nestedTask, pendingRuntimeRequest: approval }],
    });
    const rootRef = { environmentId, threadId: root.id };
    const taskRef = { environmentId: remoteEnvironmentId, threadId: task.id };
    const disposeRoot = registry.mount(threads.threadShellAtom(rootRef));
    const disposeTask = registry.mount(threads.threadShellAtom(taskRef));
    expect(registry.get(threads.threadShellAtom(taskRef))?.pendingSubagentRequest).toBe("approval");
    expect(registry.get(threads.threadShellAtom(rootRef))?.pendingSubagentRequest).toBe("approval");

    // Once it is answered, neither stays flagged.
    registry.set(snapshotAtom(thirdEnvironmentId), {
      ...v2ShellSnapshot,
      threads: [nestedTask],
    });
    expect(registry.get(threads.threadShellAtom(rootRef))?.pendingSubagentRequest).toBeNull();

    // Environments that delegate to each other still settle on the root's flag.
    registry.set(snapshotAtom(environmentId), {
      ...v2ShellSnapshot,
      threads: [root, { ...returningTask, pendingRuntimeRequest: approval }],
    });
    expect(registry.get(threads.threadShellAtom(rootRef))?.pendingSubagentRequest).toBe("approval");
    disposeTask();
    disposeRoot();
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
