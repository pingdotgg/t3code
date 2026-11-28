import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { DesktopAppActivationRequest } from "@t3tools/contracts";
import { msg } from "gt-react";
import { useEffect, useEffectEvent, useRef, useState } from "react";

import { connectPairing } from "../../connection/onboarding";
import { handleDesktopAppPairRequest } from "../../desktopAppActivation";
import { useOpenLocalWorkspace } from "../../hooks/useOpenLocalWorkspace";
import { m } from "../../i18n/messages";
import { isLocalEnvironmentDisabled } from "../../localEnvironment";
import { readEnvironmentIds } from "../../state/environments";
import { useAtomCommand } from "../../state/use-atom-command";
import { toastManager } from "../ui/toast";

export function DesktopAppActivationCoordinator() {
  const openLocalWorkspace = useOpenLocalWorkspace();
  const connectPairingEnvironment = useAtomCommand(connectPairing, { reportFailure: false });
  const [localEnvironmentDisabled] = useState(isLocalEnvironmentDisabled);
  const queueRef = useRef(Promise.resolve());
  const activation = window.desktopBridge?.appActivation;
  // With Local environment disabled nothing opens a workspace, but `t3 app --pair` still works.
  const ready = activation !== undefined && (openLocalWorkspace.ready || localEnvironmentDisabled);

  const pairEnvironment = async (pairingUrl: string) => {
    const result = await connectPairingEnvironment({ pairingUrl });
    if (result._tag === "Failure") {
      const error = squashAtomCommandFailure(result);
      throw error instanceof Error ? error : new Error("T3 Code could not add the backend.");
    }
    return result.value;
  };

  const processRequest = useEffectEvent(async (request: DesktopAppActivationRequest) => {
    if (request.type === "open-workspace") return openLocalWorkspace.open(request);
    const response = await handleDesktopAppPairRequest(request, {
      savedEnvironmentIds: readEnvironmentIds,
      pair: pairEnvironment,
    });
    if (response.ok) {
      toastManager.add({
        type: "success",
        title: m(msg("Backend added")),
        description: m(msg("The environment is saved and will reconnect on app startup.")),
      });
    }
    return response;
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes to desktop activation requests over the bridge and marks the renderer ready
  useEffect(() => {
    if (!ready || activation === undefined) return;

    let subscribed = true;
    const unsubscribe = activation.onRequest((request) => {
      queueRef.current = queueRef.current.then(async () => {
        const response = await processRequest(request);
        await activation.complete(response);
      });
      queueRef.current = queueRef.current.catch(() => undefined);
    });
    // Skip readiness if React runs cleanup before this subscription can receive requests.
    queueMicrotask(() => {
      if (subscribed) void activation.setReady(true).catch(() => undefined);
    });
    return () => {
      subscribed = false;
      void activation.setReady(false).catch(() => undefined);
      unsubscribe();
    };
  }, [activation, ready]);

  return null;
}
