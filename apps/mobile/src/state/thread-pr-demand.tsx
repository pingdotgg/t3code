import { createContext, type ReactNode } from "react";

import { useAppActive } from "../lib/appState";

export const ThreadPrDemandContext = createContext(true);

export function ThreadPrDemandProvider(props: {
  readonly visible: boolean;
  readonly children: ReactNode;
}) {
  const active = useAppActive();
  // A sidebar can stay visible beside a focused detail route, so route focus cannot gate its reads.
  return (
    <ThreadPrDemandContext value={props.visible && active}>{props.children}</ThreadPrDemandContext>
  );
}
