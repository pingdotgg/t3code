import { TAILNET_SIGN_IN_PORT } from "@t3tools/client-runtime/connection";
import { type DesktopServerExposureState, TAILNET_APP_CAPABILITY } from "@t3tools/contracts";
import { useState } from "react";

import { requestConfirmDialog } from "~/confirmDialog";
import { refreshDesktopNetworkAccessState } from "~/state/desktopNetworkAccess";
import { Switch } from "../ui/switch";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

/**
 * The desktop switch that lets this user's own Tailscale devices connect with no
 * code. The WSL backend never gets sign-in, so WSL only mode turns it off.
 */
export function TailscaleSignInRow({
  state,
  wslOnly,
}: {
  readonly state: DesktopServerExposureState | null;
  readonly wslOnly: boolean;
}) {
  const [isUpdating, setIsUpdating] = useState(false);
  const enabled = state?.tailscaleSignInEnabled === true && !wslOnly;
  const port = state?.port;
  const movedPort = enabled && port !== undefined && port !== TAILNET_SIGN_IN_PORT;

  const handleChange = async (next: boolean) => {
    const bridge = window.desktopBridge;
    if (!bridge) return;
    const confirmed = await requestConfirmDialog(
      next
        ? `Turn on Tailscale sign-in?\nYour own untagged Tailscale devices get full access with no pairing code. Once your tailnet policy grants ${TAILNET_APP_CAPABILITY} here, only the devices it grants get in. ${
            state?.mode === "network-accessible"
              ? ""
              : "T3 Code accepts tailnet connections and refuses LAN connections. "
          }T3 Code will restart.`
        : "Turn off Tailscale sign-in?\nDevices that signed in through Tailscale disconnect. T3 Code will restart.",
    );
    if (confirmed !== true) return;
    setIsUpdating(true);
    try {
      await bridge.setTailscaleSignInEnabled(next);
      refreshDesktopNetworkAccessState();
    } catch (error) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not change Tailscale sign-in",
          description: error instanceof Error ? error.message : "The setting was not saved.",
        }),
      );
    }
    setIsUpdating(false);
  };

  return (
    <SettingsRow
      title={searchableSetting("tailscale-sign-in").title}
      description={
        wslOnly
          ? "Not available while WSL only is on. Turn off WSL only to use it."
          : enabled
            ? "Your own Tailscale devices connect with no pairing code."
            : "Let your own Tailscale devices connect with no pairing code."
      }
      status={
        movedPort ? (
          <span className="block text-destructive">
            Port {TAILNET_SIGN_IN_PORT} is in use, so T3 Code runs on {port}. Other devices do not
            find it on their own; add it by name with :{port}.
          </span>
        ) : null
      }
      control={
        <Switch
          checked={enabled}
          disabled={isUpdating || state === null || wslOnly}
          onCheckedChange={(checked) => void handleChange(checked)}
          aria-label="Enable Tailscale sign-in"
        />
      }
    />
  );
}
