import {
  EnvironmentId,
  type OrchestrationV2ArchivedShellSnapshot,
  type ScopedThreadRef,
  ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";

import {
  createArchivedThreadSnapshotsAtomFamily,
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
