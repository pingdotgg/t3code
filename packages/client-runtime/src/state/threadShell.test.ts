import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  type OrchestrationV2ShellSnapshot,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { Atom, AtomRegistry } from "effect/unstable/reactivity";
import { describe, expect, it } from "vite-plus/test";

import { PrimaryConnectionTarget } from "../connection/model.ts";
import { v2ShellSnapshot, v2ThreadShell } from "./orchestrationV2TestFixtures.ts";
import { applyShellStreamEvent } from "./shellReducer.ts";
import { createEnvironmentThreadShellAtoms } from "./threadShell.ts";
import { visibleThreadSubagentRows } from "./threadSubagents.ts";

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

  it("shares point and list values without retaining an atom for every listed thread", () => {
    const harness = makeHarness();
    const snapshot = {
      ...v2ShellSnapshot,
      threads: Array.from({ length: 200 }, (_, index) => ({
        ...v2ThreadShell,
        id: ThreadId.make(`thread-${index}`),
      })),
    };
    harness.registry.set(harness.snapshotAtom(environmentId), snapshot);
    const listAtom = harness.threads.threadShellsAtom;
    const projectListAtom = harness.threads.threadShellsForProjectRefsAtom([
      { environmentId, projectId: v2ThreadShell.projectId },
    ]);
    const disposeList = harness.registry.mount(listAtom);
    const disposeProjectList = harness.registry.mount(projectListAtom);
    try {
      const before = harness.registry.get(listAtom);
      expect(before).toHaveLength(200);
      expect(harness.registry.get(projectListAtom)).toEqual(before);
      expect(harness.registry.getNodes().size).toBeLessThan(20);
      const firstAtom = harness.threads.threadShellAtom({
        environmentId,
        threadId: snapshot.threads[0]!.id,
      });
      expect(harness.registry.get(firstAtom)).toBe(before[0]);

      harness.registry.set(harness.snapshotAtom(environmentId), {
        ...snapshot,
        snapshotSequence: 1,
        threads: snapshot.threads.map((thread, index) =>
          index === 199 ? { ...thread, title: "Updated last thread" } : thread,
        ),
      });
      const after = harness.registry.get(listAtom);
      expect(after[0]).toBe(before[0]);
      expect(after.at(-1)).not.toBe(before.at(-1));
      expect(after.at(-1)?.title).toBe("Updated last thread");
      expect(harness.registry.get(projectListAtom).at(-1)).toBe(after.at(-1));
      expect(harness.registry.get(firstAtom)).toBe(after[0]);
      expect(harness.registry.getNodes().size).toBeLessThan(20);
    } finally {
      disposeProjectList();
      disposeList();
      harness.registry.dispose();
    }
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
});

