import {
  cloneElement,
  createContext,
  use,
  useEffect,
  useId,
  useRef,
  useState,
  type FocusEvent,
  type PointerEvent,
  type ReactElement,
  type ReactNode,
} from "react";
import { flushSync } from "react-dom";

import { useStableCallback } from "~/hooks/useStableCallback";
import { cn } from "~/lib/utils";

import { Tooltip, TooltipPopup, TooltipTrigger, useTooltipScrollTracker } from "./tooltip";

// Base UI's tooltip timing: open after a rest, reopen at once right after another closed.
const OPEN_DELAY_MS = 600;
const REOPEN_WINDOW_MS = 400;
// Time to travel from the trigger into a hoverable popup.
const CLOSE_GRACE_MS = 100;

interface SharedTooltipContent {
  readonly render: () => ReactNode;
  /** Comparable key that changes whenever `render()` output changes while open. */
  readonly contentKey?: unknown;
  readonly side?: "top" | "bottom" | "left" | "right";
  readonly align?: "start" | "center" | "end";
  readonly sideOffset?: number;
  readonly variant?: "default" | "glass" | "code";
  readonly popupClassName?: string;
  readonly disabled?: boolean;
}

interface SharedTooltipState extends SharedTooltipContent {
  readonly anchor: HTMLElement;
  readonly open: boolean;
}

interface SharedTooltipApi {
  show(anchor: HTMLElement, content: SharedTooltipContent, immediate: boolean): void;
  refresh(anchor: HTMLElement, content: SharedTooltipContent): void;
  hide(anchor: HTMLElement): void;
  /** A press closes it at once, as Base UI's closeOnClick does. */
  dismiss(anchor?: HTMLElement): void;
  holdOpen(): void;
}

function setAriaDescribedBy(element: HTMLElement, id: string, present: boolean) {
  const tokens = (element.getAttribute("aria-describedby") ?? "").split(/\s+/).filter(Boolean);
  const next = present
    ? tokens.includes(id)
      ? tokens
      : [...tokens, id]
    : tokens.filter((token) => token !== id);
  if (next.length > 0) element.setAttribute("aria-describedby", next.join(" "));
  else element.removeAttribute("aria-describedby");
}

const SharedTooltipContext = createContext<SharedTooltipApi | null>(null);

/**
 * One tooltip for many triggers: a long message would otherwise mount a Base UI tooltip per
 * link and file chip, and almost none of them are ever hovered.
 */
