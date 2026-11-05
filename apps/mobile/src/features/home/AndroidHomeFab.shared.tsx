import type { ReactNode } from "react";

export function AndroidHomeFabLayout(props: {
  readonly onStartNewTask: () => void;
  readonly children: ReactNode;
  readonly sidebar?: boolean;
  readonly disabled?: boolean;
  readonly paneWidth?: number;
}) {
  return <>{props.children}</>;
}

/**
 * The filter button stacks on the New thread FAB from this same origin so the two
 * cannot drift apart. In dp rather than a rem class so Material's 16dp margin does
 * not grow with the app's text size.
 */
export function androidHomeFabPosition(safeAreaBottom: number, sidebar: boolean | undefined) {
  return {
    right: 16,
    bottom: sidebar ? Math.max(safeAreaBottom, 12) + 6 : safeAreaBottom + 16,
  };
}