describe("subagent thread trees", () => {
  const root = v2ThreadShell;
  const child = (
    id: string,
    status: OrchestrationV2ThreadShell["status"],
    parent = root.id,
  ): OrchestrationV2ThreadShell => ({
    ...root,
    id: ThreadId.make(id),
    status,
    lineage: { ...root.lineage, parentThreadId: parent, relationshipToParent: "subagent" },
  });

  it("counts nested children once and refreshes when a child resumes or finishes", () => {
    const { registry, threads, snapshotAtom } = makeHarness();
    const a = child("a", "running");
    const b = child("b", "completed", a.id);
    const waiting = child("waiting", "waiting");
    const idle = child("idle", "idle");
    const failed = child("failed", "failed");
    const fork = {
      ...child("fork", "running"),
      lineage: { ...a.lineage, relationshipToParent: "fork" as const },
    };
    const archived = { ...child("archived", "running"), archivedAt: root.createdAt };
    const deleted = { ...child("deleted", "running"), deletedAt: root.createdAt };
    const snapshot = {
      ...v2ShellSnapshot,
      threads: [root, b, idle, a, waiting, failed, fork, archived, deleted],
    };
    registry.set(snapshotAtom(environmentId), snapshot);
    const atom = threads.subagentTreeAtom({ environmentId, threadId: root.id });
    const dispose = registry.mount(atom);
    const before = registry.get(atom);
    expect(before.label).toBe("1 running · 2 finished · 1 waiting · 1 idle");
    expect(before.rows.map((row) => [row.thread.id, row.depth])).toEqual([
      [a.id, 0],
      [b.id, 1],
      [failed.id, 0],
      [idle.id, 0],
      [waiting.id, 0],
    ]);
    const finish = { ...a, status: "completed" as const };
    const resume = { ...b, activityRunStatus: "running" as const };
    registry.set(snapshotAtom(environmentId), { ...snapshot, threads: [root, finish, resume] });
    expect(registry.get(atom).label).toBe("1 running · 1 finished");
    expect(registry.get(atom).rows.map((row) => row.status)).toEqual(["completed", "running"]);
    dispose();
    registry.dispose();
  });

  it("isolates matching thread IDs across environments and ignores unrelated updates", () => {
    const { registry, threads, snapshotAtom } = makeHarness([environmentId, remoteEnvironmentId]);
    const a = child("a", "running");
    const other = { ...root, id: ThreadId.make("unrelated") };
    const snapshot = { ...v2ShellSnapshot, threads: [root, a, other] };
    registry.set(snapshotAtom(environmentId), snapshot);
    registry.set(snapshotAtom(remoteEnvironmentId), {
      ...snapshot,
      threads: [root, child("a", "completed")],
    });
    const local = threads.subagentTreeAtom({ environmentId, threadId: root.id });
    const remote = threads.subagentTreeAtom({
      environmentId: remoteEnvironmentId,
      threadId: root.id,
    });
    const dispose = registry.mount(local);
    const disposeRemote = registry.mount(remote);
    const before = registry.get(local);
    expect(before.label).toBe("1 running · 0 finished");
    expect(registry.get(remote).label).toBe("0 running · 1 finished");
    registry.set(snapshotAtom(environmentId), {
      ...snapshot,
      threads: [root, a, { ...other, title: "New title" }],
    });
    expect(registry.get(local)).toBe(before);
    registry.set(snapshotAtom(environmentId), { ...snapshot, threads: [root] });
    expect(registry.get(local).rows).toEqual([]);
    dispose();
    disposeRemote();
    registry.dispose();
  });

  it("terminates cyclic lineage without including the parent in its own roster", () => {
    const { registry, threads, snapshotAtom } = makeHarness();
    const a = child("a", "running");
    const cycle = { ...root, lineage: { ...a.lineage, parentThreadId: a.id } };
    registry.set(snapshotAtom(environmentId), { ...v2ShellSnapshot, threads: [cycle, a] });
    const atom = threads.subagentTreeAtom({ environmentId, threadId: root.id });
    expect(registry.get(atom).rows.map((row) => row.thread.id)).toEqual([a.id]);
    expect(registry.get(atom).rows[0]?.descendants.total).toBe(0);
    registry.dispose();
  });

  it("expands nested branches independently while retaining hidden descendant counts", () => {
    const { registry, threads, snapshotAtom } = makeHarness();
    const a = child("a", "completed");
    const b = child("b", "running", a.id);
    const c = child("c", "waiting", b.id);
    const d = child("d", "completed", a.id);
    const sibling = child("sibling", "idle");
    registry.set(snapshotAtom(environmentId), {
      ...v2ShellSnapshot,
      threads: [root, a, b, c, d, sibling],
    });
    const atom = threads.subagentTreeAtom({ environmentId, threadId: root.id });
    const dispose = registry.mount(atom);
    const tree = registry.get(atom);
    const visibleIds = (expanded: ReadonlyArray<ThreadId>) =>
      visibleThreadSubagentRows(tree.rows, new Set(expanded)).map((row) => row.thread.id);

    expect(visibleIds([])).toEqual([a.id, sibling.id]);
    expect(visibleIds([a.id])).toEqual([a.id, b.id, d.id, sibling.id]);
    expect(visibleIds([a.id, b.id])).toEqual([a.id, b.id, c.id, d.id, sibling.id]);
    expect(visibleIds([b.id])).toEqual([a.id, sibling.id]);
    expect(visibleIds([a.id, b.id])).toEqual([a.id, b.id, c.id, d.id, sibling.id]);
    expect(tree.rows[0]?.descendants.label).toBe("1 running · 1 finished · 1 waiting");
    expect(tree.rows[1]?.descendants.label).toBe("0 running · 0 finished · 1 waiting");
    expect(tree.rows[2]?.descendants.total).toBe(0);
    expect(tree.label).toBe("1 running · 2 finished · 1 waiting · 1 idle");

    registry.set(snapshotAtom(environmentId), {
      ...v2ShellSnapshot,
      threads: [root, a, b, { ...c, status: "completed" }, d, sibling],
    });
    expect(registry.get(atom).rows[0]?.descendants.label).toBe("1 running · 2 finished");
    expect(registry.get(atom).rows[1]?.descendants.label).toBe("0 running · 1 finished");
    dispose();
    registry.dispose();
  });
});
