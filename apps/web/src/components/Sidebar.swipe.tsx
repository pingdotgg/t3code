import {
  useCallback,
  useEffect,
  useRef,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";

import { cn } from "~/lib/utils";

/**
 * One tappable action behind a thread row, revealed by swiping. `onPress`
 * receives the tap position so callers can anchor menus (snooze presets) to
 * the button. `primary` marks the lifecycle action a full swipe commits;
 * secondary actions (snooze) are reachable only by tapping their button.
 */
export interface ThreadSwipeAction {
  readonly id: string;
  readonly label: string;
  readonly icon: ReactNode;
  readonly className: string;
  readonly primary?: boolean;
  readonly onPress: (position: { x: number; y: number }) => void;
}

/**
 * Which swipe actions a row offers, resolved from the same inputs the hover
 * affordances use. Mirrors mobile's resolveThreadListV2SwipeActions: the
 * lifecycle action is the primary (full-swipe commits it), snooze is the
 * secondary, and the opposite direction toggles the pin.
 */
export interface ThreadSwipeActionKinds {
  /** Swiping left. `settle` / `unsettle` / `unsnooze`, or null when the server lacks the capability. */
  readonly primary: "settle" | "unsettle" | "unsnooze" | null;
  /** Swiping left, beside the primary. Only where snooze can succeed right now. */
  readonly snooze: boolean;
  /** Swiping right. */
  readonly pin: "pin" | "unpin" | null;
}

export function resolveThreadSwipeActions(input: {
  readonly variantAction: "settle" | "unsettle" | "unsnooze";
  readonly settlementSupported: boolean;
  readonly snoozeSupported: boolean;
  readonly canSnoozeNow: boolean;
  readonly pinningSupported: boolean;
  readonly isPinned: boolean;
}): ThreadSwipeActionKinds {
  const primary =
    input.variantAction === "unsnooze"
      ? input.snoozeSupported
        ? ("unsnooze" as const)
        : null
      : input.settlementSupported
        ? input.variantAction
        : null;
  return {
    primary,
    snooze: input.variantAction !== "unsnooze" && input.snoozeSupported && input.canSnoozeNow,
    pin: input.pinningSupported ? (input.isPinned ? "unpin" : "pin") : null,
  };
}

// Gesture math in px; the button itself sizes with w-18 (same 72px).
const ACTION_WIDTH = 72;
/** Drag distance that snaps the row open instead of springing back. */
const OPEN_THRESHOLD = 32;
/** Extra drag past the actions that commits the direction's first action outright. */
const FULL_SWIPE_EXTRA = 48;
const DECIDE_PX = 6;
/** Vertical dominance cancels the swipe and hands the gesture to list scrolling. */
const VERTICAL_CANCEL_PX = 10;
/** Drag past the actions resists instead of running away. */
const MAX_OVERDRAG = 60;

export type SwipeRelease = "commit" | "open" | "close";

/** Drag distance that commits the direction's first action outright. */
function swipeCommitThreshold(actionsWidth: number, contentWidth: number): number {
  return Math.max(actionsWidth + FULL_SWIPE_EXTRA, contentWidth * 0.55);
}

/** Pure release decision so the thresholds stay testable. */
export function resolveSwipeRelease(input: {
  readonly offset: number;
  readonly actionsWidth: number;
  readonly contentWidth: number;
}): SwipeRelease {
  const distance = Math.abs(input.offset);
  if (input.actionsWidth === 0) return "close";
  if (distance >= swipeCommitThreshold(input.actionsWidth, input.contentWidth)) return "commit";
  if (distance >= OPEN_THRESHOLD) return "open";
  return "close";
}

export interface SwipeGestureState {
  readonly pointerId: number;
  readonly startX: number;
  readonly startY: number;
  readonly offset: number;
  readonly decided: boolean;
  readonly direction: "start" | "end";
}

/**
 * Pure drag update so the direction and offset math stays testable. The
 * direction follows the finger until release: a drag that crosses back over
 * the origin flips sides rather than committing the action it left behind.
 * The drag cap stretches to the commit threshold so a full swipe is always
 * reachable, even on short rows where the width bound is binding.
 */
export function updateSwipeGesture(
  gesture: Omit<SwipeGestureState, "pointerId">,
  dx: number,
  dy: number,
  widths: { readonly start: number; readonly end: number },
  contentWidth: number,
):
  | { readonly _tag: "cancel" }
  | { readonly _tag: "move"; readonly state: Omit<SwipeGestureState, "pointerId"> } {
  if (!gesture.decided) {
    if (Math.abs(dy) > VERTICAL_CANCEL_PX && Math.abs(dy) > Math.abs(dx)) {
      return { _tag: "cancel" };
    }
    if (Math.abs(dx) < DECIDE_PX) {
      return { _tag: "move", state: gesture };
    }
  }
  const direction = dx > 0 ? "start" : "end";
  const width = widths[direction];
  // A side with no actions has nothing to reveal, so the row stays put.
  const limit =
    width === 0 ? 0 : Math.max(width + MAX_OVERDRAG, swipeCommitThreshold(width, contentWidth));
  return {
    _tag: "move",
    state: {
      decided: true,
      direction,
      offset: Math.max(-limit, Math.min(limit, dx)),
      startX: gesture.startX,
      startY: gesture.startY,
    },
  };
}

// Only one row's actions stay open at a time; the newest open row closes the
// previous one. A single module slot is enough because every row closes
// through the same helper.
let activeSwipeableClose: (() => void) | null = null;

/**
 * Touch (and pen) swipe chrome for a sidebar thread row. Mouse input is
 * ignored entirely — hover affordances, clicks, and pinned-row drag remain
 * exactly as they were. The row content translates over a colored action
 * layer; transforms and layer visibility are applied straight to the DOM so
 * a drag never re-renders the row.
 */
export function ThreadSwipeable(props: {
  readonly start: ThreadSwipeAction | null;
  readonly end: readonly ThreadSwipeAction[];
  readonly children: ReactNode;
}) {
  const contentRef = useRef<HTMLDivElement | null>(null);
  const startLayerRef = useRef<HTMLDivElement | null>(null);
  const endLayerRef = useRef<HTMLDivElement | null>(null);
  const openSideRef = useRef<"start" | "end" | null>(null);
  const swallowClickRef = useRef(false);
  const gestureRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    offset: number;
    decided: boolean;
    direction: "start" | "end";
  } | null>(null);

  const actionsWidthFor = useCallback(
    (direction: "start" | "end") =>
      direction === "start" ? (props.start ? ACTION_WIDTH : 0) : props.end.length * ACTION_WIDTH,
    [props.start, props.end.length],
  );

  // Stable identity for the single-open registry: whichever row registered
  // last closes the previous one through this slot.
  const selfCloseRef = useRef<() => void>(() => {});
  const close = useCallback(() => {
    openSideRef.current = null;
    if (activeSwipeableClose === selfCloseRef.current) activeSwipeableClose = null;
    const content = contentRef.current;
    if (content) {
      content.style.transition = "transform 180ms ease-out";
      content.style.transform = "";
      content.classList.toggle("bg-sidebar", false);
    }
    if (startLayerRef.current) startLayerRef.current.style.visibility = "hidden";
    if (endLayerRef.current) endLayerRef.current.style.visibility = "hidden";
  }, []);

  useEffect(() => {
    selfCloseRef.current = close;
    return () => {
      if (activeSwipeableClose === selfCloseRef.current) activeSwipeableClose = null;
    };
  }, [close]);

  const open = useCallback(
    (direction: "start" | "end") => {
      activeSwipeableClose?.();
      activeSwipeableClose = selfCloseRef.current;
      openSideRef.current = direction;
      const width = actionsWidthFor(direction);
      const content = contentRef.current;
      if (content) {
        content.style.transition = "transform 180ms ease-out";
        content.style.transform = `translateX(${direction === "end" ? -width : width}px)`;
        content.classList.toggle("bg-sidebar", true);
      }
      if (startLayerRef.current) {
        startLayerRef.current.style.visibility = direction === "start" ? "visible" : "hidden";
      }
      if (endLayerRef.current) {
        endLayerRef.current.style.visibility = direction === "end" ? "visible" : "hidden";
      }
    },
    [actionsWidthFor],
  );

  const handlePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      // Touch-only by design: mouse keeps hover buttons, clicks, and the
      // pinned-row drag sensor untouched. Secondary contacts (a second
      // finger) never steal an in-flight gesture.
      if (event.pointerType === "mouse" || event.button !== 0 || !event.isPrimary) return;
      if ((event.target as HTMLElement).closest("button, a, input, textarea")) return;
      if (openSideRef.current !== null) {
        // The first tap after opening dismisses the actions instead of
        // activating the row underneath them. Stop the press here too, or it
        // bubbles to the sortable row and 6px of movement starts a reorder.
        event.stopPropagation();
        swallowClickRef.current = true;
        close();
        return;
      }
      // Keep dnd-kit's pointer sensor from turning a touch drag into a
      // pinned-row reorder; mouse drags never reach here.
      event.stopPropagation();
      // A press on another row dismisses whichever row is open, like the
      // mobile list — open() alone would leave it up until release.
      activeSwipeableClose?.();
      gestureRef.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        offset: 0,
        decided: false,
        direction: "end",
      };
      event.currentTarget.setPointerCapture?.(event.pointerId);
    },
    [close],
  );

  const cancelGesture = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const gesture = gestureRef.current;
      if (!gesture || event.pointerId !== gesture.pointerId) return;
      gestureRef.current = null;
      if (gesture.decided) {
        close();
      }
    },
    [close],
  );

  const handlePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const gesture = gestureRef.current;
      if (!gesture || event.pointerId !== gesture.pointerId) return;
      const result = updateSwipeGesture(
        gesture,
        event.clientX - gesture.startX,
        event.clientY - gesture.startY,
        { start: actionsWidthFor("start"), end: actionsWidthFor("end") },
        contentRef.current?.offsetWidth ?? 0,
      );
      if (result._tag === "cancel") {
        gestureRef.current = null;
        return;
      }
      gestureRef.current = { ...result.state, pointerId: gesture.pointerId };
      const next = gestureRef.current;
      // Sub-threshold movement reveals nothing: without this guard the
      // end-side layer would go visible on any tap that twitches a pixel.
      if (!next.decided) return;
      const content = contentRef.current;
      if (content) {
        content.style.transition = "none";
        content.style.transform = `translateX(${next.offset}px)`;
        content.classList.toggle("bg-sidebar", next.offset !== 0);
      }
      if (startLayerRef.current) {
        startLayerRef.current.style.visibility = next.direction === "start" ? "visible" : "hidden";
      }
      if (endLayerRef.current) {
        endLayerRef.current.style.visibility = next.direction === "end" ? "visible" : "hidden";
      }
    },
    [actionsWidthFor],
  );

  const handlePointerUp = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const gesture = gestureRef.current;
      if (!gesture || event.pointerId !== gesture.pointerId) return;
      gestureRef.current = null;
      if (!gesture.decided) {
        close();
        return;
      }
      // A completed drag still emits a compatibility click on this element;
      // it must not fall through to the row's activate handler.
      swallowClickRef.current = true;
      const width = actionsWidthFor(gesture.direction);
      const content = contentRef.current;
      const release = resolveSwipeRelease({
        offset: gesture.offset,
        actionsWidth: width,
        contentWidth: content?.offsetWidth ?? 0,
      });
      if (release === "commit") {
        close();
        // Full swipes commit only the direction's primary action: snooze is
        // never triggered by distance, matching the mobile list.
        const action =
          gesture.direction === "end"
            ? props.end[0]?.primary === true
              ? props.end[0]
              : null
            : props.start;
        if (action) {
          action.onPress({ x: event.clientX, y: event.clientY });
          return;
        }
      }
      if (release === "open" || release === "commit") {
        open(gesture.direction);
      } else {
        close();
      }
    },
    [actionsWidthFor, close, open, props.end, props.start],
  );

  // The swallow flag pairs with the click of the gesture that armed it. A new
  // contact always produces pointerdown before its click, so clearing on
  // capture lets a real tap through even when the browser suppressed the
  // drag's compatibility click. The compat click itself carries no new
  // pointerdown — and may land on a revealed action button — so it stays
  // swallowed instead of double-firing the action.
  const handlePointerDownCapture = useCallback(() => {
    swallowClickRef.current = false;
  }, []);

  const handleClickCapture = useCallback((event: ReactMouseEvent) => {
    if (!swallowClickRef.current) return;
    swallowClickRef.current = false;
    event.preventDefault();
    event.stopPropagation();
  }, []);

  const handleActionPress = useCallback(
    (action: ThreadSwipeAction) => (event: ReactMouseEvent<HTMLButtonElement>) => {
      close();
      action.onPress({ x: event.clientX, y: event.clientY });
    },
    [close],
  );

  if (props.start === null && props.end.length === 0) {
    return <>{props.children}</>;
  }

  const renderAction = (action: ThreadSwipeAction) => (
    <button
      key={action.id}
      type="button"
      aria-label={action.label}
      onClick={handleActionPress(action)}
      className={cn(
        "flex h-full w-18 shrink-0 cursor-pointer flex-col items-center justify-center gap-1 text-[11px] font-medium text-white outline-none",
        action.className,
      )}
    >
      {action.icon}
      <span>{action.label}</span>
    </button>
  );

  return (
    <div
      className="relative touch-pan-y overflow-hidden rounded-md"
      onPointerDownCapture={handlePointerDownCapture}
      onClickCapture={handleClickCapture}
    >
      {/* visibility:hidden (set imperatively) keeps the closed layers out of
          both the focus order and the accessibility tree; the layers must not
          carry aria-hidden, which would hide them while open. */}
      <div
        ref={startLayerRef}
        className="absolute inset-y-0 left-0 flex"
        style={{ visibility: "hidden" }}
      >
        {props.start ? renderAction(props.start) : null}
      </div>
      <div
        ref={endLayerRef}
        className="absolute inset-y-0 right-0 flex"
        style={{ visibility: "hidden" }}
      >
        {props.end.map(renderAction)}
      </div>
      <div
        ref={contentRef}
        className="relative"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={cancelGesture}
      >
        {props.children}
      </div>
    </div>
  );
}
