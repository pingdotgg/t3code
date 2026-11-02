import {
  EnvironmentId,
  type OrchestrationV2ArchivedShellSnapshot,
  ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { expect, it } from "vite-plus/test";

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

it("hides an archived task whose archived parent on another machine is tagged", () => {
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
  const pages = new Map([
    [parentEnvironmentId, page([{ ...v2ThreadShell, id: parentId, tags: ["private"] }])],
    [
      taskEnvironmentId,
      page([
        {
          ...v2ThreadShell,
          id: ThreadId.make("thread-task"),
          delegatedFrom: { environmentId: parentEnvironmentId, threadId: parentId, title: "p" },
        },
      ]),
    ],
  ]);
  const snapshotsAtom = createArchivedThreadSnapshotsAtomFamily<Error>({
    getSnapshotAtom: (environmentId) => Atom.make(AsyncResult.success(pages.get(environmentId)!)),
    hiddenThreadTagsAtom: (environmentId) =>
      Atom.make(environmentId === parentEnvironmentId ? ["private"] : null),
    hiddenThreadKeysAtom: Atom.make((): ReadonlySet<string> => new Set()),
    labelPrefix: "test:archived-thread-snapshots",
  });
  const registry = AtomRegistry.make();
  const { snapshots } = registry.get(
    snapshotsAtom(makeArchivedThreadsEnvironmentKey([parentEnvironmentId, taskEnvironmentId])),
  );
  expect(snapshots.map(({ snapshot }) => snapshot.threads.length)).toEqual([0, 0]);
  registry.dispose();
});
