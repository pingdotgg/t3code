import { useEffect, useRef, useState } from "react";
import { pendingProviderAuthDelivery, clearProviderAuthDelivery } from "../../providerAuthDelivery";
import { serverEnvironment } from "../../state/server";
import { useEnvironments } from "../../state/environments";
import { useAtomCommand } from "../../state/use-atom-command";
import { toastManager } from "../ui/toast";

/** Hosted web receives only the one-time code; the selected environment verifies and stores tokens. */
export function ProviderAuthCallbackCoordinator() {
  const completeAuth = useAtomCommand(serverEnvironment.completeProviderAuth, {
    reportFailure: false,
  });
  const { environments } = useEnvironments();
  const [delivery, setDelivery] = useState(pendingProviderAuthDelivery);
  const started = useRef(false);
  const environmentId = delivery?.environmentId;
  const connected = environments.some(
    (environment) =>
      environment.environmentId === environmentId && environment.connection.phase === "connected",
  );
  useEffect(() => {
    const input = delivery;
    if (!input || started.current || !connected) return;
    started.current = true;
    void completeAuth({
      environmentId: input.environmentId,
      input: { instanceId: input.instanceId, flowId: input.flowId, callbackUrl: input.callbackUrl },
    })
      .then((result) => {
        if (result._tag === "Failure")
          toastManager.add({
            type: "error",
            title: "ChatGPT sign-in couldn't finish",
            description: "Return to the provider and try again.",
          });
      })
      .catch(() =>
        toastManager.add({
          type: "error",
          title: "ChatGPT sign-in couldn't finish",
          description: "Reconnect to the environment and try again.",
        }),
      )
      .finally(() => {
        setDelivery(undefined);
        clearProviderAuthDelivery();
      });
  }, [completeAuth, connected, delivery]);
  return null;
}
