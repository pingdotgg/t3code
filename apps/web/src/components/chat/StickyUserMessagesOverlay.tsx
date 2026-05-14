import { type MessageId, type ServerProviderSkill } from "@t3tools/contracts";
import type {
  StickyUserMessageCount,
  StickyUserMessageMaxLines,
  TimestampFormat,
} from "@t3tools/contracts/settings";
import type { LegendListRef } from "@legendapp/list/react";
import * as Equal from "effect/Equal";
import { useEffect, useRef, useState, type RefObject } from "react";

import type { ChatMessage } from "../../types";
import { formatTimestamp } from "../../timestampFormat";
import { cn } from "~/lib/utils";
import { deriveDisplayedUserMessageState } from "~/lib/terminalContext";
import { SkillInlineText } from "./SkillInlineText";
import type { MessagesTimelineRow } from "./MessagesTimeline.logic";

type UserTimelineMessage = ChatMessage & { role: "user" };

export interface StickyUserMessageEntry {
  id: MessageId;
  rowIndex: number;
  message: UserTimelineMessage;
}

export function deriveStickyUserMessageEntries(
  rows: ReadonlyArray<MessagesTimelineRow>,
  count: StickyUserMessageCount,
): StickyUserMessageEntry[] {
  if (count <= 0) {
    return [];
  }

  const entries: StickyUserMessageEntry[] = [];
  for (let rowIndex = rows.length - 1; rowIndex >= 0 && entries.length < count; rowIndex -= 1) {
    const row = rows[rowIndex];
    if (row?.kind !== "message") {
      continue;
    }

    const { message } = row;
    if (!isUserTimelineMessage(message)) {
      continue;
    }

    entries.unshift({
      id: message.id,
      rowIndex,
      message,
    });
  }

  return entries;
}

function isUserTimelineMessage(message: ChatMessage): message is UserTimelineMessage {
  return message.role === "user";
}

export function useHiddenStickyUserMessageIds({
  entries,
  listRef,
  timelineViewportRef,
  enabled,
}: {
  entries: ReadonlyArray<StickyUserMessageEntry>;
  listRef: RefObject<LegendListRef | null>;
  timelineViewportRef: RefObject<HTMLDivElement | null>;
  enabled: boolean;
}): ReadonlySet<MessageId> {
  const [hiddenMessageIds, setHiddenMessageIds] = useState<ReadonlySet<MessageId>>(() => new Set());
  const entriesRef = useRef(entries);
  entriesRef.current = entries;
  const entryKey = entries.map((entry) => entry.id).join("\n");

  useEffect(() => {
    if (!enabled || entryKey.length === 0) {
      setHiddenMessageIds((current) => (current.size === 0 ? current : new Set()));
      return;
    }

    const timelineViewport = timelineViewportRef.current;
    const scrollRoot = getTimelineScrollRoot(timelineViewport);
    if (!timelineViewport || !scrollRoot) {
      return;
    }

    let disposed = false;
    let animationFrameId: number | null = null;

    const measure = () => {
      if (disposed) return;
      const rootRect = scrollRoot.getBoundingClientRect();
      const listState = listRef.current?.getState?.();
      const currentEntries = entriesRef.current;

      setHiddenMessageIds((current) => {
        const next = new Set<MessageId>();
        for (const entry of currentEntries) {
          const source = findStickyUserMessageSource(timelineViewport, entry.id);
          if (!source) {
            if (
              (listState && entry.rowIndex < listState.start) ||
              (!listState && current.has(entry.id))
            ) {
              next.add(entry.id);
            }
            continue;
          }

          const sourceRect = source.getBoundingClientRect();
          const isVisible = sourceRect.bottom > rootRect.top && sourceRect.top < rootRect.bottom;
          const isAboveViewport = sourceRect.bottom <= rootRect.top;
          if (!isVisible && isAboveViewport) {
            next.add(entry.id);
          }
        }

        return Equal.equals(current, next) ? current : next;
      });
    };

    const scheduleMeasure = () => {
      if (animationFrameId !== null) {
        return;
      }
      animationFrameId = window.requestAnimationFrame(() => {
        animationFrameId = null;
        measure();
      });
    };

    measure();
    scrollRoot.addEventListener("scroll", scheduleMeasure, { passive: true });
    window.addEventListener("resize", scheduleMeasure);

    return () => {
      disposed = true;
      if (animationFrameId !== null) {
        window.cancelAnimationFrame(animationFrameId);
      }
      scrollRoot.removeEventListener("scroll", scheduleMeasure);
      window.removeEventListener("resize", scheduleMeasure);
    };
  }, [enabled, entryKey, listRef, timelineViewportRef]);

  return hiddenMessageIds;
}

export function StickyUserMessagesOverlay({
  entries,
  hiddenMessageIds,
  listRef,
  maxLines,
  skills,
  timestampFormat,
  timelineViewportRef,
}: {
  entries: ReadonlyArray<StickyUserMessageEntry>;
  hiddenMessageIds: ReadonlySet<MessageId>;
  listRef: RefObject<LegendListRef | null>;
  maxLines: StickyUserMessageMaxLines;
  skills: ReadonlyArray<Pick<ServerProviderSkill, "name" | "displayName">>;
  timestampFormat: TimestampFormat;
  timelineViewportRef: RefObject<HTMLDivElement | null>;
}) {
  const visibleEntries = entries.filter((entry) => hiddenMessageIds.has(entry.id));

  if (visibleEntries.length === 0) {
    return null;
  }

  return (
    <div
      className="pointer-events-none absolute inset-x-0 top-0 z-20 px-3 pt-2 sm:px-5"
      data-sticky-user-messages="true"
    >
      <div className="mx-auto flex w-full max-w-3xl flex-col items-end gap-1.5">
        {visibleEntries.map((entry, index) => (
          <StickyUserMessageBubble
            key={entry.id}
            entry={entry}
            maxLines={maxLines}
            showMeta={index === visibleEntries.length - 1}
            skills={skills}
            timestampFormat={timestampFormat}
            onClick={() =>
              scrollToStickyUserMessageSource({
                entry,
                listRef,
                timelineViewportRef,
              })
            }
          />
        ))}
      </div>
    </div>
  );
}

