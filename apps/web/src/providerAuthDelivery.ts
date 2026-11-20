import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import { readCodexAuthDelivery } from "@t3tools/shared/codexAuthHandoff";
import * as Effect from "effect/Effect";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { msg } from "gt-react";

import { toastManager } from "./components/ui/toast";
import { entriesAfterPlatformDiscoveryAtom } from "./connection/catalog";
import { m } from "./i18n/messages";
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

  void completeProviderAuth(delivery);
}

async function completeProviderAuth(delivery: ProviderAuthDelivery): Promise<void> {
  const presentationAtom = environmentPresentations.presentationAtom(delivery.environmentId);
  const destinationAtom = Atom.make((get) => {
    const presentation = get(presentationAtom);
    if (presentation === null) {
      return AsyncResult.flatMap(get(entriesAfterPlatformDiscoveryAtom), (entries) =>
        entries === null || entries.has(delivery.environmentId)
          ? AsyncResult.initial()
          : AsyncResult.success("missing"),
      );
    }
    return presentation.connection.phase === "connected"
      ? AsyncResult.success("connected")
      : AsyncResult.initial();
  });

  try {
    const destination = await Effect.runPromise(
      AtomRegistry.getResult(appAtomRegistry, destinationAtom),
    );
    if (destination === "missing") {
      reportUnavailableEnvironment();
      return;
    }
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
        title: m(msg("ChatGPT sign-in couldn't finish")),
        description: m(msg("Return to the provider and try again.")),
      });
    }
  } catch {
    reportUnavailableEnvironment();
  }
}

function reportUnavailableEnvironment(): void {
  toastManager.add({
    type: "error",
    title: m(msg("ChatGPT sign-in couldn't finish")),
    description: m(msg("Reconnect to the environment and try again.")),
  });
}
