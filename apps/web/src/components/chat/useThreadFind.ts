import type { InlineSkill } from "@t3tools/shared/inlineSkills";
import type { OrchestrationV2SearchThreadResult, ScopedThreadRef } from "@t3tools/contracts";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { orchestrationEnvironment } from "~/state/orchestration";
import { useThreadProjection } from "~/state/entities";
import { useEnvironmentQuery } from "~/state/query";
import { useDebouncedValue } from "~/state/queries";
import { type ThreadFindMatch, type ThreadFindStart, stepThreadFindIndex } from "./threadFind";
import {
  CLOSED_THREAD_FIND,
  closeThreadFind,
  setThreadFindQuery,
  useThreadFindOpen,
  useThreadFindStore,
  type ThreadFindLocalSelection,
  type ThreadFindState,
} from "./threadFindStore";

const EMPTY_SKILLS: readonly InlineSkill[] = [];

export function useThreadFind({
  thread,
  enabled,
  progressive = false,
  skills = EMPTY_SKILLS,
}: {
  thread: ScopedThreadRef | null;
  enabled: boolean;
  progressive?: boolean;
  skills?: readonly InlineSkill[];
}) {
  // Read here rather than passed in: a streamed delta re-renders only the find
  // provider, which refreshes open results from it.
  const content = useThreadProjection(enabled ? thread : null)?.projection;
  const lastContentRef = useRef(content);
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refreshAfterSearchRef = useRef(false);
  const threadKey = thread ? scopedThreadKey(thread) : null;
  const isOpen = useThreadFindOpen(thread, enabled);
  const stored = useThreadFindStore();
  const state = isOpen ? stored : CLOSED_THREAD_FIND;
  const setState = (update: (previous: ThreadFindState) => Partial<ThreadFindState>) =>
    useThreadFindStore.setState((previous) =>
      previous.threadKey === threadKey ? update(previous) : previous,
    );

  const remote = useServerResults(
    isOpen ? thread : null,
    state.query,
    state.offset,
    state.requestId,
    state.start,
    skills,
    progressive,
  );
  const status: "loading" | "error" | null = remote.error
    ? "error"
    : remote.isPending && remote.data === null
      ? "loading"
      : null;
  const localSelection = rebaseLocalSelection(
    state.localSelection,
    remote.data,
    remote.navigationId,
  );
  const count = remote.data?.totalMatches ?? 0;
  const activeIndex = localSelection?.activeIndex ?? remote.data?.activeIndex ?? 0;
  const selectedMatch = localSelection?.match ?? remote.data?.match;
  const entryId = selectedMatch?.entryId;
  const runId = selectedMatch?.runId;
  const occurrence = selectedMatch?.occurrence;
  const counting = remote.data?.complete === false;
  const navigationId = localSelection?.navigationId ?? remote.navigationId;
  const findExpanded = isOpen && state.query.trim().length > 0;
  const findQuery = isOpen && remote.data?.match ? state.query : "";
  const nextTimeline: TimelineFields = {
    findOpen: isOpen,
    findExpanded,
    findQuery,
    activeFindMatch:
      entryId !== undefined && occurrence !== undefined
        ? { entryId, runId: runId ?? null, occurrence }
        : null,
    findNavigationId: navigationId,
  };
  // Keep timeline identity stable during count and response updates to avoid extra jumps.
  const [storedTimeline, setTimeline] = useState(nextTimeline);
  let timeline = storedTimeline;
  if (!sameTimeline(timeline, nextTimeline)) {
    timeline = nextTimeline;
    setTimeline(timeline);
  }
  const match = timeline.activeFindMatch;
  const step = (delta: number) => {
    if (count === 0 || counting) return;
    setState((previous) => {
      const local = rebaseLocalSelection(previous.localSelection, remote.data, remote.navigationId);
      const pending = previous.navigationId !== (local?.navigationId ?? remote.navigationId);
      const selected = local?.match ?? remote.data?.match;
      const nextIndex = stepThreadFindIndex(
        local?.activeIndex ?? remote.data?.activeIndex ?? 0,
        count,
        delta,
      );
      const entry = remote.data?.navigation?.find(
        (entry) => nextIndex >= entry.startIndex && nextIndex < entry.startIndex + entry.count,
      );
      const nextNavigationId = previous.navigationId + 1;
      if (
        !pending &&
        !remote.isPending &&
        entry &&
        remote.data &&
        (!local ||
          local.base === remote.data ||
          remote.data.navigation?.some(
            (entry) =>
              entry.entryId === local.match.entryId && local.match.occurrence < entry.count,
          )) &&
        refreshTimerRef.current === null &&
        lastContentRef.current === content
      ) {
        return {
          ...previous,
          navigationId: nextNavigationId,
          localSelection: {
            base: remote.data,
            baseNavigationId: remote.navigationId,
            activeIndex: nextIndex,
            match: {
              entryId: entry.entryId,
              runId: entry.runId,
              occurrence: nextIndex - entry.startIndex,
            },
            navigationId: nextNavigationId,
          },
        };
      }
      return {
        ...previous,
        start:
          pending || !selected
            ? previous.start
            : { entryId: selected.entryId, occurrence: selected.occurrence },
        offset: pending ? previous.offset + delta : delta,
        navigationId: nextNavigationId,
        requestId: nextNavigationId,
      };
    });
  };

  // Runs from the refresh timer and after a coalesced search settles, against
  // the results and selection showing by then.
  const refreshLiveResults = useEffectEvent(() => {
    if (!isOpen || !state.query.trim()) return;
    // Coalesce paging updates while the server counts to avoid restarting scans.
    if (progressive && remote.isPending) {
      refreshAfterSearchRef.current = true;
      return;
    }
    if (!match || state.navigationId !== navigationId) {
      remote.refresh();
      return;
    }
    const start = { entryId: match.entryId, occurrence: match.occurrence };
    if (
      state.offset === 0 &&
      state.start?.entryId === start.entryId &&
      state.start.occurrence === start.occurrence &&
      state.requestId === state.navigationId
    ) {
      remote.refresh();
    } else {
      setState((previous) => ({
        ...previous,
        start,
        offset: 0,
        requestId: previous.navigationId,
      }));
    }
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reruns a live refresh that was coalesced behind a server search once that search settles
  useEffect(() => {
    if (!refreshAfterSearchRef.current || remote.isPending) return;
    refreshAfterSearchRef.current = false;
    if (!remote.error) refreshLiveResults();
  }, [remote.isPending, remote.error]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- starts a debounce timer to refresh find results when streamed thread content changes
  useEffect(() => {
    if (lastContentRef.current === content) return;
    lastContentRef.current = content;
    if (!isOpen || !state.query.trim() || refreshTimerRef.current !== null) return;
    refreshTimerRef.current = setTimeout(() => {
      refreshTimerRef.current = null;
      refreshLiveResults();
    }, 300);
  }, [content, isOpen, state.query]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- clears the pending refresh timer when the thread, open state or query changes
  useEffect(() => {
    if (!isOpen || threadKey === null || !state.query.trim()) return;
    return () => {
      if (refreshTimerRef.current !== null) clearTimeout(refreshTimerRef.current);
      refreshTimerRef.current = null;
      refreshAfterSearchRef.current = false;
    };
  }, [threadKey, isOpen, state.query]);

  return {
    barProps: {
      open: isOpen,
      query: state.query,
      matchCount: count,
      counting,
      activeIndex,
      status,
      focusRequestId: state.focusRequestId,
      onRetry: remote.refresh,
      onQueryChange: (query: string) => {
        if (threadKey !== null) setThreadFindQuery(threadKey, query);
      },
      onNext: () => step(1),
      onPrevious: () => step(-1),
      onClose: closeThreadFind,
    },
    timelineProps: timeline,
  };
}

export interface TimelineFields {
  readonly findOpen: boolean;
  readonly findExpanded: boolean;
  readonly findQuery: string;
  readonly activeFindMatch: ThreadFindMatch | null;
  readonly findNavigationId: number;
}

function sameTimeline(a: TimelineFields, b: TimelineFields) {
  const aMatch = a.activeFindMatch;
  const bMatch = b.activeFindMatch;
  return (
    a.findOpen === b.findOpen &&
    a.findExpanded === b.findExpanded &&
    a.findQuery === b.findQuery &&
    a.findNavigationId === b.findNavigationId &&
    (aMatch === null || bMatch === null
      ? aMatch === bMatch
      : aMatch.entryId === bMatch.entryId &&
        aMatch.runId === bMatch.runId &&
        aMatch.occurrence === bMatch.occurrence)
  );
}

function rebaseLocalSelection(
  selection: ThreadFindLocalSelection | null,
  data: OrchestrationV2SearchThreadResult | null,
  navigationId: number,
) {
  if (!selection || !data) return null;
  if (selection.base === data && selection.baseNavigationId === navigationId) return selection;
  if (navigationId >= selection.navigationId) return null;
  const entry = data.navigation?.find((entry) => entry.entryId === selection.match.entryId);
  if (!entry || selection.match.occurrence >= entry.count) return selection;
  const activeIndex = entry.startIndex + selection.match.occurrence;
  return activeIndex === selection.activeIndex ? selection : { ...selection, activeIndex };
}

function useServerResults(
  thread: ScopedThreadRef | null,
  query: string,
  offset: number,
  navigationId: number,
  start: ThreadFindStart | undefined,
  skills: readonly InlineSkill[],
  progressive: boolean,
) {
  const skillLabels = skills.map(({ name, displayName }) => ({ name, displayName }));
  const normalizedQuery = query.trim();
  const debouncedQuery = useDebouncedValue(normalizedQuery, 100);
  const environmentId = thread?.environmentId;
  const threadId = thread?.threadId;
  const target =
    environmentId && threadId && debouncedQuery && normalizedQuery === debouncedQuery
      ? {
          environmentId,
          input: {
            threadId,
            query: debouncedQuery,
            ...(start ? { start } : {}),
            ...(offset !== 0 ? { offset } : {}),
            skills: skillLabels,
          },
        }
      : null;
  const targetKey = target ? JSON.stringify([progressive, target]) : null;
  const [storedAtom, setStoredAtom] = useState(() => ({
    key: targetKey,
    atom: resolveThreadFindAtom(target, progressive),
  }));
  let atom = storedAtom.atom;
  if (storedAtom.key !== targetKey) {
    atom = resolveThreadFindAtom(target, progressive);
    setStoredAtom({ key: targetKey, atom });
  }
  const result = useEnvironmentQuery(atom);
  const key = thread
    ? JSON.stringify([thread.environmentId, thread.threadId, normalizedQuery, skillLabels])
    : null;
  const [previous, setPrevious] = useState({
    key,
    data: result.data,
    navigationId,
  });
  if (
    previous.key !== key ||
    (result.data !== null &&
      (!result.isPending || (progressive && previous.data !== result.data)) &&
      (previous.data !== result.data || previous.navigationId !== navigationId))
  ) {
    const response = result.data;
    setPrevious({
      key,
      data: response,
      navigationId,
    });
  }
  return {
    ...result,
    data: key === previous.key && !result.error ? previous.data : null,
    navigationId: previous.navigationId,
    isPending:
      thread !== null &&
      normalizedQuery.length > 0 &&
      (normalizedQuery !== debouncedQuery || result.isPending),
  };
}

function resolveThreadFindAtom(
  target: Parameters<typeof orchestrationEnvironment.threadFind>[0] | null,
  progressive: boolean,
) {
  if (!target) return null;
  return progressive
    ? orchestrationEnvironment.threadFindProgressive(target)
    : orchestrationEnvironment.threadFind(target);
}