function StickyUserMessageBubble({
  entry,
  maxLines,
  onClick,
  showMeta,
  skills,
  timestampFormat,
}: {
  entry: StickyUserMessageEntry;
  maxLines: StickyUserMessageMaxLines;
  onClick: () => void;
  showMeta: boolean;
  skills: ReadonlyArray<Pick<ServerProviderSkill, "name" | "displayName">>;
  timestampFormat: TimestampFormat;
}) {
  const [mounted, setMounted] = useState(false);
  const displayedUserMessage = deriveDisplayedUserMessageState(entry.message.text);
  const textRef = useRef<HTMLDivElement>(null);
  const [hiddenLineCount, setHiddenLineCount] = useState(0);

  useEffect(() => {
    const frameId = window.requestAnimationFrame(() => setMounted(true));
    return () => window.cancelAnimationFrame(frameId);
  }, []);

  useEffect(() => {
    if (!showMeta) {
      setHiddenLineCount((current) => (current === 0 ? current : 0));
      return;
    }

    let frameId: number | null = null;
    const textElement = textRef.current;

    const measureHiddenLines = () => {
      if (!textElement) {
        setHiddenLineCount(0);
        return;
      }

      const lineHeight = Number.parseFloat(window.getComputedStyle(textElement).lineHeight);
      if (!Number.isFinite(lineHeight) || lineHeight <= 0) {
        setHiddenLineCount(0);
        return;
      }

      const totalLines = Math.ceil(textElement.scrollHeight / lineHeight);
      const nextHiddenLineCount = Math.max(0, totalLines - maxLines);
      setHiddenLineCount((current) =>
        current === nextHiddenLineCount ? current : nextHiddenLineCount,
      );
    };

    const scheduleMeasure = () => {
      if (frameId !== null) {
        window.cancelAnimationFrame(frameId);
      }
      frameId = window.requestAnimationFrame(() => {
        frameId = null;
        measureHiddenLines();
      });
    };

    scheduleMeasure();
    window.addEventListener("resize", scheduleMeasure);
    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(scheduleMeasure);
    if (textElement) {
      observer?.observe(textElement);
    }

    return () => {
      if (frameId !== null) {
        window.cancelAnimationFrame(frameId);
      }
      observer?.disconnect();
      window.removeEventListener("resize", scheduleMeasure);
    };
  }, [displayedUserMessage.visibleText, maxLines, showMeta]);

  return (
    <button
      type="button"
      aria-label="Scroll to original user message"
      className={cn(
        "pointer-events-auto max-w-[80%] rounded-2xl rounded-br-sm border border-border/80 bg-secondary/95 px-3 py-2 text-left shadow-sm backdrop-blur-sm transition-[opacity,transform,background-color,border-color] duration-150 ease-out hover:border-border hover:bg-secondary",
        mounted ? "translate-y-0 opacity-100" : "-translate-y-1 opacity-0",
      )}
      data-sticky-user-message-id={entry.id}
      onClick={onClick}
    >
      <div
        ref={textRef}
        className="wrap-break-word overflow-hidden whitespace-pre-wrap text-sm leading-relaxed text-foreground"
        style={{
          display: "-webkit-box",
          WebkitBoxOrient: "vertical",
          WebkitLineClamp: maxLines,
        }}
      >
        <SkillInlineText text={displayedUserMessage.visibleText} skills={skills} />
      </div>
      {showMeta ? (
        <div
          className="mt-1.5 flex items-center justify-between gap-3 text-xs text-muted-foreground/50"
          data-sticky-user-message-meta="true"
        >
          <span>{hiddenLineCount > 0 ? formatHiddenLineCount(hiddenLineCount) : null}</span>
          <span className="ml-auto">
            {formatTimestamp(entry.message.createdAt, timestampFormat)}
          </span>
        </div>
      ) : null}
    </button>
  );
}

function getTimelineScrollRoot(timelineViewport: HTMLDivElement | null): HTMLElement | null {
  const firstChild = timelineViewport?.firstElementChild;
  return firstChild instanceof HTMLElement ? firstChild : null;
}

function findStickyUserMessageSource(
  timelineViewport: HTMLDivElement,
  messageId: MessageId,
): HTMLElement | null {
  return timelineViewport.querySelector<HTMLElement>(
    `[data-sticky-user-message-source='true'][data-message-id="${CSS.escape(messageId)}"]`,
  );
}

function scrollToStickyUserMessageSource({
  entry,
  listRef,
  timelineViewportRef,
}: {
  entry: StickyUserMessageEntry;
  listRef: RefObject<LegendListRef | null>;
  timelineViewportRef: RefObject<HTMLDivElement | null>;
}) {
  const timelineViewport = timelineViewportRef.current;
  const source = timelineViewport ? findStickyUserMessageSource(timelineViewport, entry.id) : null;
  if (source) {
    source.scrollIntoView({ block: "start", behavior: "smooth" });
    return;
  }

  void listRef.current?.scrollToIndex({
    index: entry.rowIndex,
    animated: true,
  });
}

function formatHiddenLineCount(hiddenLineCount: number): string {
  return hiddenLineCount === 1 ? "+1 line" : `+${hiddenLineCount} lines`;
}
