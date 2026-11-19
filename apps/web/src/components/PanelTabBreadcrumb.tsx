import { createContext, useContext, useLayoutEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

/** Header action slots shared by terminal and side chat surfaces. */
export interface PanelTabSlots {
  readonly breadcrumb: HTMLElement | null;
  readonly actions: HTMLElement | null;
  readonly registerActions: () => () => void;
}

export const PanelTabSlotsContext = createContext<PanelTabSlots | null>(null);

/**
 * Whether the surface renders inside a panel tab bar, which then carries its
 * actions. A surface drops its own header row when it does.
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
 * Surface actions render at the end of the tab row, or in place outside it.
 */
export function PanelTabActions({ children }: { children: ReactNode }) {
  const registerActions = useContext(PanelTabSlotsContext)?.registerActions;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Tell the tab bar before paint, so its actions notch never draws empty.
  useLayoutEffect(() => registerActions?.(), [registerActions]);
  return <PanelTabPortal slot="actions">{children}</PanelTabPortal>;
}
