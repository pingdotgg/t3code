import { useEffect } from "react";

import { useClientLayoutSettings, useScrollingWorkspacesEnabled } from "../hooks/useSettings";
import { useLayoutBehaviorStore, type LayoutBehavior } from "./layoutBehavior";
import { useLayoutStore } from "./layoutStore";
import { layoutTemplateCompanionShares } from "./layoutTemplate";

/** Publish this client's layout defaults to pane, tab and shortcut readers. */
export function useSyncLayoutBehavior(): void {
  const layout = useClientLayoutSettings();
  const scrollingWorkspaces = useScrollingWorkspacesEnabled();
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Publish hydrated client preferences for imperative layout commands outside React.
  useEffect(() => {
    const current = useLayoutBehaviorStore.getState().behavior;
    const shares = layoutTemplateCompanionShares(layout.template);
    const next: LayoutBehavior = {
      terminalPlacement: layout.terminalPlacement,
      sidePanePlacement: layout.sidePanePlacement,
      sidePaneOpensOn: layout.sidePaneOpensOn,
      newTabPosition: layout.newTabPosition,
      whenNoRoom: scrollingWorkspaces ? layout.whenNoRoom : "always-shrink",
      scrollingWorkspaces,
      companionShares:
        shares.panel === current.companionShares.panel &&
        shares.terminal === current.companionShares.terminal
          ? current.companionShares
          : shares,
    };
    const changed = (Object.keys(next) as Array<keyof LayoutBehavior>).some(
      (key) => next[key] !== current[key],
    );
    if (changed) useLayoutBehaviorStore.setState({ behavior: next });
    // The overview is a niri part; turning the toggle off closes one that is open.
    if (!scrollingWorkspaces) useLayoutStore.getState().setOverviewOpen(false);
  }, [layout, scrollingWorkspaces]);
}
