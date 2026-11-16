import {
  cloneElement,
  createContext,
  use,
  useRef,
  useState,
  type FocusEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactElement,
  type ReactNode,
} from "react";

import { Tooltip, TooltipPopup, TooltipTrigger } from "./tooltip";

// Base UI's tooltip timing: open after a rest, reopen at once right after another closed.
const OPEN_DELAY_MS = 600;
const REOPEN_WINDOW_MS = 400;
// Time to travel from the trigger into a hoverable popup.
const CLOSE_GRACE_MS = 100;

interface SharedTooltipContent {
  readonly render: () => ReactNode;
  readonly side?: "top" | "bottom" | "left" | "right";
  readonly variant?: "default" | "glass" | "code";
}

interface SharedTooltipState extends SharedTooltipContent {
  readonly anchor: HTMLElement;
  readonly open: boolean;
}

interface SharedTooltipApi {
  show(anchor: HTMLElement, content: SharedTooltipContent, immediate: boolean): void;
  hide(anchor: HTMLElement): void;
  /** A press closes it at once, as Base UI's closeOnClick does. */
  dismiss(anchor: HTMLElement): void;
  holdOpen(): void;
}

const SharedTooltipContext = createContext<SharedTooltipApi | null>(null);

/**
 * One tooltip for many triggers: a long message would otherwise mount a Base UI tooltip per
 * link and file chip, and almost none of them are ever hovered.
 */
export function SharedTooltipProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<SharedTooltipState | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastClosedAt = useRef(0);
  const current = useRef<SharedTooltipState | null>(null);

  const commit = (next: SharedTooltipState | null) => {
    current.current = next;
    setState(next);
  };
  const clearTimer = () => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  };
  const [api] = useState<SharedTooltipApi>(() => ({
    show(anchor, content, immediate) {
      clearTimer();
      const open = current.current?.open === true;
      const reopen = performance.now() - lastClosedAt.current < REOPEN_WINDOW_MS;
      if (immediate || open || reopen) {
        commit({ ...content, anchor, open: true });
        return;
      }
      timer.current = setTimeout(() => commit({ ...content, anchor, open: true }), OPEN_DELAY_MS);
    },
    hide(anchor) {
      if (current.current && current.current.anchor !== anchor) {
        clearTimer();
        return;
      }
      clearTimer();
      timer.current = setTimeout(() => {
        if (current.current?.open) lastClosedAt.current = performance.now();
        if (current.current) commit({ ...current.current, open: false });
      }, CLOSE_GRACE_MS);
    },
    dismiss(anchor) {
      clearTimer();
      if (current.current?.anchor !== anchor) return;
      if (current.current.open) lastClosedAt.current = 0;
      commit({ ...current.current, open: false });
    },
    holdOpen() {
      clearTimer();
    },
  }));

  return (
    <SharedTooltipContext value={api}>
      {children}
      {state ? (
        <Tooltip
          open={state.open}
          onOpenChange={(open) => {
            if (!open) api.hide(state.anchor);
          }}
        >
          <TooltipPopup
            anchor={state.anchor}
            side={state.side ?? "top"}
            variant={state.variant ?? "default"}
            onMouseEnter={() => api.holdOpen()}
            onMouseLeave={() => api.hide(state.anchor)}
          >
            {state.render()}
          </TooltipPopup>
        </Tooltip>
      ) : null}
    </SharedTooltipContext>
  );
}

export interface SharedTooltipTriggerProps {
  onMouseEnter: (event: MouseEvent<HTMLElement>) => void;
  onMouseLeave: (event: MouseEvent<HTMLElement>) => void;
  onFocus: (event: FocusEvent<HTMLElement>) => void;
  onBlur: (event: FocusEvent<HTMLElement>) => void;
  onPointerDown: (event: PointerEvent<HTMLElement>) => void;
}

/** Props that show `content` on the shared tooltip, or null outside a SharedTooltipProvider. */
export function useSharedTooltip(content: SharedTooltipContent): SharedTooltipTriggerProps | null {
  const api = use(SharedTooltipContext);
  if (!api) return null;
  return {
    onMouseEnter: (event) => api.show(event.currentTarget, content, false),
    onMouseLeave: (event) => api.hide(event.currentTarget),
    // Keyboard focus shows it at once, as Base UI does.
    onFocus: (event) => {
      if (event.currentTarget.matches(":focus-visible"))
        api.show(event.currentTarget, content, true);
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
  const tooltip = useSharedTooltip({ render: () => label, side, ...(variant ? { variant } : {}) });
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
