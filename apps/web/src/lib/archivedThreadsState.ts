import { useAtomValue } from "@effect/atom-react";
import {
  type ArchivedSnapshotEntry,
  createArchivedThreadSnapshotsAtomFamily,
  makeArchivedThreadsEnvironmentKey,
} from "@t3tools/client-runtime/state/threads";
import type { EnvironmentId } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";

import { orchestrationEnvironment } from "../state/orchestration";
import { serverEnvironment } from "../state/server";
import { environmentThreadShells } from "../state/threads";
import { appAtomRegistry } from "../rpc/atomRegistry";

function archivedSnapshotAtom(environmentId: EnvironmentId) {
  return orchestrationEnvironment.archivedShellSnapshot({
    environmentId,
    input: {},
  });
}

const archivedSnapshotsAtom = createArchivedThreadSnapshotsAtomFamily({
  getSnapshotAtom: archivedSnapshotAtom,
  hiddenThreadTagsAtom: serverEnvironment.hiddenThreadTagsAtom,
  hiddenThreadKeysAtom: environmentThreadShells.hiddenThreadKeysAtom,
  liveThreadRefsAtom: environmentThreadShells.threadRefsAtom,
  anyEnvironmentHidingAtom: environmentThreadShells.anyEnvironmentHidingAtom,
  labelPrefix: "web:archived-thread-snapshots",
});

const ARCHIVED_THREADS_PAGE_SIZE = 100;

const archivedPageLimitAtom = Atom.family((_environmentId: EnvironmentId) =>
  Atom.make(ARCHIVED_THREADS_PAGE_SIZE).pipe(Atom.keepAlive),
);

function archivedPageQueryAtom(environmentId: EnvironmentId, limit: number) {
  return orchestrationEnvironment.archivedShellSnapshot({ environmentId, input: { limit } });
}

// Keeps the loaded page on screen while the next, larger one loads.
const archivedPageAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get) => {
    const limit = get(archivedPageLimitAtom(environmentId));
    const result = get(archivedPageQueryAtom(environmentId, limit));
    if (!AsyncResult.isInitial(result) || limit <= ARCHIVED_THREADS_PAGE_SIZE) return result;
    const previous = get(archivedPageQueryAtom(environmentId, limit - ARCHIVED_THREADS_PAGE_SIZE));
    return AsyncResult.isSuccess(previous) ? AsyncResult.waiting(previous) : result;
  }),
);

const archivedPagesAtom = createArchivedThreadSnapshotsAtomFamily({
  getSnapshotAtom: archivedPageAtom,
  hiddenThreadTagsAtom: serverEnvironment.hiddenThreadTagsAtom,
  hiddenThreadKeysAtom: environmentThreadShells.hiddenThreadKeysAtom,
  liveThreadRefsAtom: environmentThreadShells.threadRefsAtom,
  anyEnvironmentHidingAtom: environmentThreadShells.anyEnvironmentHidingAtom,
  labelPrefix: "web:archived-thread-pages",
});

function refreshArchivedPage(environmentId: EnvironmentId): void {
  const limit = appAtomRegistry.get(archivedPageLimitAtom(environmentId));
  appAtomRegistry.refresh(archivedPageQueryAtom(environmentId, limit));
}

export function refreshArchivedThreadsForEnvironment(environmentId: EnvironmentId): void {
  appAtomRegistry.refresh(archivedSnapshotAtom(environmentId));
  refreshArchivedPage(environmentId);
}

/**
 * The most recently archived threads, a page at a time, for the archive view. Pages span every
 * project, so a view filtered to some projects passes `paged: false` and reads the whole archive.
 */
export function useArchivedThreadPages(
  environmentIds: ReadonlyArray<EnvironmentId>,
  { paged }: { readonly paged: boolean },
): {
  readonly snapshots: ReadonlyArray<ArchivedSnapshotEntry>;
  readonly error: string | null;
  readonly isLoading: boolean;
  readonly hasMore: boolean;
  readonly loadMore: () => void;
  readonly refresh: () => void;
} {
  const environmentKey = makeArchivedThreadsEnvironmentKey(environmentIds);
  const result = useAtomValue(
    paged ? archivedPagesAtom(environmentKey) : archivedSnapshotsAtom(environmentKey),
  );
  return {
    ...result,
    hasMore: result.snapshots.some(({ snapshot }) => snapshot.hasMore === true),
    loadMore: () => {
      for (const { environmentId, snapshot } of result.snapshots) {
        if (snapshot.hasMore !== true) continue;
        appAtomRegistry.update(
          archivedPageLimitAtom(environmentId),
          (limit) => limit + ARCHIVED_THREADS_PAGE_SIZE,
        );
      }
    },
    refresh: () => {
      for (const environmentId of environmentIds) {
        if (paged) refreshArchivedPage(environmentId);
        else appAtomRegistry.refresh(archivedSnapshotAtom(environmentId));
      }
    },
  };
}

export function useArchivedThreadSnapshots(environmentIds: ReadonlyArray<EnvironmentId>): {
  readonly snapshots: ReadonlyArray<ArchivedSnapshotEntry>;
  readonly error: string | null;
  readonly isLoading: boolean;
  readonly refresh: () => void;
} {
  const environmentKey = makeArchivedThreadsEnvironmentKey(environmentIds);
  const result = useAtomValue(archivedSnapshotsAtom(environmentKey));
  const refresh = () => {
    for (const environmentId of environmentIds) {
      appAtomRegistry.refresh(archivedSnapshotAtom(environmentId));
    }
  };

  return {
    ...result,
    refresh,
  };
}
