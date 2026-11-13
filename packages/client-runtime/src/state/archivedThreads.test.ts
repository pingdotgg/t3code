import {
  EnvironmentId,
  type OrchestrationV2ArchivedShellSnapshot,
  type ScopedThreadRef,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";

import {
  createArchivedThreadSnapshotsAtomFamily,
  loadArchivedShellSnapshot,
  makeArchivedThreadsEnvironmentKey,
} from "./archivedThreads.ts";
import { v2Project, v2ThreadShell } from "./orchestrationV2TestFixtures.ts";

it("does not expose an archived snapshot failure message", () => {
  const environmentId = EnvironmentId.make("env-sensitive");
  const snapshotsAtom = createArchivedThreadSnapshotsAtomFamily<Error>({
    getSnapshotAtom: () =>
      Atom.make(
        AsyncResult.failure<OrchestrationV2ArchivedShellSnapshot, Error>(
          Cause.fail(new Error("credential=secret-value")),
        ),
      ),
    hiddenThreadTagsAtom: () => Atom.make(null),
    hiddenThreadKeysAtom: Atom.make((): ReadonlySet<string> => new Set()),
    liveThreadRefsAtom: Atom.make((): ReadonlyArray<ScopedThreadRef> => []),
    anyEnvironmentHidingAtom: Atom.make(false),
    labelPrefix: "test:archived-thread-snapshots",
  });
  const registry = AtomRegistry.make();

  expect(registry.get(snapshotsAtom(makeArchivedThreadsEnvironmentKey([environmentId])))).toEqual({
    snapshots: [],
    error: "Failed to load archived threads.",
    isLoading: false,
  });

  registry.dispose();
});

describe("archived delegated tasks follow their parent on another machine", () => {
  const parentEnvironmentId = EnvironmentId.make("env-parent");
  const taskEnvironmentId = EnvironmentId.make("env-task");
  const parentId = ThreadId.make("thread-parent");
  const page = (
    threads: OrchestrationV2ArchivedShellSnapshot["threads"],
  ): OrchestrationV2ArchivedShellSnapshot => ({
    schemaVersion: 1,
    snapshotSequence: 1,
    projects: [v2Project],
    threads,
  });
  const taskPage = page([
    {
      ...v2ThreadShell,
      id: ThreadId.make("thread-task"),
      delegatedFrom: { environmentId: parentEnvironmentId, threadId: parentId, title: "p" },
    },
  ]);
  const archivedTaggedParent = page([{ ...v2ThreadShell, id: parentId, tags: ["private"] }]);

  it.each([
    { name: "archived tagged parent", parentPage: archivedTaggedParent, live: false, tasks: 0 },
    { name: "live visible parent", parentPage: page([]), live: true, tasks: 1 },
    { name: "parent page not loaded yet", parentPage: null, live: false, tasks: 0 },
    { name: "archive scoped to the task's machine", parentPage: undefined, live: false, tasks: 0 },
    {
      name: "only a third machine hides tags",
      parentPage: page([]),
      live: false,
      tasks: 0,
      parentTags: null,
    },
  ])("$name", ({ parentPage, live, tasks, parentTags = ["private"] }) => {
    const snapshotsAtom = createArchivedThreadSnapshotsAtomFamily<Error>({
      getSnapshotAtom: (environmentId) =>
        Atom.make(
          environmentId === taskEnvironmentId
            ? AsyncResult.success(taskPage)
            : parentPage === null || parentPage === undefined
              ? AsyncResult.initial<OrchestrationV2ArchivedShellSnapshot, Error>(true)
              : AsyncResult.success(parentPage),
        ),
      hiddenThreadTagsAtom: (environmentId) =>
        Atom.make(environmentId === parentEnvironmentId ? parentTags : null),
      hiddenThreadKeysAtom: Atom.make((): ReadonlySet<string> => new Set()),
      liveThreadRefsAtom: Atom.make((): ReadonlyArray<ScopedThreadRef> =>
        live ? [{ environmentId: parentEnvironmentId, threadId: parentId }] : [],
      ),
      // The parent's machine hides tags; a scoped archive learns that only from this flag.
      anyEnvironmentHidingAtom: Atom.make(true),
      labelPrefix: "test:archived-thread-snapshots",
    });
    const registry = AtomRegistry.make();
    const { snapshots } = registry.get(
      snapshotsAtom(
        makeArchivedThreadsEnvironmentKey(
          parentPage === undefined ? [taskEnvironmentId] : [parentEnvironmentId, taskEnvironmentId],
        ),
      ),
    );
    const taskSnapshot = snapshots.find((entry) => entry.environmentId === taskEnvironmentId);
    expect(taskSnapshot?.snapshot.threads.length).toBe(tasks);
    registry.dispose();
  });
});

describe("the archive loads a page at a time", () => {
  const ids = ["a", "b", "c", "d", "e"].map((name) => ThreadId.make(`thread-${name}`));
  const archivedAt = "2026-10-01T00:00:00.000Z";
  // Two rows a page; `failAfter` pages answer before the next read fails.
  const load = (shown: number, failAfter = Number.POSITIVE_INFINITY) => {
    const emitted: Array<ReadonlyArray<ThreadId>> = [];
    let reads = 0;
    return loadArchivedShellSnapshot({
      readPage: ({ before }) => {
        if (reads++ === failAfter) return Effect.fail("offline" as const);
        const start = before === undefined ? 0 : ids.indexOf(before.threadId) + 1;
        const threadId = ids[start + 1];
        return Effect.succeed({
          schemaVersion: 1,
          snapshotSequence: 1,
          projects: [v2Project],
          threads: ids.slice(start, start + 2).map((id) => ({ ...v2ThreadShell, id })),
          ...(threadId !== undefined && start + 2 < ids.length
            ? { nextCursor: { archivedAt, threadId } }
            : {}),
        });
      },
      emit: (snapshot) =>
        Effect.sync(() => void emitted.push(snapshot.threads.map((thread) => thread.id))),
      previous:
        shown === 0
          ? Option.none()
          : Option.some({
              schemaVersion: 1,
              snapshotSequence: 1,
              projects: [v2Project],
              threads: ids.slice(0, shown).map((id) => ({ ...v2ThreadShell, id })),
            }),
    }).pipe(
      Effect.match({
        onFailure: () => "failed" as const,
        onSuccess: (snapshot) => snapshot.threads.map((thread) => thread.id),
      }),
      Effect.map((threads) => ({ emitted, threads })),
    );
  };

  it.effect.each([
    { name: "a first load fills in", shown: 0, emitted: [ids.slice(0, 2), ids.slice(0, 4)] },
    { name: "a reload of a partial list never shrinks it", shown: 3, emitted: [ids.slice(0, 4)] },
    { name: "a reload of the whole list swaps once", shown: 5, emitted: [] },
  ])("$name", ({ shown, emitted }) =>
    Effect.gen(function* () {
      expect(yield* load(shown)).toEqual({ emitted, threads: ids });
    }),
  );

  it.effect("a failed page keeps the rows already shown", () =>
    Effect.gen(function* () {
      expect(yield* load(0, 2)).toEqual({
        emitted: [ids.slice(0, 2), ids.slice(0, 4)],
        threads: "failed",
      });
      // Nothing replaces a loaded list when its reload fails.
      expect(yield* load(5, 1)).toEqual({ emitted: [], threads: "failed" });
    }),
  );
});
