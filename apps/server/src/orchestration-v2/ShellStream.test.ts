import { describe, expect, it } from "@effect/vitest";
import type { ApplicationStoredEvent, OrchestrationV2ShellSnapshot } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import {
  coalesceShellApplicationEvents,
  composeShellStreamWithEnrichment,
  shellStreamItemFromEnrichmentRefresh,
  shellStreamItemsFromInitialSnapshot,
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
