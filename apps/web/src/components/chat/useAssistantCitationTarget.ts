import type { LegendListRef } from "@legendapp/list/react";
import type { TurnId } from "@t3tools/contracts";
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type { TimelineEntry } from "../../session-logic";
import type { MessagesTimelineRow } from "./MessagesTimeline.logic";
import type { AssistantCitationRequest, AssistantCitationTarget } from "./AssistantCitationSource";
import { toastManager } from "../ui/toast";

export interface CitationHistoryPage {
  readonly loading: boolean;
  readonly cursor?: string | null;
  readonly onLoadEarlier: () => void;
}

/** Fetch, unfold, and mount the source before its measured quote owns scrolling. */
export function useAssistantCitationTarget({
  request,
  entries,
  rows,
  listRef,
  viewport,
  historyLoading,
  loadEarlier,
  onExpandTurn,
  onManualNavigation,
}: {
  request: AssistantCitationRequest | null;
  entries: ReadonlyArray<TimelineEntry>;
  rows: ReadonlyArray<MessagesTimelineRow>;
  listRef: RefObject<LegendListRef | null>;
  viewport: HTMLElement | null;
  historyLoading: boolean;
  loadEarlier: CitationHistoryPage | null;
  onExpandTurn: (turnId: TurnId) => void;
  onManualNavigation: () => void;
}) {
  const [ready, setReady] = useState<AssistantCitationTarget | null>(null);
  const [finishedKey, setFinishedKey] = useState<string | null>(null);
  const [listLoaded, setListLoaded] = useState(false);
  const onListLoad = useCallback(() => setListLoaded(true), []);
  const navigationRef = useRef<{
    target: AssistantCitationTarget;
    requestedPages: Set<string>;
    done: boolean;
  } | null>(null);

  useEffect(() => {
    if (navigationRef.current && navigationRef.current.target.key !== request?.key) {
      navigationRef.current.target.activationRef.current.dismissed = true;
      navigationRef.current.target.activationRef.current.cancelScroll?.();
    }
    if (!request) {
      navigationRef.current = null;
      setReady(null);
      setFinishedKey(null);
      return;
    }
    if (navigationRef.current?.target.key !== request.key) {
      const target: AssistantCitationTarget = {
        ...request,
        activationRef: { current: { scrolled: false, dismissed: false } },
        onComplete: () => {
          if (navigationRef.current?.target !== target) return;
          navigationRef.current.done = true;
          // ChatView's thread-open effect can run after our initial opt-out.
          onManualNavigation();
          setFinishedKey(target.key);
        },
      };
      navigationRef.current = {
        target,
        requestedPages: new Set(),
        done: false,
      };
      setReady(null);
      onManualNavigation();
    }
    if (!viewport || historyLoading) return;
    const navigation = navigationRef.current;
    if (navigation.done || navigation.target.activationRef.current.dismissed) return;
    const fail = (title: string, description: string) => {
      navigation.done = true;
      setFinishedKey(navigation.target.key);
      toastManager.add({ type: "warning", title, description });
    };
    const source = entries.find(
      (entry) =>
        entry.kind === "message" && entry.message.id === navigation.target.citation.messageId,
    );
    if (!source) {
      if (loadEarlier) {
        if (loadEarlier.loading) return;
        const cursor = loadEarlier.cursor ?? entries[0]?.id ?? "first";
        if (navigation.requestedPages.has(cursor) || navigation.requestedPages.size >= 20) {
          fail(
            "Could not load the cited response",
            "Load earlier turns, then click the citation to try again. Your saved quote is unchanged.",
          );
          return;
        }
        navigation.requestedPages.add(cursor);
        loadEarlier.onLoadEarlier();
        return;
      }
      fail(
        "The cited response is unavailable",
        "It may have been removed. The selected text is still saved in your citation.",
      );
      return;
    }
    if (source.kind !== "message" || source.message.role !== "assistant") {
      fail(
        "The citation does not refer to an assistant response",
        "The selected text is still saved in your citation.",
      );
      return;
    }
    const index = rows.findIndex(
      (row) => row.kind === "message" && row.message.id === navigation.target.citation.messageId,
    );
    if (index < 0) {
      if (source.message.turnId) onExpandTurn(source.message.turnId);
      return;
    }
    if (listLoaded && listRef.current) setReady(navigation.target);
  }, [
    entries,
    historyLoading,
    listLoaded,
    listRef,
    loadEarlier,
    onExpandTurn,
    onManualNavigation,
    request,
    rows,
    viewport,
  ]);

  useEffect(() => {
    if (!request) return;
    const dismiss = (onlyPending: boolean) => {
      const navigation = navigationRef.current;
      if (!navigation || navigation.target.key !== request.key) return;
      const activation = navigation.target.activationRef.current;
      if (activation.dismissed || (onlyPending && (activation.scrolled || navigation.done))) return;
      activation.dismissed = true;
      activation.cancelScroll?.();
      if (!activation.scrolled && !navigation.done) onManualNavigation();
      navigation.done = true;
      setReady(null);
      setFinishedKey(request.key);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        dismiss(false);
      } else if (
        viewport?.contains(event.target as Node) &&
        ["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)
      ) {
        dismiss(true);
      }
    };
    const onWheel = (event: WheelEvent) => {
      if (event.deltaY !== 0) dismiss(true);
    };
    const onNavigation = () => dismiss(true);
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onNavigation, true);
    viewport?.addEventListener("wheel", onWheel, { passive: true });
    viewport?.addEventListener("touchmove", onNavigation, { passive: true });
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onNavigation, true);
      viewport?.removeEventListener("wheel", onWheel);
      viewport?.removeEventListener("touchmove", onNavigation);
    };
  }, [onManualNavigation, request, viewport]);

  const target = ready?.key === request?.key ? ready : null;
  const positioning = request !== null && finishedKey !== request.key;
  const sourceRow =
    target && positioning
      ? rows.find((row) => row.kind === "message" && row.message.id === target.citation.messageId)
      : undefined;
  return {
    target,
    positioning,
    onListLoad,
    alwaysRender: sourceRow ? { keys: [sourceRow.id] } : undefined,
  };
}
