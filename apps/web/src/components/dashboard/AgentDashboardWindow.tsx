import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { AgentDashboard } from "./AgentDashboard";
import { isElectron } from "~/env";
import { installDashboardPopupHost } from "./dashboardPopup";

/** Hosted by the app shell, so opening a conversation does not tear down the board. */
export function AgentDashboardWindow() {
  const [popup, setPopup] = useState<Window | null>(null);
  useEffect(() => {
    if (isElectron) return installDashboardPopupHost(setPopup);
  }, []);
  return popup && !popup.closed
    ? createPortal(<AgentDashboard detached />, popup.document.body)
    : null;
}
