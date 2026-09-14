import type { LegendListRef } from "@legendapp/list/react";
import type { MessageId, TurnId } from "@t3tools/contracts";
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type { TimelineEntry } from "../../session-logic";
import type { MessagesTimelineRow } from "./MessagesTimeline.logic";
import type { CitationHistoryPage } from "./useAssistantCitationTarget";
import { toastManager } from "../ui/toast";

export interface ChatSearchRequest {
  messageId: MessageId;
  key: string;
  query: string;
}

function findSearchRanges(element: HTMLElement, query: string): Range[] {
  const root =
    element.querySelector("[data-assistant-citation-source], [data-user-message-body]") ?? element;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) =>
      node.parentElement?.closest("button, [hidden], [aria-hidden=true], script, style")
        ? NodeFilter.FILTER_REJECT
        : NodeFilter.FILTER_ACCEPT,
  });
  const nodes: { node: Node; start: number; end: number }[] = [];
  let text = "";
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const start = text.length;
    text += node.textContent ?? "";
    nodes.push({ node, start, end: text.length });
  }
  const ranges: Range[] = [];
  const needle = query.trim();
  if (!needle) return ranges;
  const pattern = new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "giu");
  for (const match of text.matchAll(pattern)) {
    if (ranges.length >= 500) break;
    const offset = match.index;
    const first = nodes.find((node) => node.end > offset);
    const end = offset + match[0].length;
    const last = nodes.find((node) => node.end >= end);
    if (!first || !last) continue;
    const range = document.createRange();
    range.setStart(first.node, offset - first.start);
    range.setEnd(last.node, end - last.start);
    ranges.push(range);
  }
  return ranges;
}

/** Load and unfold history before positioning a virtualized search result. */
export function useChatSearchTarget({
  request,
  threadKey,
  entries,
  rows,
  listRef,
  viewport,
  historyLoading,
  loadEarlier,
  onExpandTurn,
  onManualNavigation,
}: {
  request: ChatSearchRequest | null;
  threadKey: string;
  entries: ReadonlyArray<TimelineEntry>;
  rows: ReadonlyArray<MessagesTimelineRow>;
  listRef: RefObject<LegendListRef | null>;
  viewport: HTMLElement | null;
  historyLoading: boolean;
  loadEarlier: CitationHistoryPage | null;
  onExpandTurn: (turnId: TurnId) => void;
  onManualNavigation: () => void;
}) {
  const [loaded, setLoaded] = useState(false);
  const onListLoad = useCallback(() => setLoaded(true), []);
  const [finishedKey, setFinishedKey] = useState<string | null>(null);
  const navigationRef = useRef<{
    key: string;
    pages: Set<string>;
    expanded: boolean;
    done: boolean;
  } | null>(null);
  const key = request ? `${threadKey}:${request.key}` : null;
  const index = request
    ? rows.findIndex((row) => row.kind === "message" && row.message.id === request.messageId)
    : -1;

  useEffect(() => {
    if (!request || !key) {
      navigationRef.current = null;
      setFinishedKey(null);
      return;
    }
    if (navigationRef.current?.key !== key) {
      navigationRef.current = { key, pages: new Set(), expanded: false, done: false };
      onManualNavigation();
    }
    const navigation = navigationRef.current;
    if (navigation.done || !viewport || historyLoading) return;
    const fail = () => {
      navigation.done = true;
      setFinishedKey(key);
      toastManager.add({
        type: "warning",
        title: "Could not show this search result",
        description: "Load earlier turns and try again. The message may have been removed.",
      });
    };
    const source = entries.find(
      (entry) => entry.kind === "message" && entry.message.id === request.messageId,
    );
    if (!source) {
      if (!loadEarlier) {
        fail();
        return;
      }
      if (loadEarlier.loading) return;
      const cursor = loadEarlier.cursor ?? entries[0]?.id ?? "first";
      if (navigation.pages.has(cursor) || navigation.pages.size >= 100) {
        fail();
        return;
      }
      navigation.pages.add(cursor);
      loadEarlier.onLoadEarlier();
      return;
    }
    if (index < 0) {
      if (source.kind === "message" && source.message.turnId && !navigation.expanded) {
        navigation.expanded = true;
        onExpandTurn(source.message.turnId);
      } else {
        fail();
      }
      return;
    }
    if (!loaded || !listRef.current) return;
    let cancelled = false;
    let frame = 0;
    const reveal = () => {
      const element = viewport.querySelector<HTMLElement>(
        `[data-timeline-row-kind="message"][data-message-id="${CSS.escape(request.messageId)}"]`,
      );
      if (!element || cancelled) return;
      observer.disconnect();
      clearTimeout(timeout);
      frame = requestAnimationFrame(() => {
        if (cancelled) return;
        const match = findSearchRanges(element, request.query)[0];
        const scroll = listRef.current?.getState().scroll;
        if (match && scroll !== undefined) {
          const offset =
            scroll +
            match.getBoundingClientRect().top -
            viewport.getBoundingClientRect().top -
            viewport.clientHeight / 2;
          void listRef.current?.scrollToOffset({ offset: Math.max(0, offset), animated: false });
        } else {
          element.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
        }
        navigation.done = true;
        onManualNavigation();
        setFinishedKey(key);
      });
    };
    const observer = new MutationObserver(reveal);
    observer.observe(viewport, { childList: true, subtree: true });
    const timeout = setTimeout(() => {
      observer.disconnect();
      if (!cancelled) fail();
    }, 5000);
    void listRef.current.scrollToIndex({ index, animated: false, viewOffset: 24 });
    reveal();
    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
      observer.disconnect();
      clearTimeout(timeout);
    };
  }, [
    entries,
    historyLoading,
    index,
    key,
    listRef,
    loadEarlier,
    loaded,
    onExpandTurn,
    onManualNavigation,
    request,
    viewport,
  ]);

  useEffect(() => {
    if (!request || !viewport || typeof Highlight === "undefined" || !CSS.highlights) return;
    const highlight = new Highlight();
    CSS.highlights.set("t3-chat-search", highlight);
    let frame = 0;
    const update = () => {
      highlight.clear();
      const element = viewport.querySelector<HTMLElement>(
        `[data-timeline-row-kind="message"][data-message-id="${CSS.escape(request.messageId)}"]`,
      );
      if (element)
        for (const range of findSearchRanges(element, request.query)) highlight.add(range);
    };
    const observer = new MutationObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(update);
    });
    observer.observe(viewport, { childList: true, characterData: true, subtree: true });
    update();
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
      if (CSS.highlights.get("t3-chat-search") === highlight)
        CSS.highlights.delete("t3-chat-search");
    };
  }, [key, request, viewport]);

  const positioning = key !== null && finishedKey !== key;
  const row = positioning && index >= 0 ? rows[index] : undefined;
  return { positioning, onListLoad, alwaysRender: row ? { keys: [row.id] } : undefined };
}
