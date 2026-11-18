import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  isListedSettledThread,
  settledShelfFrontier,
  sortOlderSettledScopes,
  unloadedOlderSettledCount,
  wantedOlderSettledPages,
  type OlderSettledScope,
} from "@t3tools/client-runtime/state/threads";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { useEffect, useState } from "react";

import { appAtomRegistry } from "../rpc/atomRegistry";
import { olderSettledThreads, threadFamilies } from "./threads";

const NO_PAGES: ReadonlyMap<EnvironmentId, number> = new Map();

/**
 * The Settled shelf for one scope when shells leave older settled threads out: which rows it may
 * list, how many threads it holds in all, and the pages read below each environment's cut, whose
 * rows merge into the thread list. `useOlderSettledShelfGrowth` reads the next pages.
 */
export function useOlderSettledShelf(input: {
  readonly scopes: ReadonlyArray<OlderSettledScope>;
  /** A collapsed shelf mounts no pages, so a reconnect reads none; expanding restores them. */
  readonly expanded: boolean;
  /** Rows the shelf shows; pages are read until it lists that many. */
  readonly visibleCount: number;
}) {
  const scopes = sortOlderSettledScopes(input.scopes);
  const scopeKey = JSON.stringify(scopes);
  const [requested, setRequested] = useState({ scopeKey, pages: NO_PAGES });
  const pages = requested.scopeKey === scopeKey && input.expanded ? requested.pages : NO_PAGES;
  const shelfScopes = scopes.map((scope) => ({
    scope,
    pages: pages.get(scope.environmentId) ?? 0,
  }));
  const shelfKey = JSON.stringify(shelfScopes);
  const shelf = useAtomValue(olderSettledThreads.shelfAtom(shelfScopes));
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- mounts the requested older settled pages into the thread family registry while shown
  useEffect(() => {
    const releases = (JSON.parse(shelfKey) as typeof shelfScopes).flatMap(({ scope, pages }) =>
      pages === 0
        ? []
        : [
            threadFamilies.mountRows(
              appAtomRegistry,
              scope.environmentId,
              olderSettledThreads.rowsKey(scope, pages),
              olderSettledThreads.pageRowsAtom(scope, pages),
            ),
          ],
    );
    return () => {
      for (const release of releases) release();
    };
  }, [shelfKey]);

  const olderOf = (environmentId: EnvironmentId) => shelf.get(environmentId)?.older ?? null;
  const pagesOf = (environmentId: EnvironmentId) => shelf.get(environmentId)?.pages;
  const frontier = settledShelfFrontier([...shelf.values()]);
  const loaded = shelfScopes.filter(({ pages }) => pages > 0);
  return {
    environments: shelf,
    visibleCount: input.expanded ? input.visibleCount : 0,
    pages,
    grow: (next: ReadonlyMap<EnvironmentId, number>) => setRequested({ scopeKey, pages: next }),
    isListed: (thread: EnvironmentThreadShell) => isListedSettledThread(thread.source, frontier),
    scopes,
    /** Older settled threads in scope that are not local; add it to the local Settled rows. */
    unloadedCount: (
      threads: ReadonlyArray<EnvironmentThreadShell>,
      only: ReadonlyArray<OlderSettledScope> = scopes,
    ) => unloadedOlderSettledCount({ olderSettled: olderOf, scopes: only, threads }),
    loading: loaded.some(({ scope }) => pagesOf(scope.environmentId)?.status === "pending"),
    failed: loaded.some(({ scope }) => pagesOf(scope.environmentId)?.status === "failed"),
    retry: () => {
      for (const { scope, pages } of loaded) {
        olderSettledThreads.retryPages(appAtomRegistry, scope, pages);
      }
    },
  };
}

/** Reads the next pages while the shelf lists fewer rows than it shows. */
export function useOlderSettledShelfGrowth(
  shelf: ReturnType<typeof useOlderSettledShelf>,
  listedSettledThreads: ReadonlyArray<EnvironmentThreadShell>,
) {
  const wanted = wantedOlderSettledPages({
    requested: shelf.pages,
    environments: shelf.environments,
    listedCount: listedSettledThreads.length,
    visibleCount: shelf.visibleCount,
  });
  const { grow, pages } = shelf;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- requests more older settled pages when the listed threads cannot fill the visible count
  useEffect(() => {
    if (wanted !== pages) grow(wanted);
  }, [wanted, pages, grow]);
}

/**
 * Conn: per project, the older settled threads the client does not hold, from each environment's
 * cut, and that cut; reads no pages. `threads` are every row held, hidden ones included.
 */
export function useUnloadedOlderSettled(
  environmentIds: ReadonlyArray<EnvironmentId>,
  threads: ReadonlyArray<EnvironmentThreadShell>,
) {
  const shelf = useAtomValue(
    olderSettledThreads.shelfAtom(
      sortOlderSettledScopes(
        environmentIds.map((environmentId) => ({ environmentId, projectIds: null })),
      ).map((scope) => ({ scope, pages: 0 })),
    ),
  );
  const olderOf = (environmentId: string) =>
    shelf.get(environmentId as EnvironmentId)?.older ?? null;
  return {
    olderOf,
    unloaded: (project: { readonly environmentId: string; readonly id: string }) =>
      unloadedOlderSettledCount({
        olderSettled: olderOf,
        scopes: [
          {
            environmentId: project.environmentId as EnvironmentId,
            projectIds: [project.id as ProjectId],
          },
        ],
        threads,
      }),
  };
}

/**
 * Threads of these projects that this client does not hold (older settled threads), for counts
 * shown outside the shelf, such as a removal confirm.
 */
export function readUnloadedThreadCount(
  members: ReadonlyArray<{ readonly environmentId: EnvironmentId; readonly id: ProjectId }>,
  threads: ReadonlyArray<EnvironmentThreadShell>,
): number {
  return unloadedOlderSettledCount({
    olderSettled: (environmentId) =>
      appAtomRegistry.get(olderSettledThreads.olderSettledAtom(environmentId)),
    scopes: [...new Set(members.map((member) => member.environmentId))].map((environmentId) => ({
      environmentId,
      projectIds: members.flatMap((member) =>
        member.environmentId === environmentId ? [member.id] : [],
      ),
    })),
    threads: threads.filter((thread) =>
      members.some(
        (member) => member.environmentId === thread.environmentId && member.id === thread.projectId,
      ),
    ),
  });
}
