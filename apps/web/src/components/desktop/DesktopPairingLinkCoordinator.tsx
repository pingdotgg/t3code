import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useEffect, useEffectEvent, useRef } from "react";

import { requestConfirmDialog } from "../../confirmDialog";
import { connectPairing } from "../../connection/onboarding";
import { readHostedPairingRequest } from "../../hostedPairing";
import { setActiveEnvironmentId } from "../../state/entities";
import { useAtomCommand } from "../../state/use-atom-command";
import { stackedThreadToast, toastManager } from "../ui/toast";

/**
 * Turns `t3code://pair?host=...&label=...#token=...` deep links, queued by the
 * Electron main process, into saved remote environments. The link is
 * attacker-influenceable input and its token is one-time, so the user confirms
 * the host before the token is exchanged. Links are pulled from the main
 * process rather than pushed, so nothing is lost while the renderer loads.
 */
export function DesktopPairingLinkCoordinator() {
  const pairingLink = window.desktopBridge?.pairingLink;
  const connect = useAtomCommand(connectPairing, { reportFailure: false });
  const queueRef = useRef(Promise.resolve());

  const handleLink = useEffectEvent(async (link: string) => {
    let url: URL;
    try {
      url = new URL(link);
    } catch {
      return;
    }
    const request = readHostedPairingRequest(url);
    if (request === null) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Invalid pairing link",
          description: "This link is missing its backend host or token.",
        }),
      );
      return;
    }

    const name = request.label || request.host;
    const confirmed = await requestConfirmDialog(
      `Add ${name} as a remote environment?\nThis computer will connect to ${request.host} and save the connection for future sessions.`,
    );
    if (confirmed !== true) return;

    const result = await connect({ host: request.host, pairingCode: request.token });
    if (result._tag === "Success") {
      setActiveEnvironmentId(result.value);
      toastManager.add({
        type: "success",
        title: "Environment added",
        description: `${name} is saved and will reconnect on app startup.`,
      });
      return;
    }
    if (isAtomCommandInterrupted(result)) return;
    const error = squashAtomCommandFailure(result);
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: "Could not add environment",
        description: `${
          error instanceof Error ? error.message : "Pairing failed."
        } If the backend accepted this one-time token, request a new pairing link.`,
      }),
    );
  });

  useEffect(() => {
    if (pairingLink === undefined) return;
    // Each link gets its own confirm dialog, one at a time, in arrival order.
    const drain = () => {
      queueRef.current = queueRef.current
        .then(() => pairingLink.takePending())
        .then(async (links) => {
          for (const link of links) await handleLink(link);
        })
        .catch(() => undefined);
    };
    const unsubscribe = pairingLink.onAvailable(drain);
    drain();
    return unsubscribe;
  }, [pairingLink]);

  return null;
}
