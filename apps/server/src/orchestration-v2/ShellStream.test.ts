import { describe, expect, it } from "@effect/vitest";
import type {
  ApplicationStoredEvent,
  OrchestrationV2ShellSnapshot,
  OrchestrationV2StoredEvent,
  OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import {
  archivedShellStreamItemFromThreadShell,
  coalesceShellApplicationEvents,
  coalesceStoredThreadEvents,
  composeShellStreamWithEnrichment,
  shellStreamItemFromEnrichmentRefresh,
  shellStreamItemFromThreadShell,
  shellStreamItemsFromInitialSnapshot,
  shellStreamItemsFromResumeSnapshot,
} from "./ShellStream.ts";

function project(sequence: number, id: string): ApplicationStoredEvent {
  return {
    sequence,
    aggregateKind: "project",
    aggregateId: id,
  } as ApplicationStoredEvent;
}

function thread(sequence: number, id: string): ApplicationStoredEvent {
  return {
    sequence,
    event: { threadId: id },
  } as ApplicationStoredEvent;
}

const emptyShellSnapshot = {
  schemaVersion: 1,
  snapshotSequence: 0,
  projects: [],
  threads: [],
  archivedThreads: [],
} as OrchestrationV2ShellSnapshot;

describe("coalesceShellApplicationEvents", () => {
  it("keeps the newest event per aggregate and preserves sequence order", () => {
    expect(
      coalesceShellApplicationEvents([
        thread(2, "thread-a"),
        project(3, "project-a"),
        thread(4, "thread-b"),
        thread(5, "thread-a"),
        project(6, "project-a"),
      ]).map((event) => event.sequence),
    ).toEqual([4, 5, 6]);
  });
});

function storedThreadEvent(
  sequence: number,
  threadId: string,
  event: Record<string, unknown> = {},
): OrchestrationV2StoredEvent {
  return { sequence, event: { threadId, ...event } } as OrchestrationV2StoredEvent;
}

function shellFixture(overrides: Partial<OrchestrationV2ThreadShell>): OrchestrationV2ThreadShell {
  return { id: "thread-a", archivedAt: null, ...overrides } as OrchestrationV2ThreadShell;
}

describe("coalesceStoredThreadEvents", () => {
  it("keeps the newest stored event per thread and preserves sequence order", () => {
    expect(
      coalesceStoredThreadEvents([
        storedThreadEvent(2, "thread-a"),
        storedThreadEvent(3, "thread-b"),
        storedThreadEvent(5, "thread-a"),
      ]).map((stored) => stored.sequence),
    ).toEqual([3, 5]);
  });
});

describe("shellStreamItemFromThreadShell", () => {
  it("emits an active thread update when the shell is not archived", () => {
    const shell = shellFixture({ archivedAt: null });
    expect(
      shellStreamItemFromThreadShell({ stored: storedThreadEvent(4, "thread-a"), shell }),
    ).toEqual({
      kind: "thread.updated",
      sequence: 4,
      location: "active",
      thread: shell,
    });
  });

  it("emits an archive update when the shell is archived", () => {
    const shell = shellFixture({ archivedAt: "2026-07-30T00:00:00.000Z" as never });
    expect(
      shellStreamItemFromThreadShell({ stored: storedThreadEvent(4, "thread-a"), shell }),
    ).toEqual({
      kind: "thread.updated",
      sequence: 4,
      location: "archive",
      thread: shell,
    });
  });

  it("emits a removal from the archive when an archived thread is deleted", () => {
    expect(
      shellStreamItemFromThreadShell({
        stored: storedThreadEvent(6, "thread-a", {
          type: "thread.deleted",
          payload: { archivedAt: "2026-07-30T00:00:00.000Z" },
        }),
        shell: null,
      }),
    ).toEqual({
      kind: "thread.removed",
      sequence: 6,
      location: "archive",
      threadId: "thread-a",
    });
  });

  it("emits a removal from the active list for other missing shells", () => {
    expect(
      shellStreamItemFromThreadShell({
        stored: storedThreadEvent(6, "thread-a", {
          type: "thread.deleted",
          payload: { archivedAt: null },
        }),
        shell: null,
      }),
    ).toEqual({
      kind: "thread.removed",
      sequence: 6,
      location: "active",
      threadId: "thread-a",
    });
  });
});

describe("archivedShellStreamItemFromThreadShell", () => {
  it("emits an update for an archived shell", () => {
    const shell = shellFixture({ archivedAt: "2026-07-30T00:00:00.000Z" as never });
    expect(
      archivedShellStreamItemFromThreadShell({ stored: storedThreadEvent(4, "thread-a"), shell }),
    ).toEqual({ kind: "thread.updated", sequence: 4, thread: shell });
  });

  it("ignores active threads that never touched the archive", () => {
    expect(
      archivedShellStreamItemFromThreadShell({
        stored: storedThreadEvent(4, "thread-a", { type: "thread.settled" }),
        shell: shellFixture({ archivedAt: null }),
      }),
    ).toBeNull();
  });

  it("emits a removal when a thread leaves the archive", () => {
    expect(
      archivedShellStreamItemFromThreadShell({
        stored: storedThreadEvent(4, "thread-a", { type: "thread.unarchived" }),
        shell: shellFixture({ archivedAt: null }),
      }),
    ).toEqual({ kind: "thread.removed", sequence: 4, threadId: "thread-a" });
  });

  it("emits a removal when an archived thread is deleted", () => {
    expect(
      archivedShellStreamItemFromThreadShell({
        stored: storedThreadEvent(4, "thread-a", {
          type: "thread.deleted",
          payload: { archivedAt: "2026-07-30T00:00:00.000Z" },
        }),
        shell: null,
      }),
    ).toEqual({ kind: "thread.removed", sequence: 4, threadId: "thread-a" });
  });
});

describe("shellStreamItemFromEnrichmentRefresh", () => {
  it("batches nearby completion roots onto one snapshot item", () => {
    expect(
      shellStreamItemFromEnrichmentRefresh({
        snapshot: emptyShellSnapshot,
        changes: [
          { workspaceRoot: "/workspace/a" },
          { workspaceRoot: "/workspace/b" },
          { workspaceRoot: "/workspace/a" },
        ],
      }),
    ).toEqual({
      kind: "snapshot",
      snapshot: emptyShellSnapshot,
      resolvedRepositoryIdentityRoots: ["/workspace/a", "/workspace/b"],
    });
  });
});

describe("shellStreamItemsFromInitialSnapshot", () => {
  it("keeps thread rows out of the metadata-only enrichment frame", () => {
    const snapshot = {
      ...emptyShellSnapshot,
      projects: [
        { id: "project-a", workspaceRoot: "/workspace/a" },
        { id: "project-b", workspaceRoot: "/workspace/b" },
      ],
      threads: [shellFixture({})],
      archivedThreads: [shellFixture({ id: ThreadId.make("thread-archived"), archivedAt: null })],
    } as unknown as OrchestrationV2ShellSnapshot;

    const items = shellStreamItemsFromInitialSnapshot({
      snapshot,
      resolvedRepositoryIdentityRoots: ["/workspace/a"],
    });

    expect(items[0]).toEqual({ kind: "snapshot", snapshot });
    expect(items[1]).toMatchObject({
      kind: "snapshot",
      snapshot: {
        projects: [{ id: "project-a", workspaceRoot: "/workspace/a" }],
        threads: [],
        archivedThreads: [],
      },
      resolvedRepositoryIdentityRoots: ["/workspace/a"],
    });
    expect(JSON.stringify(items[1]).length).toBeLessThan(JSON.stringify(items[0]).length);
  });

  it("emits unmarked authoritative then same-sequence marked enrichment when roots resolved", () => {
    const snapshot = {
      ...emptyShellSnapshot,
      snapshotSequence: 7,
    } as OrchestrationV2ShellSnapshot;

    expect(
      shellStreamItemsFromInitialSnapshot({
        snapshot,
        resolvedRepositoryIdentityRoots: ["/workspace/a", "/workspace/a"],
      }),
    ).toEqual([
      { kind: "snapshot", snapshot },
      {
        kind: "snapshot",
        snapshot,
        resolvedRepositoryIdentityRoots: ["/workspace/a"],
      },
    ]);
  });

  it("emits only the unmarked authoritative snapshot when no roots resolved", () => {
    expect(
      shellStreamItemsFromInitialSnapshot({
        snapshot: emptyShellSnapshot,
        resolvedRepositoryIdentityRoots: [],
      }),
    ).toEqual([{ kind: "snapshot", snapshot: emptyShellSnapshot }]);
  });
});

describe("shellStreamItemsFromResumeSnapshot", () => {
  it("never repeats the authoritative shell snapshot", () => {
    expect(
      shellStreamItemsFromResumeSnapshot({
        snapshot: {
          ...emptyShellSnapshot,
          threads: [shellFixture({})],
        },
        resolvedRepositoryIdentityRoots: [],
      }),
    ).toEqual([]);
  });
});

describe("composeShellStreamWithEnrichment", () => {
  it.effect(
    "emits every initial item before enrichment even when enrichment is already ready",
    () =>
      Effect.gen(function* () {
        const initialSnapshot = {
          ...emptyShellSnapshot,
          snapshotSequence: 5,
        } as OrchestrationV2ShellSnapshot;
        const enrichmentSnapshot = {
          ...emptyShellSnapshot,
          snapshotSequence: 10,
        } as OrchestrationV2ShellSnapshot;

        const initialItems = shellStreamItemsFromInitialSnapshot({
          snapshot: initialSnapshot,
          resolvedRepositoryIdentityRoots: ["/workspace/a"],
        });
        // Enrichment stream is fully ready before the composed stream is pulled.
        const enrichment = Stream.make(
          shellStreamItemFromEnrichmentRefresh({
            snapshot: enrichmentSnapshot,
            changes: [{ workspaceRoot: "/workspace/b" }],
          }),
        );
        const tail = Stream.make(
          { kind: "synchronized" as const },
          {
            kind: "project.removed" as const,
            sequence: 6,
            projectId: "project-a",
          },
        );

        const items = Array.from(
          yield* composeShellStreamWithEnrichment({
            initial: Stream.fromIterable(initialItems),
            tail,
            enrichment,
          }).pipe(Stream.runCollect),
        );

        expect(items.slice(0, initialItems.length)).toEqual(initialItems);

        const enrichmentIndex = items.findIndex(
          (item) =>
            item.kind === "snapshot" &&
            "resolvedRepositoryIdentityRoots" in item &&
            item.resolvedRepositoryIdentityRoots?.includes("/workspace/b"),
        );
        expect(enrichmentIndex).toBeGreaterThanOrEqual(initialItems.length);

        for (let index = 0; index < initialItems.length; index++) {
          expect(items[index]).toEqual(initialItems[index]);
        }
      }),
  );

  it.effect("still interleaves enrichment with the post-prefix tail after initials drain", () =>
    Effect.gen(function* () {
      const items = Array.from(
        yield* composeShellStreamWithEnrichment({
          initial: Stream.make("initial-unmarked", "initial-marked"),
          tail: Stream.make("tail-a", "tail-b"),
          enrichment: Stream.make("enrichment"),
        }).pipe(Stream.runCollect),
      );

      expect(items.slice(0, 2)).toEqual(["initial-unmarked", "initial-marked"]);
      expect(items).toContain("enrichment");
      expect(items).toContain("tail-a");
      expect(items).toContain("tail-b");
      expect(items.indexOf("enrichment")).toBeGreaterThanOrEqual(2);
    }),
  );
});
