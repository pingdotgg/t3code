import {
  EnvironmentId,
  type OrchestrationV2ArchivedShellSnapshot,
  ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity";
import { expect, it } from "vite-plus/test";

import {
  applyArchivedShellStreamItem,
  createArchivedThreadSnapshotsAtomFamily,
  makeArchivedThreadsEnvironmentKey,
  parseArchivedThreadsEnvironmentKey,
} from "./archivedThreads.ts";
import { v2Now, v2ShellSnapshot, v2ThreadShell } from "./orchestrationV2TestFixtures.ts";

const archivedSnapshot: OrchestrationV2ArchivedShellSnapshot = {
  schemaVersion: v2ShellSnapshot.schemaVersion,
  snapshotSequence: 1,
  projects: [],
  threads: [],
};

it("round-trips environment keys in sorted order", () => {
  const envA = EnvironmentId.make("env-a");
  const envB = EnvironmentId.make("env-b");
  const key = makeArchivedThreadsEnvironmentKey([envB, envA]);

  expect(parseArchivedThreadsEnvironmentKey(key)).toEqual([envA, envB]);
});

it("does not expose an archived snapshot failure message", () => {
  const environmentId = EnvironmentId.make("env-sensitive");
  const snapshotsAtom = createArchivedThreadSnapshotsAtomFamily<Error>({
    getSnapshotAtom: () =>
      Atom.make(
        AsyncResult.failure<OrchestrationV2ArchivedShellSnapshot, Error>(
          Cause.fail(new Error("credential=secret-value")),
        ),
      ),
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

it("tracks threads archived and unarchived after the initial snapshot", () => {
  const archived = {
    ...v2ThreadShell,
    id: ThreadId.make("thread-agent-archived"),
    archivedAt: v2Now,
  };
  const renamed = { ...archived, title: "Renamed while archived" };

  const afterArchive = applyArchivedShellStreamItem(
    applyArchivedShellStreamItem(null, { kind: "snapshot", snapshot: archivedSnapshot }),
    { kind: "thread.updated", sequence: 2, thread: archived },
  );
  expect(afterArchive?.threads).toEqual([archived]);

  const afterRename = applyArchivedShellStreamItem(afterArchive, {
    kind: "thread.updated",
    sequence: 3,
    thread: renamed,
  });
  expect(afterRename?.threads).toEqual([renamed]);

  const afterUnarchive = applyArchivedShellStreamItem(afterRename, {
    kind: "thread.removed",
    sequence: 4,
    threadId: archived.id,
  });
  expect(afterUnarchive).toEqual({ ...archivedSnapshot, snapshotSequence: 4, threads: [] });
});

it("ignores deltas until a snapshot arrives", () => {
  expect(
    applyArchivedShellStreamItem(null, {
      kind: "thread.removed",
      sequence: 2,
      threadId: ThreadId.make("thread-a"),
    }),
  ).toBeNull();
});

it("reports loading only until the first live snapshot", () => {
  const environmentId = EnvironmentId.make("env-live");
  const snapshotAtom = Atom.make<AsyncResult.AsyncResult<OrchestrationV2ArchivedShellSnapshot>>(
    AsyncResult.initial(true),
  );
  const snapshotsAtom = createArchivedThreadSnapshotsAtomFamily({
    getSnapshotAtom: () => snapshotAtom,
    labelPrefix: "test:archived-thread-snapshots",
  });
  const registry = AtomRegistry.make();
  const key = makeArchivedThreadsEnvironmentKey([environmentId]);
  const unmount = registry.mount(snapshotsAtom(key));

  expect(registry.get(snapshotsAtom(key)).isLoading).toBe(true);

  // Subscription atoms keep `waiting` set for as long as the stream is open.
  registry.set(snapshotAtom, AsyncResult.success(archivedSnapshot, { waiting: true }));
  expect(registry.get(snapshotsAtom(key))).toEqual({
    snapshots: [{ environmentId, snapshot: archivedSnapshot }],
    error: null,
    isLoading: false,
  });

  unmount();
  registry.dispose();
});
