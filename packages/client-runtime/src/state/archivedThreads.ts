import {
  EnvironmentId,
  type OrchestrationV2ArchivedShellSnapshot,
  type OrchestrationV2GetArchivedShellSnapshotInput,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import { pipe } from "effect/Function";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import { AsyncResult, Atom } from "effect/reactivity";

import { threadKey } from "./entities.ts";
import { hiddenThreadKeys, type TagFilteredEnvironment } from "./threadTagFilter.ts";

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

// Small enough that the newest archived threads show at once, however large the archive is.
const ARCHIVED_THREADS_PAGE_SIZE = 200;

/**
 * Reads the whole archive a page at a time, newest first, so no single request reads it all.
 * `emit` shows the pages read so far once they cover what is already on screen: a first load
 * fills in as pages arrive, a reload never shrinks the list, and a failed page keeps what was
 * shown. A partial snapshot keeps its `nextCursor`. Servers without paging answer with everything.
 */
export const loadArchivedShellSnapshot = Effect.fnUntraced(function* <E, R>(options: {
  readonly readPage: (
    input: OrchestrationV2GetArchivedShellSnapshotInput,
  ) => Effect.Effect<OrchestrationV2ArchivedShellSnapshot, E, R>;
  readonly emit: (snapshot: OrchestrationV2ArchivedShellSnapshot) => Effect.Effect<void>;
  readonly previous: Option.Option<OrchestrationV2ArchivedShellSnapshot>;
}) {
  const shownCount = Option.match(options.previous, {
    onNone: () => 0,
    onSome: (snapshot) => snapshot.threads.length,
  });
  let snapshot = yield* options.readPage({ limit: ARCHIVED_THREADS_PAGE_SIZE });
  while (snapshot.nextCursor !== undefined) {
    if (snapshot.threads.length >= shownCount) yield* options.emit(snapshot);
    const page = yield* options.readPage({
      limit: ARCHIVED_THREADS_PAGE_SIZE,
      before: snapshot.nextCursor,
    });
    // A thread archived again between two reads sits in both pages.
    const loaded = new Set(snapshot.threads.map((thread) => thread.id));
    snapshot = {
      ...page,
      threads: [...snapshot.threads, ...page.threads.filter((thread) => !loaded.has(thread.id))],
    };
  }
  return snapshot;
});

export function createArchivedThreadSnapshotsAtomFamily<E>(options: {
  readonly getSnapshotAtom: (
    environmentId: EnvironmentId,
  ) => Atom.Atom<AsyncResult.AsyncResult<OrchestrationV2ArchivedShellSnapshot, E>>;
  readonly hiddenThreadTagsAtom: (
    environmentId: EnvironmentId,
  ) => Atom.Atom<ReadonlyArray<string> | null>;
  /** Live threads the tag filter hides, so archived children of hidden parents stay hidden. */
  readonly hiddenThreadKeysAtom: Atom.Atom<ReadonlySet<string>>;
  /** Live threads, so archived children of loaded, visible parents stay visible. */
  readonly liveThreadRefsAtom: Atom.Atom<ReadonlyArray<ScopedThreadRef>>;
  /** Whether any connected environment hides tags, including ones outside this archive's scope. */
  readonly anyEnvironmentHidingAtom: Atom.Atom<boolean>;
  readonly labelPrefix: string;
}) {
  return Atom.family((environmentKey: string) =>
    Atom.make((get): ArchivedThreadSnapshotsState => {
      const snapshots: ArchivedSnapshotEntry[] = [];
      const environments: TagFilteredEnvironment[] = [];
      let error: string | null = null;
      let isLoading = false;

      for (const environmentId of parseArchivedThreadsEnvironmentKey(environmentKey)) {
        const result = get(options.getSnapshotAtom(environmentId));
        isLoading ||= result.waiting;

        const snapshot = AsyncResult.getOrElse(result, () => null);
        if (snapshot !== null) {
          snapshots.push({ environmentId, snapshot });
        }
        // A page that has not arrived still counts, so its tags apply to children elsewhere.
        environments.push({
          environmentId,
          threads: snapshot?.threads ?? [],
          hiddenTags: get(options.hiddenThreadTagsAtom(environmentId)),
        });

        if (error === null && result._tag === "Failure") {
          error = "Failed to load archived threads.";
        }
      }

      // One pass over every environment's page, so archived tasks follow parents archived elsewhere.
      // Any connected machine may hide an unloaded parent, so the global flag decides, not the scope.
      const hidingAnywhere = get(options.anyEnvironmentHidingAtom);
      const hidden = hiddenThreadKeys(
        environments,
        get(options.hiddenThreadKeysAtom),
        hidingAnywhere ? new Set(get(options.liveThreadRefsAtom).map(threadKey)) : undefined,
        hidingAnywhere,
      );
      if (hidden.size === 0) return { snapshots, error, isLoading };
      return {
        snapshots: snapshots.map(({ environmentId, snapshot }) => ({
          environmentId,
          snapshot: {
            ...snapshot,
            threads: snapshot.threads.filter(
              (thread) => !hidden.has(threadKey({ environmentId, threadId: thread.id })),
            ),
          },
        })),
        error,
        isLoading,
      };
    }).pipe(Atom.withLabel(`${options.labelPrefix}:${environmentKey}`)),
  );
}
