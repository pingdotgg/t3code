import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { DASHBOARD_LINK_HREF } from "@t3tools/shared/displayModes";

import { ContextChip, ContextChipLabel } from "../../components/ContextChip";
import { hastPlainTextDeep } from "../../components/chat/markdownHast.logic";
import { toastManager } from "../../components/ui/toast";
import { requestWorkspaceFocus } from "../../lib/workspaceFocus";
import {
  rightPanelHostRef,
  selectActiveRightPanel,
  useRightPanelStore,
} from "../../rightPanelStore";
import { FORK_SURFACES, threadHasModeSurface } from "./dashboardSurface";

/** "open" for the Dashboard link, "inert" for any other `t3-dashboard:` link, null otherwise. */
export function parseDashboardHref(href: string | undefined): "open" | "inert" | null {
  if (href === DASHBOARD_LINK_HREF) return "open";
  return href?.startsWith(DASHBOARD_LINK_HREF) ? "inert" : null;
}

/** A Dashboard link's written text, or "Dashboard" when it has none of its own. */
export function dashboardLinkLabel(node: unknown, href: string): string {
  const written = hastPlainTextDeep(node).trim();
  return written === "" || written === href ? "Dashboard" : written;
}

function openThreadDashboard(threadRef: ScopedThreadRef) {
  // A hosted thread's actions open in its host's panel, which shows the host's Dashboard.
  if (scopedThreadKey(rightPanelHostRef(threadRef)) !== scopedThreadKey(threadRef)) {
    toastManager.add({ type: "info", title: "Open this thread on its own to see its Dashboard" });
    return;
  }
  if (!threadHasModeSurface(threadRef, "dashboard")) {
    toastManager.add({ type: "info", title: "This thread's Dashboard is off" });
    return;
  }
  const store = useRightPanelStore.getState();
  const alreadyShown = selectActiveRightPanel(store.byThreadKey, threadRef) === "dashboard";
  store.open(threadRef, "dashboard");
  // Opening an already active tab changes no panel state, so nothing else moves focus there.
  if (alreadyShown) requestWorkspaceFocus({ area: "panel" });
}

/** A chat link to the thread's Dashboard: a chip that opens it, or plain text when it cannot. */
export function DashboardLinkChip(props: {
  readonly threadRef: ScopedThreadRef | undefined;
  readonly node: unknown;
  readonly href: string;
}) {
  const label = dashboardLinkLabel(props.node, props.href);
  const { threadRef } = props;
  if (parseDashboardHref(props.href) !== "open" || threadRef === undefined) return label;
  const Icon = FORK_SURFACES.dashboard.icon;
  return (
    <ContextChip
      render={<button type="button" />}
      aria-label={label === "Dashboard" ? "Open the Dashboard" : `${label}. Open the Dashboard`}
      data-markdown-copy={`[${label.replace(/[\\[\]*_`<>&]/g, "\\$&")}](${DASHBOARD_LINK_HREF})`}
      onClick={() => openThreadDashboard(threadRef)}
    >
      <Icon aria-hidden />
      <ContextChipLabel>{label}</ContextChipLabel>
    </ContextChip>
  );
}
