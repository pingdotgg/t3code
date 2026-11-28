import { T, useGT } from "gt-react";
import { ChevronDownIcon, ChevronUpIcon } from "lucide-react";
import { workspaceAreaProps } from "../../lib/workspaceFocus";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEventHandler,
  type ReactNode,
  type RefObject,
} from "react";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { ScrollArea } from "../ui/scroll-area";
import { cn } from "../../lib/utils";
import { Popover, PopoverPopup, PopoverCreateHandle } from "../ui/popover";
import { selectThreadPanelOpen, useRightPanelStore } from "../../rightPanelStore";
import { useChatCanvas } from "./ChatCanvasContext";
import {
  THREAD_DETAILS_CARD_GAP,
  THREAD_DETAILS_CUT_ORDER,
  resolveThreadDetailsCut,
  type ThreadDetailsCutUnit,
} from "./threadDetailsCardLayout";
import { ThreadDetailsControl } from "./ThreadDetailsControl";
import { observeResize } from "../../lib/observeResize";
import { requestWorkspaceFocus } from "../../lib/workspaceFocus";

export interface ThreadDetailsCardLayout {
  /** Sections a squeezed card hides whole; they carry `data-thread-details-unit`. */
  readonly cut: ReadonlySet<ThreadDetailsCutUnit>;
  /** The row that shows or hides the cut sections, placed last in the workspace tray. */
  readonly reveal: ReactNode;
}

type Slots = Partial<Record<ThreadDetailsCutUnit, number>>;

const isCutUnit = (value: string | undefined): value is ThreadDetailsCutUnit =>
  THREAD_DETAILS_CUT_ORDER.some((unit) => unit === value);

// A `contents` wrapper has no box, so its slot is its cards plus the stack gap before each.
const unitHeight = (unit: HTMLElement) => {
  if (getComputedStyle(unit).display !== "contents") return unit.offsetHeight;
  const gap = unit.parentElement ? parseFloat(getComputedStyle(unit.parentElement).rowGap) || 0 : 0;
  let height = 0;
  for (const child of unit.children) {
    if (child instanceof HTMLElement && child.offsetHeight > 0) height += child.offsetHeight + gap;
  }
  return height;
};

const sameSlots = (a: Slots, b: Slots) =>
  THREAD_DETAILS_CUT_ORDER.every((unit) => a[unit] === b[unit]);

