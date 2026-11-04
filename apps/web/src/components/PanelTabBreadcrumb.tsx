import { ChevronRightIcon } from "lucide-react";
import { createContext, useContext, useLayoutEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

/**
 * Where the active panel tab hosts its surface's header (pen JiaZk): the
 * breadcrumb after the tab's title and the actions at the row's end.
 * RightPanelTabs provides it; the elements are null until the row mounts.
 */
export interface PanelTabSlots {
  readonly breadcrumb: HTMLElement | null;
  readonly actions: HTMLElement | null;
  readonly registerActions: () => () => void;
}

export const PanelTabSlotsContext = createContext<PanelTabSlots | null>(null);

/**
 * Whether the surface renders inside a panel tab bar, which then carries its
 * breadcrumb and actions. A surface drops its own header row when it does.
 */
export function useInPanelTabBar(): boolean {
  return useContext(PanelTabSlotsContext) !== null;
}

export function usePanelTabActionsHost(): {
  hasActions: boolean;
  registerActions: () => () => void;
} {
  const [count, setCount] = useState(0);
  const registerActions = () => {
    setCount((current) => current + 1);
    return () => setCount((current) => current - 1);
  };
  return { hasActions: count > 0, registerActions };
}

function PanelTabPortal({
  slot,
  children,
}: {
  slot: "breadcrumb" | "actions";
  children: ReactNode;
}) {
  const slots = useContext(PanelTabSlotsContext);
  if (!slots) return children;
  const element = slots[slot];
  return element ? createPortal(children, element) : null;
}

/**
 * A surface's breadcrumb, shown in its tab after the title (pen JiaZk:
 * "Diff › Latest turn"). Outside a panel tab bar it renders in place.
 */
export function PanelTabBreadcrumb({ children }: { children: ReactNode }) {
  if (!useInPanelTabBar()) return children;
  return (
    <PanelTabPortal slot="breadcrumb">
      <ChevronRightIcon aria-hidden className="size-3 shrink-0 text-dim-foreground" />
      {children}
    </PanelTabPortal>
  );
}

/**
 * A surface's header actions, shown at the end of the panel tab row (pen
 * JiaZk: collapse, layout, wrap, whitespace, file tree). Outside a panel tab
 * bar they render in place.
 */
export function PanelTabActions({ children }: { children: ReactNode }) {
  const registerActions = useContext(PanelTabSlotsContext)?.registerActions;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Tell the tab bar before paint, so its actions notch never draws empty.
  useLayoutEffect(() => registerActions?.(), [registerActions]);
  return <PanelTabPortal slot="actions">{children}</PanelTabPortal>;
}
