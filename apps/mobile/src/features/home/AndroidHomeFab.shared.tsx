import type { ReactNode } from "react";

export function AndroidHomeFabLayout(props: {
  readonly onStartNewTask: () => void;
  readonly children: ReactNode;
  readonly sidebar?: boolean;
  readonly disabled?: boolean;
}) {
  return <>{props.children}</>;
}
