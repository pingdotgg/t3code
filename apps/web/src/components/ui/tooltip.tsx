import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip";
import {
  type ReactNode,
  createContext,
  use,
  useEffect,
  useMemo,
  useRef,
  type RefObject,
} from "react";

import { cn } from "~/lib/utils";

const TooltipCreateHandle = TooltipPrimitive.createHandle;

const TooltipProvider = TooltipPrimitive.Provider;

/**
 * Tooltips rendered inside this scope close when the scope owner reports a
 * user scroll gesture (via useTooltipScrollDismiss). Used around the chat
 * timeline: its tooltips portal above other surfaces (like the composer), so
 * one left open after its trigger scrolls out from under a stationary pointer
 * would paint over them. Programmatic scrolls — streaming auto-follow,
 * minimap jumps — never dismiss anything because only real input gestures
 * trigger the dismissal. Keyboard-opened tooltips are exempt so keyboard
 * users keep them until focus moves.
 */
interface TooltipScrollDismiss {
  register: (close: () => void) => () => void;
  dismissAll: () => void;
}

const TooltipScrollDismissContext = createContext<TooltipScrollDismiss | null>(null);

function TooltipScrollDismissScope({ children }: { children: ReactNode }) {
  const closeCallbacks = useRef(new Set<() => void>());
  const dismiss = useMemo<TooltipScrollDismiss>(
    () => ({
      register: (close) => {
        closeCallbacks.current.add(close);
        return () => {
          closeCallbacks.current.delete(close);
        };
      },
      dismissAll: () => {
        // Set iteration tolerates deletion of the in-flight entry, which is
        // all a close callback ever does to the set.
        for (const close of closeCallbacks.current) {
          close();
        }
      },
    }),
    [],
  );
  return <TooltipScrollDismissContext value={dismiss}>{children}</TooltipScrollDismissContext>;
}

/** Dismisses every hover-opened tooltip under the nearest scope. Null outside one. */
export function useTooltipScrollDismiss(): (() => void) | null {
  const dismiss = use(TooltipScrollDismissContext);
  return dismiss?.dismissAll ?? null;
}

function Tooltip(props: TooltipPrimitive.Root.Props) {
  const { actionsRef: consumerActionsRef, onOpenChange, ...rootProps } = props;
  const scrollDismiss = use(TooltipScrollDismissContext);
  const actionsRef = useRef<TooltipPrimitive.Root.Actions>(null);
  const registeredCloseRef = useRef<(() => void) | null>(null);
  const consumerActionsRefMirror = useRef(consumerActionsRef);
  consumerActionsRefMirror.current = consumerActionsRef;

  useEffect(
    () => () => {
      registeredCloseRef.current?.();
    },
    [],
  );

  // Write through to a consumer-supplied actionsRef instead of dropping it.
  const mergedActionsRef = useMemo<RefObject<TooltipPrimitive.Root.Actions | null>>(
    () => ({
      get current() {
        return actionsRef.current;
      },
      set current(actions) {
        actionsRef.current = actions;
        const ref = consumerActionsRefMirror.current;
        if (ref) {
          ref.current = actions;
        }
      },
    }),
    [],
  );

  const handleOpenChange = (open: boolean, details: TooltipPrimitive.Root.ChangeEventDetails) => {
    onOpenChange?.(open, details);
    registeredCloseRef.current?.();
    registeredCloseRef.current = null;
    if (!scrollDismiss || !open || details.reason !== "trigger-hover") {
      return;
    }
    const close = () => actionsRef.current?.close();
    registeredCloseRef.current = scrollDismiss.register(close);
  };

  return (
    <TooltipPrimitive.Root
      {...rootProps}
      actionsRef={mergedActionsRef}
      onOpenChange={handleOpenChange}
    />
  );
}

function TooltipTrigger(props: TooltipPrimitive.Trigger.Props) {
  return <TooltipPrimitive.Trigger data-slot="tooltip-trigger" {...props} />;
}

function TooltipPopup({
  className,
  align = "center",
  sideOffset = 4,
  side = "top",
  variant = "default",
  anchor,
  children,
  ...props
}: TooltipPrimitive.Popup.Props & {
  align?: TooltipPrimitive.Positioner.Props["align"];
  side?: TooltipPrimitive.Positioner.Props["side"];
  sideOffset?: TooltipPrimitive.Positioner.Props["sideOffset"];
  variant?: "default" | "glass";
  anchor?: TooltipPrimitive.Positioner.Props["anchor"];
}) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Positioner
        align={align}
        anchor={anchor}
        className="pointer-events-none z-[140] h-(--positioner-height) w-(--positioner-width) max-w-(--available-width) transition-[top,left,right,bottom,transform] data-instant:transition-none"
        data-slot="tooltip-positioner"
        side={side}
        sideOffset={sideOffset}
      >
        <TooltipPrimitive.Popup
          className={cn(
            "relative flex h-(--popup-height,auto) w-(--popup-width,auto) origin-(--transform-origin) text-balance rounded-md text-popover-foreground text-xs transition-[width,height,scale,opacity] before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--radius-md)-1px)] before:shadow-[0_1px_--theme(--color-black/4%)] data-ending-style:scale-98 data-starting-style:scale-98 data-ending-style:opacity-0 data-starting-style:opacity-0 data-instant:duration-0 dark:before:shadow-[0_-1px_--theme(--color-white/6%)]",
            variant === "glass"
              ? "dropdown-glass shadow-xl shadow-black/25 before:hidden"
              : "border bg-popover not-dark:bg-clip-padding shadow-md/5",
            className,
          )}
          data-slot="tooltip-popup"
          {...props}
        >
          <TooltipPrimitive.Viewport
            className="relative size-full overflow-clip px-(--viewport-inline-padding) py-1 [--viewport-inline-padding:--spacing(2)] data-instant:transition-none **:data-current:data-ending-style:opacity-0 **:data-current:data-starting-style:opacity-0 **:data-previous:data-ending-style:opacity-0 **:data-previous:data-starting-style:opacity-0 **:data-current:w-[calc(var(--popup-width)-2*var(--viewport-inline-padding)-2px)] **:data-previous:w-[calc(var(--popup-width)-2*var(--viewport-inline-padding)-2px)] **:data-previous:truncate **:data-current:opacity-100 **:data-previous:opacity-100 **:data-current:transition-opacity **:data-previous:transition-opacity"
            data-slot="tooltip-viewport"
          >
            {children}
          </TooltipPrimitive.Viewport>
        </TooltipPrimitive.Popup>
      </TooltipPrimitive.Positioner>
    </TooltipPrimitive.Portal>
  );
}

export {
  TooltipCreateHandle,
  TooltipProvider,
  TooltipScrollDismissScope,
  Tooltip,
  TooltipTrigger,
  TooltipPopup,
};
