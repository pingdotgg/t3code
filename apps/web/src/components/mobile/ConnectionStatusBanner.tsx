import { AlertCircleIcon, WifiOffIcon } from "lucide-react";

import { getWsConnectionUiState, useWsConnectionStatus } from "~/rpc/wsConnectionState";
import { Spinner } from "~/components/ui/spinner";

export function ConnectionStatusBanner() {
  const status = useWsConnectionStatus();
  const uiState = getWsConnectionUiState(status);

  if (uiState === "connected") return null;

  const isOffline = uiState === "offline";

  return (
    <div
      role="status"
      aria-live="polite"
      className={
        "fixed top-0 inset-x-0 z-30 md:hidden flex items-center gap-2 px-4 py-2 text-xs border-b pt-[env(safe-area-inset-top)] " +
        (isOffline
          ? "bg-warning/10 border-warning/20 text-warning-foreground"
          : "bg-destructive/10 border-destructive/20 text-destructive-foreground")
      }
    >
      {isOffline ? (
        <>
          <WifiOffIcon className="size-3.5 shrink-0" />
          No internet
        </>
      ) : uiState === "reconnecting" ? (
        <>
          <Spinner className="size-3.5 shrink-0" />
          Reconnecting…
        </>
      ) : (
        <>
          <AlertCircleIcon className="size-3.5 shrink-0" />
          Connection lost
        </>
      )}
    </div>
  );
}