export function ThreadDetailsCard({
  threadRef,
  anchor,
  handle,
  onContextMenu,
  onFocusRequest,
  children,
}: {
  threadRef: ScopedThreadRef;
  anchor: RefObject<Element | null>;
  handle: ReturnType<typeof PopoverCreateHandle>;
  onContextMenu?: MouseEventHandler<HTMLDivElement>;
  onFocusRequest?: () => boolean;
  children: (layout: ThreadDetailsCardLayout) => ReactNode;
}) {
  const gt = useGT();
  const detailsArea = workspaceAreaProps("details", 3, gt("Thread details"));
  const canvas = useChatCanvas();
  const preferredPlacement = canvas?.preferredDetailsCard ?? null;
  const placement = canvas?.detailsCardPlacement ?? null;
  const mode = placement ? "inline" : "popover";
  const topInset = canvas?.detailsCardTopInset ?? 0;
  const inlineOpen = useRightPanelStore((state) =>
    selectThreadPanelOpen(state.threadPanelVisibilityByThreadKey, threadRef, "inline"),
  );
  const popoverOpen = useRightPanelStore((state) =>
    selectThreadPanelOpen(state.threadPanelVisibilityByThreadKey, threadRef, "popover"),
  );
  const height = placement?.height ?? Math.max(0, (canvas?.container.height ?? 0) - 52);
  const measureDetailsCard = canvas?.measureDetailsCard;
  const cardWidth = preferredPlacement?.width;
  const { environmentId, threadId } = threadRef;
  const fitKey = `${environmentId}:${threadId}:${cardWidth ?? "popup"}`;
  const [fit, setFit] = useState({ key: fitKey, full: 0, slots: {} as Slots, reveal: 0 });
  // Last measured height of each section, kept while the section is cut and has no box.
  const slotCache = useRef<{ key: string; slots: Slots }>({ key: fitKey, slots: {} });
  const neededCut =
    mode === "inline" && fit.key === fitKey && fit.full > 0
      ? resolveThreadDetailsCut(height, fit)
      : 0;
  // Expanding holds for the height it was asked at; a moved or closed preview brings back the short card.
  const expandKey = `${fitKey}:${height}`;
  const [expandedAt, setExpandedAt] = useState<string | null>(null);
  const expanded = neededCut > 0 && expandedAt === expandKey;
  const cutCount = expanded ? 0 : neededCut;
  const cut = new Set(THREAD_DETAILS_CUT_ORDER.slice(0, cutCount));
  const asideRef = useRef<HTMLElement>(null);
  const revealRef = useRef<HTMLButtonElement>(null);
  const collapse = (refocus: boolean) => {
    setExpandedAt(null);
    if (refocus) revealRef.current?.focus();
  };
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a document listener collapses the expanded card on a press outside it
  useEffect(() => {
    if (!expanded) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (
        !(target instanceof Element) ||
        asideRef.current?.contains(target) ||
        // Menus the card opens portal out of it.
        target.closest('[data-slot$="-popup"], [data-slot$="-positioner"]')
      )
        return;
      setExpandedAt(null);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [expanded]);
  // The mode derives from canvas measurements, the preview frame and the
  // inline flag, which live in three stores, so no single write site sees the
  // card leave popover mode. A flag left set would reopen the popover unasked
  // when the card returns to popover mode.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- closes the popover flag in the right panel store when the derived mode turns inline
  useLayoutEffect(() => {
    if (mode === "inline" && popoverOpen)
      useRightPanelStore.getState().setThreadPanelOpen(threadRef, "popover", false);
  }, [mode, popoverOpen, threadRef]);
  const [contentElement, setContentElement] = useState<HTMLDivElement | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- measures the card's DOM height via ResizeObserver and reports it to the canvas
  useLayoutEffect(() => {
    const element = contentElement;
    if (!element) return;
    const measure = () => {
      const frame = element.closest<HTMLElement>("[data-thread-details-frame]");
      const cached = slotCache.current.key === fitKey ? slotCache.current.slots : {};
      const slots: Slots = {};
      const hidden = new Set<ThreadDetailsCutUnit>();
      for (const unit of element.querySelectorAll<HTMLElement>("[data-thread-details-unit]")) {
        const name = unit.dataset.threadDetailsUnit;
        if (!isCutUnit(name)) continue;
        if (unit.hidden) hidden.add(name);
        else slots[name] = (slots[name] ?? 0) + unitHeight(unit);
      }
      let hiddenHeight = 0;
      for (const name of hidden) {
        slots[name] = cached[name] ?? 0;
        hiddenHeight += slots[name];
      }
      slotCache.current = { key: fitKey, slots };
      const revealElement = element.querySelector<HTMLElement>("[data-thread-details-reveal]");
      // Before the row first shows, its size is its padding plus one 1.75rem row.
      const reveal =
        revealElement?.offsetHeight ||
        parseFloat(getComputedStyle(document.documentElement).fontSize) * 1.875;
      // The full height counts cut sections, so the canvas and the cut never chase each other.
      const full =
        element.offsetHeight -
        (revealElement?.offsetHeight ?? 0) +
        hiddenHeight +
        (frame ? frame.offsetHeight - frame.clientHeight : 0);
      setFit((current) =>
        current.key === fitKey &&
        current.full === full &&
        current.reveal === reveal &&
        sameSlots(current.slots, slots)
          ? current
          : { key: fitKey, full, slots, reveal },
      );
      // Only the laid-out DOM knows the full card height, and the canvas keeps preview
      // frames clear of it, so it is reported from this measure effect.
      if (cardWidth !== undefined) {
        measureDetailsCard?.({
          threadRef: { environmentId, threadId },
          width: cardWidth,
          fullContentHeight: full,
        });
      }
    };
    measure();
    return observeResize(element, measure);
  }, [contentElement, cardWidth, measureDetailsCard, environmentId, threadId, fitKey]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- moves DOM focus off a row the squeeze just hid, before the browser drops it to the page
  useLayoutEffect(() => {
    const active = document.activeElement;
    if (cutCount > 0 && active && contentElement?.contains(active) && active.closest("[hidden]"))
      revealRef.current?.focus();
  }, [cutCount, contentElement]);
  const reveal =
    neededCut > 0 ? (
      <div className="px-0.5 pt-0.5" data-thread-details-reveal>
        <ThreadDetailsControl
          ref={revealRef}
          variant="ghost"
          size="sm"
          tone="muted"
          aria-expanded={expanded}
          onClick={() => (expanded ? collapse(false) : setExpandedAt(expandKey))}
          className="w-full active:scale-100"
        >
          {expanded ? (
            <ChevronUpIcon aria-hidden className="size-4 shrink-0" />
          ) : (
            <ChevronDownIcon aria-hidden className="size-4 shrink-0" />
          )}
          {expanded ? <T>Show fewer</T> : <T>Show all details</T>}
        </ThreadDetailsControl>
      </div>
    ) : null;
  const fullHeight = preferredPlacement?.height ?? height;
  const card = (
    <div
      className={cn(
        "isolate grid min-w-0 max-h-full grid-rows-[minmax(0,1fr)]",
        mode === "popover" &&
          "max-h-[min(calc(100dvh-6.5rem),calc(var(--available-height,100dvh)-1rem))]",
        // Over the preview, the gaps between cards get a fill; no rim, so rows keep their width.
        expanded && "rounded-pane border-0 surface-popover",
      )}
      // Expanded, the card is only as tall as its content so the preview below stays reachable.
      style={expanded ? { maxHeight: fullHeight } : { height }}
      onContextMenu={onContextMenu}
      data-thread-details-frame
      data-thread-details-squeezed={cutCount > 0 || undefined}
    >
      <ScrollArea orientation="vertical" className="min-h-0 min-w-0">
        <div ref={setContentElement} className="min-w-0 overflow-x-clip">
          {children({ cut, reveal: mode === "inline" ? reveal : null })}
        </div>
      </ScrollArea>
    </div>
  );
  return (
    <Popover
      handle={handle}
      open={mode === "popover" && popoverOpen}
      onOpenChange={(open, details) => {
        const target =
          details.reason === "focus-out"
            ? (details.event as FocusEvent).relatedTarget
            : details.reason === "outside-press"
              ? details.event.target
              : null;
        if (!open && target instanceof Element && target.closest("[data-thread-find-bar]")) {
          details.cancel();
          return;
        }
        useRightPanelStore.getState().setThreadPanelOpen(threadRef, "popover", open);
      }}
    >
      {placement && inlineOpen ? (
        <aside
          {...detailsArea}
          ref={asideRef}
          data-workspace-focus-key={`details:${threadRef.environmentId}:${threadRef.threadId}`}
          // Skip the return transition to avoid overlapping the rising preview.
          className={cn(
            // Expanded, the card covers the floating preview (z-47 to z-49).
            expanded ? "absolute z-50" : "absolute z-20",
            topInset > 0 && "transition-[top] duration-150 ease-out motion-reduce:transition-none",
          )}
          style={{
            right: placement.right,
            top: placement.y,
            width: placement.width,
            maxHeight: expanded ? fullHeight : height,
          }}
          onKeyDown={(event) => {
            if (!expanded || event.key !== "Escape" || event.defaultPrevented) return;
            event.preventDefault();
            event.stopPropagation();
            collapse(true);
          }}
          data-thread-details-panel="inline"
          data-sidebar-slide-track="end"
        >
          {card}
        </aside>
      ) : null}
      {/* Rendered in both modes: base-ui keeps a popup that unmounts mid-open
          mounted, because its exit animation never finishes. Staying in the tree
          lets it close cleanly when the card switches inline. */}
      <PopoverPopup
        {...(mode === "popover" ? detailsArea : {})}
        role="dialog"
        data-workspace-focus-key={`details:${threadRef.environmentId}:${threadRef.threadId}`}
        initialFocus={() => {
          if (onFocusRequest?.()) return false;
          requestWorkspaceFocus({ area: "details" });
          return false;
        }}
        anchor={anchor}
        align="end"
        // Account for the find panel's 8px card padding.
        alignOffset={THREAD_DETAILS_CARD_GAP - 8}
        collisionAvoidance={{ side: "shift", align: "shift", fallbackAxisSide: "none" }}
        side="bottom"
        sideOffset={topInset}
        variant="panel"
        padding="none"
      >
        {mode === "popover" ? <div data-thread-details-panel="popover">{card}</div> : null}
      </PopoverPopup>
    </Popover>
  );
}
