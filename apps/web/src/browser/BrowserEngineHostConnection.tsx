"use client";

import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";
import { useMemo } from "react";

import { previewBridge } from "~/components/preview/previewBridge";
import { subscribeClientSettings } from "~/hooks/useSettings";
import { readLocalApi } from "~/localApi";
import { primaryEnvironmentIdAtom } from "~/state/primaryEnvironment";
import { previewEnvironment } from "~/state/preview";
import { useAtomCommand } from "~/state/use-atom-command";

import { resolveBrowserDefaults } from "./browserDefaults";
import {
  createEngineHostEventHandler,
  publishHostProfiles,
  useBrowserEngineHostStore,
} from "./browserEngineHost";

/** Profiles as the settings list shows them, read once client settings have loaded. */
const hostProfiles = async () => {
  const defaults = await resolveBrowserDefaults();
  return { profiles: defaults.profiles, defaultProfileId: defaults.profileId };
};

/** The in-app confirmation dialog; no dialog host (or no local API) reads as refused. */
const hostConfirm = async (message: string, signal: AbortSignal) =>
  (await readLocalApi()
    ?.dialogs.confirm(message, { signal })
    .catch(() => false)) ?? false;

/**
 * Registers this desktop window as the engine host of the desktop's own
 * environment. Only that environment's server accepts the registration: it
 * is the one reached through the desktop bootstrap session. Remote
 * environments are never asked, so they keep `desktop-required`.
 */
export function BrowserEngineHostConnection() {
  const environmentId = useAtomValue(primaryEnvironmentIdAtom);
  if (!previewBridge || environmentId === null) return null;
  return <BrowserEngineHostConnectionInner key={environmentId} environmentId={environmentId} />;
}

function BrowserEngineHostConnectionInner(props: { readonly environmentId: EnvironmentId }) {
  const { environmentId } = props;
  const commandResult = useAtomCommand(previewEnvironment.engineHostCommandResult, {
    reportFailure: false,
  });
  const sendProfiles = useAtomCommand(previewEnvironment.engineHostProfiles, {
    reportFailure: false,
  });
  const consumerAtom = useMemo(() => {
    const registrationAtom = previewEnvironment.engineHostRegistration({
      environmentId,
      input: {},
    });
    return Atom.make((get) => {
      // Profile publication follows the registration: each new host id gets
      // its own publisher, and a lost registration stops it.
      let stopPublishing: (() => void) | null = null;
      const onRegistration = (hostConnectionId: string | null) => {
        stopPublishing?.();
        stopPublishing =
          hostConnectionId === null
            ? null
            : publishHostProfiles({
                hostConnectionId,
                profiles: hostProfiles,
                subscribe: subscribeClientSettings,
                send: (input) => sendProfiles({ environmentId, input }),
              });
      };
      get.addFinalizer(() => {
        onRegistration(null);
        useBrowserEngineHostStore.getState().setHostConnectionId(environmentId, null);
      });
      get.subscribe(
        registrationAtom,
        createEngineHostEventHandler({
          environmentId,
          bridge: previewBridge,
          sendResult: (input) => commandResult({ environmentId, input }),
          profiles: hostProfiles,
          confirm: hostConfirm,
          onRegistration,
        }),
        { immediate: true },
      );
    }).pipe(Atom.setIdleTTL(0), Atom.withLabel(`preview:engine-host:${environmentId}`));
  }, [commandResult, environmentId, sendProfiles]);
  useAtomValue(consumerAtom);
  return null;
}
