import { EnvironmentId, type OrchestrationV2ArchivedShellSnapshot } from "@t3tools/contracts";
import * as Arr from "effect/Array";
import { pipe } from "effect/Function";
import * as Order from "effect/Order";
import { AsyncResult, Atom } from "effect/reactivity";

import { threadKey } from "./entities.ts";
import { hiddenThreadKeys } from "./threadTagFilter.ts";

export interface ArchivedSnapshotEntry {
  readonly environmentId: EnvironmentId;
  readonly snapshot: OrchestrationV2ArchivedShellSnapshot;
}

export interface ArchivedThreadSnapshotsState {
  readonly snapshots: ReadonlyArray<ArchivedSnapshotEntry>;
  readonly error: string | null;
  readonly isLoading: boolean;
}

const ARCHIVED_THREADS_ENVIRONMENT_KEY_SEPARATOR = "\u001f";
const environmentIdOrder = Order.String as Order.Order<EnvironmentId>;

export function makeArchivedThreadsEnvironmentKey(
  environmentIds: ReadonlyArray<EnvironmentId>,
): string {
  return pipe(environmentIds, Arr.sort(environmentIdOrder), (sortedEnvironmentIds) =>
    sortedEnvironmentIds.join(ARCHIVED_THREADS_ENVIRONMENT_KEY_SEPARATOR),
  );
}

function parseArchivedThreadsEnvironmentKey(key: string): ReadonlyArray<EnvironmentId> {
  if (key.length === 0) {
    return [];
  }
  return pipe(
    key.split(ARCHIVED_THREADS_ENVIRONMENT_KEY_SEPARATOR),
    Arr.map((environmentId) => EnvironmentId.make(environmentId)),
  );
}

export function createArchivedThreadSnapshotsAtomFamily<E>(options: {
  readonly getSnapshotAtom: (
    environmentId: EnvironmentId,
  ) => Atom.Atom<AsyncResult.AsyncResult<OrchestrationV2ArchivedShellSnapshot, E>>;
  readonly hiddenThreadTagsAtom: (
    environmentId: EnvironmentId,
  ) => Atom.Atom<ReadonlyArray<string> | null>;
  readonly labelPrefix: string;
}) {
  return Atom.family((environmentKey: string) =>
    Atom.make((get): ArchivedThreadSnapshotsState => {
      const snapshots: ArchivedSnapshotEntry[] = [];
      let error: string | null = null;
      let isLoading = false;

      for (const environmentId of parseArchivedThreadsEnvironmentKey(environmentKey)) {
        const result = get(options.getSnapshotAtom(environmentId));
        isLoading ||= result.waiting;

        const snapshot = AsyncResult.getOrElse(result, () => null);
        if (snapshot !== null) {
          const hidden = hiddenThreadKeys([
            {
              environmentId,
              threads: snapshot.threads,
              hiddenTags: get(options.hiddenThreadTagsAtom(environmentId)),
            },
          ]);
          snapshots.push({
            environmentId,
            snapshot:
              hidden.size === 0
                ? snapshot
                : {
                    ...snapshot,
                    threads: snapshot.threads.filter(
                      (thread) => !hidden.has(threadKey({ environmentId, threadId: thread.id })),
                    ),
                  },
          });
        }

        if (error === null && result._tag === "Failure") {
          error = "Failed to load archived threads.";
        }
      }

      return { snapshots, error, isLoading };
    }).pipe(Atom.withLabel(`${options.labelPrefix}:${environmentKey}`)),
  );
}
