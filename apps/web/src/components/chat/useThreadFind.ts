import type { OrchestrationThread, ScopedThreadRef } from "@t3tools/contracts";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { deriveTimelineEntries, type TimelineEntry } from "~/session-logic";
import { orchestrationEnvironment } from "~/state/orchestration";
import { useEnvironmentQuery } from "~/state/query";
import { useDebouncedValue } from "~/state/queries";
import { buildThreadFindMatches, clampThreadFindIndex, stepThreadFindIndex } from "./threadFind";
import { subscribeThreadFindOpen } from "./threadFindActionBus";
import { useThreadFindHistory } from "./useThreadFindHistory";

const CLOSED_FIND = {
  threadKey: null as string | null,
  query: "",
  activeIndex: 0,
  focusRequestId: 0,
  navigationId: 0,
};

/** Owns find state and presents the same controls for server search and older-server history. */
export function useThreadFind({
  thread,
  serverSearch,
  content,
  entries,
  history,
}: {
  thread: ScopedThreadRef | null;
  serverSearch: boolean;
  content: Pick<OrchestrationThread, "messages" | "proposedPlans"> | undefined;
  entries: ReadonlyArray<TimelineEntry>;
  history: Parameters<typeof useThreadFindHistory>[1];
}) {
  const threadKey = thread ? scopedThreadKey(thread) : null;
  const [state, setState] = useState(CLOSED_FIND);
  const isOpen = threadKey !== null && state.threadKey === threadKey;
  const open = useCallback(() => {
    if (threadKey === null) return;
    setState((previous) => ({
      ...(previous.threadKey === threadKey ? previous : CLOSED_FIND),
      threadKey,
      focusRequestId: previous.focusRequestId + 1,
    }));
  }, [threadKey]);
  const close = useCallback(() => setState(CLOSED_FIND), []);
  useEffect(() => subscribeThreadFindOpen(open), [open]);

  const remote = useServerResults(
    serverSearch && isOpen ? thread : null,
    state.query,
    state.activeIndex,
    content,
  );
  const localStatus = useThreadFindHistory(
    !serverSearch && isOpen && state.query.trim() ? `${threadKey}:${state.focusRequestId}` : null,
    history,
  );
  let status: "loading" | "incomplete" | "error" | null = localStatus;
  if (serverSearch) {
    status = null;
    if (remote.isPending) status = "loading";
    if (remote.error) status = "error";
  }
  const localMatches = useMemo(
    () =>
      buildThreadFindMatches(
        entries,
        !serverSearch && isOpen && status !== "loading" ? state.query : "",
      ),
    [entries, isOpen, serverSearch, state.query, status],
  );
  const count = serverSearch ? (remote.data?.totalMatches ?? 0) : localMatches.length;
  const activeIndex = serverSearch
    ? (remote.data?.activeIndex ?? 0)
    : clampThreadFindIndex(state.activeIndex, count);
  const searchEntries = useMemo(
    () =>
      remote.data?.match
        ? deriveTimelineEntries(remote.data.messages, remote.data.proposedPlans, [])
        : null,
    [remote.data],
  );
  const selected = remote.data?.match;
  const activeMatch = serverSearch
    ? selected && {
        entryId: selected.sourceId,
        turnId: selected.turnId,
        occurrence: selected.occurrence,
      }
    : localMatches[activeIndex];
  const step = (delta: number) =>
    setState((previous) => ({
      ...previous,
      activeIndex: stepThreadFindIndex(previous.activeIndex, count, delta),
      navigationId: previous.navigationId + 1,
    }));

  return {
    isOpen,
    open,
    close,
    barProps: {
      open: isOpen,
      query: state.query,
      matchCount: count,
      activeIndex,
      historyState: status,
      focusRequestId: state.focusRequestId,
      onRetryHistory: serverSearch ? remote.refresh : open,
      onQueryChange: (query: string) =>
        setState((previous) => ({ ...previous, query, activeIndex: 0 })),
      onNext: () => step(1),
      onPrevious: () => step(-1),
      onClose: close,
    },
    timelineProps: {
      searchEntries,
      onCloseSearch: close,
      findQuery: isOpen && (!serverSearch || searchEntries !== null) ? state.query : "",
      activeFindMatch: activeMatch ?? null,
      findNavigationId: state.navigationId,
    },
  };
}

/** Query atoms cancel obsolete requests; navigation retains only the current query's result. */
function useServerResults(
  thread: ScopedThreadRef | null,
  query: string,
  index: number,
  content: Pick<OrchestrationThread, "messages" | "proposedPlans"> | undefined,
) {
  const normalizedQuery = query.trim();
  const debouncedQuery = useDebouncedValue(normalizedQuery, 200);
  const atom =
    thread && debouncedQuery && normalizedQuery === debouncedQuery
      ? orchestrationEnvironment.threadFind({
          environmentId: thread.environmentId,
          input: { threadId: thread.threadId, query: debouncedQuery, index },
        })
      : null;
  const result = useEnvironmentQuery(atom);
  const { refresh } = result;
  const messages = content?.messages;
  const plans = content?.proposedPlans;
  const revision = useMemo(() => ({ messages, plans }), [messages, plans]);
  const settledRevision = useDebouncedValue(revision, 300);
  const lastRevision = useRef(settledRevision);
  useEffect(() => {
    if (lastRevision.current === settledRevision) return;
    lastRevision.current = settledRevision;
    if (atom !== null) refresh();
  }, [atom, refresh, settledRevision]);
  const key = thread
    ? JSON.stringify([thread.environmentId, thread.threadId, normalizedQuery])
    : null;
  const [previous, setPrevious] = useState({ key, data: result.data });
  if (
    previous.key !== key ||
    (result.data !== null && !result.isPending && previous.data !== result.data)
  ) {
    setPrevious({ key, data: result.data });
  }
  return {
    ...result,
    data: key === previous.key && !result.error ? (result.data ?? previous.data) : null,
    isPending:
      thread !== null &&
      normalizedQuery.length > 0 &&
      (normalizedQuery !== debouncedQuery || result.isPending),
  };
}
