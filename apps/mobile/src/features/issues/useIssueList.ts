import { RegistryContext, useAtomValue } from "@effect/atom-react";
import {
  continueIssueListPage,
  issueScopeKey,
  refreshIssueListPage,
} from "@t3tools/client-runtime/state/issues";
import {
  executeAtomQuery,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, IssueListInput, IssueListResult } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { use, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { issueEnvironment } from "../../state/issues";
import {
  issueSourceRefreshQueue,
  heldIssueList,
  issueListCanonicalSource,
  issueListPendingWrites,
  refreshWrittenIssueList,
  retainFailedIssueWrites,
  issueListTargetIncludesSource,
  issueWrites,
  ISSUE_LIST_PAGE_SIZE,
  type HeldIssueList as BaseHeldIssueList,
  type IssueListSource,
  type IssueSourceWrite,
} from "./issueList";

export type IssueListTarget = {
  readonly environmentId: EnvironmentId;
  readonly input: IssueListInput;
};

type HeldIssueList = BaseHeldIssueList & {
  readonly restartSources?: ReadonlyArray<IssueSourceWrite["source"]>;
};

const pagesFamily = Atom.family((_key: string) =>
  Atom.make<HeldIssueList | null>(null).pipe(Atom.setIdleTTL(5 * 60_000)),
);
const handledWritesFamily = Atom.family((_key: string) =>
  Atom.make<ReadonlyMap<string, number>>(new Map()).pipe(Atom.setIdleTTL(5 * 60_000)),
);
const initialPages = new WeakMap<IssueListResult, HeldIssueList>();
const refreshedPages = new WeakMap<HeldIssueList, HeldIssueList>();

function deriveHeld(
  held: HeldIssueList | null,
  answer: IssueListResult | null,
): HeldIssueList | null {
  if (answer === null || held?.answer === answer) return held;
  if (held === null) {
    const cached = initialPages.get(answer);
    if (cached) return cached;
    const page = heldIssueList(answer);
    initialPages.set(answer, page);
    return page;
  }
  const cached = refreshedPages.get(held);
  if (cached?.answer === answer) return cached;
  const page = { ...refreshIssueListPage(held, answer), answer };
  refreshedPages.set(held, page);
  return page;
}

const sourcesFamily = Atom.family((key: string) => {
  const targets: ReadonlyArray<IssueListTarget> = JSON.parse(key);
  return Atom.make((get) =>
    targets.map((target) => {
      const result = get(issueEnvironment.list(target));
      const cached = get(pagesFamily(JSON.stringify(target)));
      const handledWrites = get(handledWritesFamily(JSON.stringify(target)));
      const answer = Option.getOrNull(AsyncResult.value(result));
      return {
        target,
        result,
        cached,
        handledWrites,
        held: result._tag === "Failure" && cached ? cached : deriveHeld(cached, answer),
      };
    }),
  );
});

function requestErrors(results: ReadonlyArray<PromiseSettledResult<unknown>>) {
  return (
    results
      .flatMap((result) =>
        result.status === "rejected"
          ? [result.reason instanceof Error ? result.reason.message : "Couldn't load issues."]
          : [],
      )
      .join("\n") || null
  );
}

export function useIssueList(targets: ReadonlyArray<IssueListTarget>) {
  const registry = use(RegistryContext);
  const scopeKey = JSON.stringify(targets);
  const activeScope = useRef(scopeKey);
  const sources = useAtomValue(sourcesFamily(scopeKey));
  const written = useAtomValue(issueWrites);
  const queueSourceRefresh = useAtomValue(issueSourceRefreshQueue(scopeKey));
  const requests = useRef<{
    page?: AbortController;
    refresh?: AbortController;
    sources: Set<AbortController>;
    writes: Map<string, number>;
  }>({ sources: new Set(), writes: new Map() });
  const [loading, setLoading] = useState({
    key: scopeKey,
    page: false,
    refresh: false,
    error: null as string | null,
  });
  const state = loading.key === scopeKey ? loading : { page: false, refresh: false, error: null };
  const retryError =
    state.error ??
    (sources.some(
      ({ held }) =>
        !!held?.restartSources?.length ||
        [...(held?.pendingWrites.values() ?? [])].some((write) => write.failed),
    )
      ? "Could not refresh issues."
      : null);
  if (loading.key !== scopeKey)
    setLoading({ key: scopeKey, page: false, refresh: false, error: null });
  useLayoutEffect(() => {
    activeScope.current = scopeKey;
    return () => {
      requests.current.page?.abort();
      requests.current.refresh?.abort();
      for (const controller of requests.current.sources) controller.abort();
      requests.current = { sources: new Set(), writes: new Map() };
    };
  }, [scopeKey, activeScope, requests]);
  useEffect(() => {
    for (const { target, held, cached } of sources) {
      if (held && held !== cached)
        registry.update(pagesFamily(JSON.stringify(target)), (latest) =>
          latest === cached ? held : latest,
        );
    }
  }, [registry, sources]);

  const currentHeld = useCallback(
    (target: IssueListTarget) => {
      const cached = registry.get(pagesFamily(JSON.stringify(target)));
      const result = registry.get(issueEnvironment.list(target));
      return result._tag === "Failure" && cached
        ? cached
        : deriveHeld(cached, Option.getOrNull(AsyncResult.value(result)));
    },
    [registry],
  );

  const pendingWrites = useCallback(
    (target: IssueListTarget) =>
      issueListPendingWrites(
        target,
        currentHeld(target),
        registry.get(issueWrites)?.sources,
        registry.get(handledWritesFamily(JSON.stringify(target))),
      ),
    [currentHeld, registry],
  );

  const refreshTargets = useCallback(
    async (selected: ReadonlyArray<IssueListTarget>) => {
      if (activeScope.current !== scopeKey || !selected.length || requests.current.refresh) return;
      const ready = selected.filter(
        (target) => !registry.get(issueEnvironment.list(target)).waiting,
      );
      if (!ready.length) return;
      requests.current.page?.abort();
      delete requests.current.page;
      for (const controller of requests.current.sources) controller.abort();
      requests.current.sources.clear();
      const controller = new AbortController();
      requests.current.refresh = controller;
      setLoading({ key: scopeKey, page: false, refresh: true, error: state.error });
      const responses = await Promise.allSettled(
        ready.map(async (target) => {
          const pending = pendingWrites(target);
          for (const [sourceKey, write] of pending)
            requests.current.writes.set(JSON.stringify([target, sourceKey]), write.revision);
          const before = currentHeld(target);
          if (before && pending.size)
            registry.set(pagesFamily(JSON.stringify(target)), {
              ...before,
              pendingWrites: pending,
            });
          const response = await executeAtomQuery(registry, issueEnvironment.list(target), {
            refresh: true,
            signal: controller.signal,
            reportFailure: false,
          });
          if (controller.signal.aborted || activeScope.current !== scopeKey) return;
          if (response._tag === "Failure") {
            registry.update(pagesFamily(JSON.stringify(target)), (latest) =>
              retainFailedIssueWrites(latest, pending),
            );
            throw squashAtomCommandFailure(response);
          }
          const refreshed = refreshWrittenIssueList(currentHeld(target), response.value, pending);
          registry.set(pagesFamily(JSON.stringify(target)), refreshed.held);
          registry.update(
            handledWritesFamily(JSON.stringify(target)),
            (previous) => new Map([...previous, ...refreshed.handledWrites]),
          );
          if (response.value.errors.length)
            throw new Error(response.value.errors.map((error) => error.message).join("\n"));
        }),
      );
      if (requests.current.refresh === controller) delete requests.current.refresh;
      if (!controller.signal.aborted && activeScope.current === scopeKey)
        setLoading({
          key: scopeKey,
          page: false,
          refresh: requests.current.sources.size > 0,
          error: requestErrors(responses),
        });
    },
    [currentHeld, pendingWrites, registry, scopeKey, state.error, activeScope, requests],
  );

  const onRefresh = useCallback(() => refreshTargets(targets), [refreshTargets, targets]);

  const readSource = useCallback(
    async function readWrittenSource(
      sourceKey: string,
      write: IssueSourceWrite | Pick<IssueSourceWrite, "environmentId" | "source">,
      retry = false,
    ): Promise<void> {
      const { environmentId, source } = write;
      if (activeScope.current !== scopeKey) return;
      const selected = targets.filter((target) =>
        issueListTargetIncludesSource(target, environmentId, source, currentHeld(target)),
      );
      if (!selected.length) return;
      if ("revision" in write) {
        requests.current.page?.abort();
        delete requests.current.page;
      }
      const controller = new AbortController();
      requests.current.sources.add(controller);
      setLoading({
        key: scopeKey,
        page: !!requests.current.page,
        refresh: true,
        error: retry ? null : state.error,
      });
      const responses = await Promise.allSettled(
        selected.map(async (target) => {
          const query = issueEnvironment.list(target);
          if (registry.get(query).waiting)
            await executeAtomQuery(registry, query, {
              signal: controller.signal,
              reportFailure: false,
            });
          if (controller.signal.aborted || activeScope.current !== scopeKey) return;
          const started = currentHeld(target);
          const canonical = issueListCanonicalSource(started, source);
          const currentWrite =
            "revision" in write
              ? {
                  ...write,
                  removedKeys: new Map([
                    ...(started?.pendingWrites.get(sourceKey)?.removedKeys ?? []),
                    ...write.removedKeys,
                  ]),
                }
              : null;
          const writes = currentWrite
            ? new Map([[sourceKey, currentWrite]])
            : new Map<string, IssueSourceWrite>();
          if (started && currentWrite) {
            const pending = new Map(started.pendingWrites);
            if ((pending.get(sourceKey)?.revision ?? 0) < currentWrite.revision)
              pending.set(sourceKey, currentWrite);
            registry.set(pagesFamily(JSON.stringify(target)), {
              ...started,
              pendingWrites: pending,
            });
          }
          if (!started || canonical.host === undefined) {
            const response = await executeAtomQuery(registry, query, {
              refresh: true,
              signal: controller.signal,
              reportFailure: false,
            });
            if (controller.signal.aborted || activeScope.current !== scopeKey) return;
            if (response._tag === "Failure") throw squashAtomCommandFailure(response);
            const refreshed = refreshWrittenIssueList(currentHeld(target), response.value, writes);
            registry.set(pagesFamily(JSON.stringify(target)), refreshed.held);
            registry.update(
              handledWritesFamily(JSON.stringify(target)),
              (previous) => new Map([...previous, ...refreshed.handledWrites]),
            );
            if (response.value.errors.length)
              throw new Error(response.value.errors.map((error) => error.message).join("\n"));
            return;
          }
          const scope = {
            tracker: canonical.tracker,
            projectId: canonical.projectId,
            host: canonical.host,
            scope: canonical.scope,
          };
          const { cursors: _cursors, ...input } = target.input;
          const response = await runAtomCommand(
            registry,
            issueEnvironment.listPage,
            {
              environmentId,
              input: {
                ...input,
                projectId: scope.projectId,
                host: scope.host,
                limit: ISSUE_LIST_PAGE_SIZE,
              },
            },
            { reportFailure: false },
          );
          if (controller.signal.aborted || activeScope.current !== scopeKey) return;
          if (response._tag === "Failure") throw squashAtomCommandFailure(response);
          const latest = currentHeld(target);
          if (!latest || latest.answer !== started.answer) {
            void queueSourceRefresh(sourceKey, () =>
              readWrittenSource(
                sourceKey,
                registry.get(issueWrites)?.sources.get(sourceKey) ?? write,
                retry,
              ),
            );
            return;
          }
          const refreshed = refreshWrittenIssueList(latest, response.value, writes, scope);
          registry.set(pagesFamily(JSON.stringify(target)), {
            ...refreshed.held,
            restartSources: latest.restartSources?.filter(
              (pending) =>
                response.value.errors.length > 0 ||
                issueScopeKey(environmentId, { ...pending, host: pending.host ?? "" }) !==
                  sourceKey,
            ),
          });
          registry.update(
            handledWritesFamily(JSON.stringify(target)),
            (previous) => new Map([...previous, ...refreshed.handledWrites]),
          );
          if (response.value.errors.length)
            throw new Error(response.value.errors.map((error) => error.message).join("\n"));
        }),
      );
      requests.current.sources.delete(controller);
      if (!controller.signal.aborted && activeScope.current === scopeKey) {
        for (const [index, response] of responses.entries()) {
          if (response.status !== "rejected" || !("revision" in write)) continue;
          const target = selected[index]!;
          registry.update(pagesFamily(JSON.stringify(target)), (latest) =>
            retainFailedIssueWrites(latest, new Map([[sourceKey, write]])),
          );
        }
        setLoading((previous) => ({
          key: scopeKey,
          page: !!requests.current.page,
          refresh: !!requests.current.refresh || requests.current.sources.size > 0,
          error: requestErrors(responses) ?? (previous.key === scopeKey ? previous.error : null),
        }));
      }
    },
    [
      currentHeld,
      queueSourceRefresh,
      registry,
      scopeKey,
      state.error,
      targets,
      activeScope,
      requests,
    ],
  );

  const loadMore = useCallback(
    async (retry = false) => {
      if (
        activeScope.current !== scopeKey ||
        requests.current.page ||
        requests.current.refresh ||
        requests.current.sources.size ||
        (!retry && retryError)
      )
        return;
      if (retry && retryError) {
        const pending = new Map(
          targets.flatMap((target) => [
            ...(currentHeld(target)?.restartSources ?? []).map((source) => {
              const sourceKey = issueScopeKey(target.environmentId, {
                ...source,
                host: source.host ?? "",
              });
              return [sourceKey, { environmentId: target.environmentId, source }] as const;
            }),
            ...pendingWrites(target),
          ]),
        );
        if (pending.size) {
          await Promise.all(
            [...pending].map(([sourceKey, write]) =>
              queueSourceRefresh(sourceKey, () => readSource(sourceKey, write, true)),
            ),
          );
          return;
        }
      }
      const continuations = targets.flatMap((target) => {
        const result = registry.get(issueEnvironment.list(target));
        if (result._tag !== "Success" || result.waiting) return [];
        const held = currentHeld(target);
        return held && Object.keys(held.nextCursors).length ? [{ target, held }] : [];
      });
      if (!continuations.length) {
        if (retry && retryError) await onRefresh();
        return;
      }
      const controller = new AbortController();
      requests.current.page = controller;
      setLoading({ key: scopeKey, page: true, refresh: false, error: null });
      const responses = await Promise.allSettled(
        continuations.map(async ({ target, held }) => {
          const sentCursors = held.nextCursors;
          const response = await runAtomCommand(
            registry,
            issueEnvironment.listPage,
            {
              environmentId: target.environmentId,
              input: { ...target.input, limit: ISSUE_LIST_PAGE_SIZE, cursors: sentCursors },
            },
            { reportFailure: false },
          );
          if (controller.signal.aborted || activeScope.current !== scopeKey) return;
          if (response._tag === "Failure") throw squashAtomCommandFailure(response);
          const latest = currentHeld(target);
          if (!latest) return;
          const next = continueIssueListPage(
            latest,
            sentCursors,
            response.value,
            held.firstCursors,
          );
          registry.set(pagesFamily(JSON.stringify(target)), next);
          if (next !== latest) {
            await Promise.all(
              (next.restartSources ?? []).map((source) => {
                const sourceKey = issueScopeKey(target.environmentId, {
                  ...source,
                  host: source.host ?? "",
                });
                return queueSourceRefresh(sourceKey, () =>
                  readSource(
                    sourceKey,
                    registry.get(issueWrites)?.sources.get(sourceKey) ?? {
                      environmentId: target.environmentId,
                      source,
                    },
                  ),
                );
              }),
            );
          }
          if (next !== latest && response.value.errors.length)
            throw new Error(response.value.errors.map((error) => error.message).join("\n"));
        }),
      );
      if (requests.current.page === controller) delete requests.current.page;
      if (!controller.signal.aborted && activeScope.current === scopeKey)
        setLoading((previous) => ({
          key: scopeKey,
          page: false,
          refresh: false,
          error: requestErrors(responses) ?? (previous.key === scopeKey ? previous.error : null),
        }));
    },
    [
      currentHeld,
      pendingWrites,
      queueSourceRefresh,
      readSource,
      registry,
      scopeKey,
      retryError,
      targets,
      activeScope,
      requests,
      onRefresh,
    ],
  );

  useEffect(() => {
    if (!written) return;
    for (const [sourceKey, write] of written.sources) {
      if (write.updatedAt < Date.now() - 5 * 60_000) continue;
      const selected = sources.filter(
        ({ target, handledWrites, held }) =>
          (handledWrites.get(sourceKey) ?? 0) < write.revision &&
          !(
            held?.pendingWrites.get(sourceKey)?.failed &&
            held.pendingWrites.get(sourceKey)!.revision >= write.revision
          ) &&
          (requests.current.writes.get(JSON.stringify([target, sourceKey])) ?? 0) <
            write.revision &&
          issueListTargetIncludesSource(target, write.environmentId, write.source, held),
      );
      if (!selected.length) continue;
      for (const { target } of selected)
        requests.current.writes.set(JSON.stringify([target, sourceKey]), write.revision);
      void queueSourceRefresh(sourceKey, () => readSource(sourceKey, write));
    }
  }, [queueSourceRefresh, readSource, sources, written, requests]);

  const lists = useMemo(
    () =>
      sources.flatMap(({ target, held }): IssueListSource[] =>
        held ? [{ environmentId: target.environmentId, held }] : [],
      ),
    [sources],
  );
  const errors = useMemo(
    () =>
      sources.flatMap(({ target, result }) => {
        if (result._tag !== "Failure") return [];
        const cause = Cause.squash(result.cause);
        return [
          {
            environmentId: target.environmentId,
            message: cause instanceof Error ? cause.message : "Couldn't load issues.",
          },
        ];
      }),
    [sources],
  );
  return {
    lists,
    isPending:
      sources.some(({ result }) => result.waiting) &&
      !lists.some(({ held }) => held.entries.length),
    errors,
    refreshing: state.refresh,
    onRefresh,
    loadMore,
    loadingMore: state.page,
    loadMoreError: retryError,
    hasMore: sources.some(
      ({ result, held }) =>
        result._tag === "Success" &&
        !result.waiting &&
        held !== null &&
        Object.keys(held.nextCursors).length > 0,
    ),
  };
}
