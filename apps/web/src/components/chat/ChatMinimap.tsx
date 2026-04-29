import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type LegendListRef } from "@legendapp/list/react";

import { cn } from "~/lib/utils";
import { PreviewCard, PreviewCardTrigger } from "~/components/ui/preview-card";
import { useSettings } from "~/hooks/useSettings";
import {
  computeActiveMinimapIndex,
  selectVisibleMinimapEntries,
  type MinimapUserMessageEntry,
} from "./ChatMinimap.logic";

interface ChatMinimapProps {
  listRef: React.RefObject<LegendListRef | null>;
  entries: ReadonlyArray<MinimapUserMessageEntry>;
  threadKey: string;
}

const EXPAND_DELAY_MS = 60;
const COLLAPSE_DELAY_MS = 150;

const displayPreviewText = (entry: MinimapUserMessageEntry) =>
  entry.previewText.trim() || "(empty message)";

export const ChatMinimap = memo(function ChatMinimap({
  listRef,
  entries,
  threadKey,
}: ChatMinimapProps) {
  const hideChatMinimap = useSettings((s) => s.hideChatMinimap);
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [navHeight, setNavHeight] = useState<number | null>(null);
  const activeButtonRef = useRef<HTMLButtonElement | null>(null);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);

  // Track the nav's height so the strip can decide how many dashes will fit.
  // A callback ref is used so we re-attach the observer if the nav element
  // itself unmounts (e.g. when `hideChatMinimap` toggles); a plain useRef +
  // useEffect would race with the conditional render.
  const navCallbackRef = useCallback((nav: HTMLElement | null) => {
    resizeObserverRef.current?.disconnect();
    resizeObserverRef.current = null;
    if (!nav) {
      setNavHeight(null);
      return;
    }
    setNavHeight(nav.clientHeight);
    const observer = new ResizeObserver(() => setNavHeight(nav.clientHeight));
    observer.observe(nav);
    resizeObserverRef.current = observer;
  }, []);

  useEffect(
    () => () => {
      resizeObserverRef.current?.disconnect();
      resizeObserverRef.current = null;
    },
    [],
  );

  // Reset active highlight + collapse the menu on thread switch so a stale
  // index or an open menu doesn't flash against the freshly-loaded thread.
  useEffect(() => {
    setActiveIndex(null);
    setIsOpen(false);
  }, [threadKey]);

  // Active-dash tracking (event-driven)
  useEffect(() => {
    if (entries.length === 0) return;
    const list = listRef.current;
    if (!list) return;

    const recompute = () => {
      const state = list.getState?.();
      if (!state) return;
      const next = computeActiveMinimapIndex(state, entries);
      if (next === undefined) return; // not measured yet
      setActiveIndex((prev) => (prev === next ? prev : next));
    };

    const scrollNode = list.getScrollableNode?.() ?? null;
    scrollNode?.addEventListener("scroll", recompute, { passive: true });
    // `listen` lives on the state object, not the ref itself. Payload is a
    // timestamp we don't need — we just want a pulse on each remeasure.
    const unsubscribe = list.getState?.()?.listen?.("lastPositionUpdate", () => {
      recompute();
    });

    recompute();

    return () => {
      scrollNode?.removeEventListener("scroll", recompute);
      unsubscribe?.();
    };
  }, [listRef, entries, threadKey]);

  // When the menu opens, scroll the active row into view so a long
  // conversation doesn't require the user to hunt for the current position.
  useEffect(() => {
    if (!isOpen) return;
    if (activeButtonRef.current) {
      activeButtonRef.current.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
  }, [isOpen, activeIndex]);

  const navigate = useCallback(
    (entry: MinimapUserMessageEntry) => {
      void listRef.current?.scrollToIndex?.({
        index: entry.rowIndex,
        animated: true,
        viewPosition: 0.08,
      });
      setIsOpen(false);
    },
    [listRef],
  );

  if (hideChatMinimap || entries.length === 0) return null;

  return (
    <PreviewCard open={isOpen} onOpenChange={setIsOpen}>
      <nav
        ref={navCallbackRef}
        aria-label="User messages minimap"
        className="pointer-events-none absolute top-3 right-1 bottom-3 z-20 flex flex-col items-end @md/chat:right-2"
        data-testid="chat-minimap"
        data-expanded={isOpen ? "true" : undefined}
      >
        <PreviewCardTrigger
          className="pointer-events-auto"
          closeDelay={COLLAPSE_DELAY_MS}
          delay={EXPAND_DELAY_MS}
          render={<div />}
        >
          {isOpen ? (
            <ExpandedMenu
              entries={entries}
              activeIndex={activeIndex}
              onNavigate={navigate}
              activeButtonRef={activeButtonRef}
            />
          ) : (
            <DashesStrip entries={entries} activeIndex={activeIndex} navHeight={navHeight} />
          )}
        </PreviewCardTrigger>
      </nav>
    </PreviewCard>
  );
});