export function SharedTooltipProvider({
  children,
  openDelayMs = OPEN_DELAY_MS,
  switchDelayMs = 0,
  reopenWindowMs = REOPEN_WINDOW_MS,
  closeGraceMs = CLOSE_GRACE_MS,
}: {
  children: ReactNode;
  openDelayMs?: number;
  switchDelayMs?: number;
  reopenWindowMs?: number;
  closeGraceMs?: number;
}) {
  const popupId = useId();
  const [state, setState] = useState<SharedTooltipState | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef<SharedTooltipState | null>(null);
  const lastClosedAt = useRef<number | null>(null);
  const current = useRef<SharedTooltipState | null>(null);

  const commit = (next: SharedTooltipState | null) => {
    current.current = next;
    setState(next);
  };
  const clearTimer = () => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    pending.current = null;
  };
  const openTooltip = (next: SharedTooltipState) => {
    // A Root that mounts open skips Base UI's mount transition, so the popup would slide in from (0,0).
    if (!current.current) flushSync(() => commit({ ...next, open: false }));
    commit(next);
  };
  const scheduleCloseGrace = () => {
    if (!current.current?.open) return;
    timer.current = setTimeout(() => {
      clearTimer();
      if (current.current?.open) {
        lastClosedAt.current = performance.now();
        commit({ ...current.current, open: false });
      }
    }, closeGraceMs);
  };
  const dismiss = (anchor?: HTMLElement) => {
    if (anchor === undefined) {
      clearTimer();
      lastClosedAt.current = null;
      if (current.current?.open) commit({ ...current.current, open: false });
      return;
    }
    const matchesCurrent = current.current?.anchor === anchor;
    const matchesPending = pending.current?.anchor === anchor;
    if (!matchesCurrent && !matchesPending) return;
    if (matchesPending) {
      clearTimer();
      // If a different anchor is still open, resume close grace so it does not stay stranded.
      if (!matchesCurrent) scheduleCloseGrace();
    }
    if (matchesCurrent) {
      // Preserve a different pending anchor's switch dwell when the previous anchor unmounts or dismisses.
      if (pending.current === null) clearTimer();
      lastClosedAt.current = null;
      if (current.current?.open) commit({ ...current.current, open: false });
    }
  };
  const hide = useStableCallback<Parameters<SharedTooltipApi["hide"]>, void>((anchor) => {
    const matchesCurrent = current.current?.anchor === anchor;
    const matchesPending = pending.current?.anchor === anchor;
    if (!matchesCurrent && !matchesPending) return;
    if (matchesPending) {
      clearTimer();
      scheduleCloseGrace();
      return;
    }
    if (pending.current !== null) return;
    clearTimer();
    scheduleCloseGrace();
  });
  const show = useStableCallback<Parameters<SharedTooltipApi["show"]>, void>(
    (anchor, content, immediate) => {
      if (content.disabled) {
        if (pending.current && pending.current.anchor !== anchor) hide(anchor);
        dismiss(anchor);
        return;
      }
      clearTimer();
      const active = current.current;
      const reopen =
        lastClosedAt.current !== null && performance.now() - lastClosedAt.current < reopenWindowMs;
      const delay = immediate
        ? 0
        : active?.open || reopen
          ? active?.anchor === anchor
            ? 0
            : switchDelayMs
          : openDelayMs;
      const next = { ...content, anchor, open: true };
      if (delay <= 0) {
        openTooltip(next);
        return;
      }
      pending.current = next;
      timer.current = setTimeout(() => {
        const target = pending.current;
        clearTimer();
        if (target?.anchor.isConnected) openTooltip(target);
      }, delay);
    },
  );
  const [api] = useState<SharedTooltipApi>(() => ({
    show,
    refresh(anchor, content) {
      if (content.disabled) {
        dismiss(anchor);
        return;
      }
      if (pending.current?.anchor === anchor) {
        pending.current = { ...content, anchor, open: true };
      }
      const active = current.current;
      if (!active?.open || active.anchor !== anchor) return;
      if (
        active.contentKey === content.contentKey &&
        active.side === content.side &&
        active.align === content.align &&
        active.sideOffset === content.sideOffset &&
        active.variant === content.variant &&
        active.popupClassName === content.popupClassName
      ) {
        return;
      }
      commit({ ...content, anchor, open: true });
    },
    hide,
    dismiss,
    holdOpen() {
      clearTimer();
    },
  }));

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- cancels delayed work when the provider unmounts
  useEffect(() => () => api.holdOpen(), [api]);

  const activeAnchor = state?.open ? state.anchor : null;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- links the active trigger DOM element to the shared tooltip popup via aria-describedby
  useEffect(() => {
    if (!activeAnchor) return;
    setAriaDescribedBy(activeAnchor, popupId, true);
    return () => setAriaDescribedBy(activeAnchor, popupId, false);
  }, [activeAnchor, popupId]);

  return (
    <SharedTooltipContext value={api}>
      {children}
      {state ? (
        <Tooltip
          open={state.open}
          onOpenChange={(open, details) => {
            if (open) return;
            if (details.reason === "escape-key") api.dismiss();
            else api.hide(state.anchor);
          }}
        >
          <TooltipPopup
            id={popupId}
            role="tooltip"
            anchor={state.anchor}
            side={state.side ?? "top"}
            align={state.align ?? "center"}
            sideOffset={state.sideOffset ?? 4}
            variant={state.variant ?? "default"}
            className={cn("pointer-events-auto", state.popupClassName)}
            onMouseEnter={() => api.holdOpen()}
            onMouseLeave={() => api.hide(state.anchor)}
          >
            <SharedTooltipBody render={state.render} />
          </TooltipPopup>
        </Tooltip>
      ) : null}
    </SharedTooltipContext>
  );
}

