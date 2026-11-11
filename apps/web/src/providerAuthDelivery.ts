import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import { readCodexAuthDelivery } from "@t3tools/shared/codexAuthHandoff";

import { toastManager } from "./components/ui/toast";
import { appAtomRegistry } from "./rpc/atomRegistry";
import { environmentPresentations } from "./state/presentation";
import { serverEnvironment } from "./state/server";

type ProviderAuthDelivery = NonNullable<ReturnType<typeof readCodexAuthDelivery>>;

/**
 * Remove the code before the router, tracing, or welcome screen sees the incoming address,
 * then hand it to its environment once that environment connects. Hosted web receives only
 * the one-time code; the selected environment verifies and stores tokens.
 */
export function startProviderAuthDelivery(): void {
  if (!window.location.hash.startsWith("#codex-auth=")) return;
  const delivery = readCodexAuthDelivery(window.location.href);
  window.history.replaceState(
    window.history.state,
    "",
    delivery?.returnUrl ?? `${window.location.pathname}${window.location.search}`,
  );
  if (!delivery) return;

  const presentationAtom = environmentPresentations.presentationAtom(delivery.environmentId);
  if (appAtomRegistry.get(presentationAtom)?.connection.phase === "connected") {
    void completeProviderAuth(delivery);
    return;
  }
  const unsubscribe = appAtomRegistry.subscribe(presentationAtom, (presentation) => {
    if (presentation?.connection.phase !== "connected") return;
    unsubscribe();
    void completeProviderAuth(delivery);
  });
}

async function completeProviderAuth(delivery: ProviderAuthDelivery): Promise<void> {
  try {
    const result = await runAtomCommand(
      appAtomRegistry,
      serverEnvironment.completeProviderAuth,
      {
        environmentId: delivery.environmentId,
        input: {
          instanceId: delivery.instanceId,
          flowId: delivery.flowId,
          callbackUrl: delivery.callbackUrl,
        },
      },
      { reportFailure: false },
    );
    if (result._tag === "Failure") {
      toastManager.add({
        type: "error",
        title: "ChatGPT sign-in couldn't finish",
        description: "Return to the provider and try again.",
      });
    }
  } catch {
    toastManager.add({
      type: "error",
      title: "ChatGPT sign-in couldn't finish",
      description: "Reconnect to the environment and try again.",
    });
  }
}
