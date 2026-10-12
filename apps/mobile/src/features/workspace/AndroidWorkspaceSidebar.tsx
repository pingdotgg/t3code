import type { ReactNode } from "react";

export function AndroidWorkspaceSidebar(props: {
  readonly children: ReactNode;
  readonly onRequestVisibility: () => void;
}) {
  return props.children;
}