function SharedTooltipBody({ render }: Pick<SharedTooltipContent, "render">) {
  return render();
}

export interface SharedTooltipTriggerProps {
  onPointerEnter: (event: PointerEvent<HTMLElement>) => void;
  onPointerLeave: (event: PointerEvent<HTMLElement>) => void;
  onFocus: (event: FocusEvent<HTMLElement>) => void;
  onBlur: (event: FocusEvent<HTMLElement>) => void;
  onPointerDown: (event: PointerEvent<HTMLElement>) => void;
}

/** Props that show `content` on the shared tooltip, or null outside a SharedTooltipProvider. */
export function useSharedTooltip(content: SharedTooltipContent): SharedTooltipTriggerProps | null {
  const api = use(SharedTooltipContext);
  const scrollTracker = useTooltipScrollTracker();
  const anchorRef = useRef<HTMLElement | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- refreshes an open shared tooltip when its trigger's label changes
  useEffect(() => {
    if (api && anchorRef.current) api.refresh(anchorRef.current, content);
  }, [api, content]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- releases the anchor and scroll tracking when the trigger unmounts
  useEffect(
    () => () => {
      if (anchorRef.current) api?.dismiss(anchorRef.current);
      scrollTracker?.release(anchorRef);
    },
    [api, scrollTracker],
  );
  if (!api) return null;
  return {
    // Touch never opens it, as Base UI's mouseOnly trigger; taps also send compatibility mouse events.
    onPointerEnter: (event) => {
      if (event.pointerType === "touch") return;
      const trigger = event.currentTarget;
      anchorRef.current = trigger;
      api.show(trigger, content, false);
      // Scrolling the timeline closes it, as it does a TooltipTrigger's.
      if (!content.disabled) scrollTracker?.hover(trigger, anchorRef, () => api.dismiss());
    },
    onPointerLeave: (event) => api.hide(event.currentTarget),
    // Keyboard focus shows it at once, as Base UI does.
    onFocus: (event) => {
      if (event.currentTarget.matches(":focus-visible")) {
        anchorRef.current = event.currentTarget;
        api.show(event.currentTarget, content, true);
      }
    },
    onBlur: (event) => api.hide(event.currentTarget),
    onPointerDown: (event) => api.dismiss(event.currentTarget),
  };
}

type Handlers = Partial<Record<keyof SharedTooltipTriggerProps, (event: never) => void>>;

/** The trigger's own handlers run first, then the shared tooltip's. */
export function withSharedTooltip<Props>(
  element: ReactElement<Props>,
  tooltip: SharedTooltipTriggerProps,
  children?: ReactNode,
): ReactElement {
  const own = element.props as Handlers;
  const merged: Record<string, (event: never) => void> = {};
  for (const key of Object.keys(tooltip) as Array<keyof SharedTooltipTriggerProps>) {
    const shared = tooltip[key] as (event: never) => void;
    const mine = own[key];
    merged[key] = mine
      ? (event) => {
          mine(event);
          shared(event);
        }
      : shared;
  }
  return children === undefined
    ? cloneElement(element, merged as Partial<Props>)
    : cloneElement(element, merged as Partial<Props>, children);
}

/** A tooltip on `render`: the shared one inside a SharedTooltipProvider, Base UI's otherwise. */
export function SharedTooltipTrigger({
  render,
  children,
  label,
  side = "top",
  variant,
}: {
  render: ReactElement;
  children?: ReactNode;
  label: ReactNode;
  side?: SharedTooltipContent["side"];
  variant?: SharedTooltipContent["variant"];
}) {
  const tooltip = useSharedTooltip({
    render: () => label,
    contentKey: label,
    side,
    ...(variant ? { variant } : {}),
  });
  if (tooltip) return withSharedTooltip(render, tooltip, children);
  return (
    <Tooltip>
      <TooltipTrigger render={render}>{children}</TooltipTrigger>
      <TooltipPopup side={side} {...(variant ? { variant } : {})}>
        {label}
      </TooltipPopup>
    </Tooltip>
  );
}
