import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { InstallLandingCard } from "../components/mobile/InstallLandingCard";
import { consumePendingPairingToken, peekPendingPairingToken } from "../pendingPairingToken";

export const Route = createFileRoute("/m")({
  component: MobileBootstrapRouteView,
});

function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  if (window.matchMedia?.("(display-mode: standalone)").matches) return true;
  const nav = navigator as Navigator & { standalone?: boolean };
  return nav.standalone === true;
}

function MobileBootstrapRouteView() {
  const navigate = useNavigate();
  const [hasToken, setHasToken] = useState(() => peekPendingPairingToken() !== null);

  useEffect(() => {
    if (!isStandalone()) return;
    const token = consumePendingPairingToken();
    if (!token) {
      void navigate({ to: "/", replace: true });
      return;
    }
    void navigate({ to: "/pair", search: { token }, replace: true });
  }, [navigate]);

  useEffect(() => {
    setHasToken(peekPendingPairingToken() !== null);
  }, []);

  const handleTryOpenApp = () => {
    window.location.assign("/");
  };

  return (
    <div className="min-h-dvh bg-background">
      <InstallLandingCard hasToken={hasToken} onTryOpenApp={handleTryOpenApp} />
    </div>
  );
}