/**
 * Collapsed view — thin vertical strip of dashes.
 *
 * Dashes always render at their natural size (`h-0.75` / `gap-1`). When a
 * thread has too many user messages to fit one dash per row, we sample down
 * to whatever the column can hold (see `selectVisibleMinimapEntries`). The
 * strip never scrolls and dashes never overlap; the expanded preview card
 * remains the source of truth for exact navigation.
 */
function DashesStrip({
  entries,
  activeIndex,
  navHeight,
}: {
  entries: ReadonlyArray<MinimapUserMessageEntry>;
  activeIndex: number | null;
  navHeight: number | null;
}) {
  const { visibleEntries, visibleActiveIndex, hiddenCount } = useMemo(
    () => selectVisibleMinimapEntries({ entries, navHeight, activeIndex }),
    [entries, navHeight, activeIndex],
  );

  return (
    <div className="flex flex-col items-end gap-0.5">
      <ul
        className="flex flex-col items-end gap-1 px-1 py-1 @md/chat:px-1.5"
        data-testid="chat-minimap-list"
      >
        {visibleEntries.map((entry, index) => {
          const isActive = visibleActiveIndex === index;
          return (
            <li key={entry.rowKey} className="flex justify-end">
              <span
                data-testid="chat-minimap-dash"
                aria-current={isActive ? "true" : undefined}
                className={cn(
                  "h-0.75 w-3 rounded-full transition-colors duration-150 @md/chat:w-3.5",
                  isActive ? "bg-foreground" : "bg-foreground/10",
                )}
              />
            </li>
          );
        })}
      </ul>
      {hiddenCount > 0 && (
        <span
          data-testid="chat-minimap-overflow"
          aria-label={`${hiddenCount} more user messages not shown`}
          className="px-1 text-[9px] tabular-nums text-foreground/40 @md/chat:px-1.5"
        >
          +{hiddenCount}
        </span>
      )}
    </div>
  );
}

/**
 * Expanded view — dropdown-style list of message previews. Opens on hover
 */
function ExpandedMenu({
  entries,
  activeIndex,
  onNavigate,
  activeButtonRef,
}: {
  entries: ReadonlyArray<MinimapUserMessageEntry>;
  activeIndex: number | null;
  onNavigate: (entry: MinimapUserMessageEntry) => void;
  activeButtonRef: React.RefObject<HTMLButtonElement | null>;
}) {
  return (
    <div
      className="mr-3 flex h-[min(60vh,24rem)] min-w-45 max-w-88 flex-col overflow-hidden rounded-lg border border-border bg-popover shadow-lg not-dark:bg-clip-padding"
      data-testid="chat-minimap-menu"
    >
      <ul className="flex flex-1 flex-col gap-0.5 overflow-y-auto overscroll-contain p-1.5">
        {entries.map((entry, index) => {
          const isActive = activeIndex === index;
          const preview = displayPreviewText(entry);
          return (
            <li key={entry.rowKey}>
              <button
                type="button"
                data-testid="chat-minimap-menu-item"
                data-active={isActive ? "true" : undefined}
                data-message-id={entry.messageId}
                aria-current={isActive ? "true" : undefined}
                ref={isActive ? activeButtonRef : null}
                onClick={() => onNavigate(entry)}
                className={cn(
                  "w-full cursor-pointer rounded-md px-3 py-1.5 text-left text-sm transition-colors",
                  "hover:bg-muted hover:text-foreground",
                  isActive ? "bg-muted/70 text-foreground" : "text-foreground/75",
                )}
              >
                <span className="block truncate">{preview}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
