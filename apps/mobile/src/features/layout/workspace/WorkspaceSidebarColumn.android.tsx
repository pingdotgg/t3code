import type { ReactNode } from "react";

/** Android draws the sidebar's bar in-tree, so the column needs no stack of its own. */
export function WorkspaceSidebarColumn(props: {
  readonly width: number;
  readonly children: ReactNode;
}) {
  return <>{props.children}</>;
}
