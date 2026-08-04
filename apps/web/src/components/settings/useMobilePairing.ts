import { useCallback, useState } from "react";
import type { DesktopServerExposureState } from "@t3tools/contracts";

import { buildRemotePairingUrl } from "@t3tools/shared/remote";
import { setPairingTokenOnUrl } from "../../pairingUrl";
import {
  createServerPairingCredential,
  type ServerPairingCredentialRecord,
} from "~/environments/primary";

export type MobilePairingDialogState = {
  readonly payload: string;
  readonly endpointUrl: string;
  readonly pairingCredential: ServerPairingCredentialRecord;
};

export function resolveMobilePairingPayload(endpointUrl: string, credential: string): string {
  return buildRemotePairingUrl(endpointUrl, credential);
}

export function resolveCurrentOriginPairingUrl(credential: string): string {
  const url = new URL("/pair", window.location.href);
  return setPairingTokenOnUrl(url, credential).toString();
}

export function useMobilePairing({
  canManageLocalBackend,
  desktopBridge,
  desktopServerExposureMode,
  localBackendEndpointUrl,
  onDesktopServerExposureState,
}: {
  readonly canManageLocalBackend: boolean;
  readonly desktopBridge: Window["desktopBridge"];
  readonly desktopServerExposureMode: DesktopServerExposureState["mode"] | null | undefined;
  readonly localBackendEndpointUrl: string | null | undefined;
  readonly onDesktopServerExposureState: (state: DesktopServerExposureState) => void;
}) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogState, setDialogState] = useState<MobilePairingDialogState | null>(null);
  const [isCreating, setIsCreating] = useState(false);

  const createMobilePairing = useCallback(async () => {
    if (!canManageLocalBackend) return null;

    setIsCreating(true);
    try {
      let endpointUrl = localBackendEndpointUrl;
      if (desktopBridge && (!endpointUrl || desktopServerExposureMode !== "network-accessible")) {
        const nextState = await desktopBridge.setServerExposureMode("network-accessible");
        onDesktopServerExposureState(nextState);
        endpointUrl = nextState.endpointUrl;
      }

      if (!endpointUrl) {
        throw new Error(
          desktopBridge
            ? "T3 Code could not find a LAN address for this Mac. Connect to Wi-Fi or Tailscale and try again."
            : "This backend is not reachable from other devices. Restart it with a non-loopback host before pairing mobile.",
        );
      }

      const issued = await createServerPairingCredential("T3 Mobile");
      const nextDialogState = {
        endpointUrl,
        pairingCredential: issued,
        payload: resolveMobilePairingPayload(endpointUrl, issued.credential),
      };
      setDialogState(nextDialogState);
      setDialogOpen(true);
      return nextDialogState;
    } finally {
      setIsCreating(false);
    }
  }, [
    canManageLocalBackend,
    desktopBridge,
    desktopServerExposureMode,
    localBackendEndpointUrl,
    onDesktopServerExposureState,
  ]);

  return {
    createMobilePairing,
    dialogOpen,
    dialogState,
    isCreating,
    setDialogOpen,
  };
}
