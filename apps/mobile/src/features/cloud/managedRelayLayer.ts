import { DpopProof, ManagedRelay } from "@t3tools/client-runtime/relay";
import { RelayMobileClientId } from "@t3tools/contracts/relay";
import * as Layer from "effect/Layer";

import { loadOrCreateProofKey } from "./dpop";
import { resolveCloudPublicConfig } from "./publicConfig";
import { managedRelayAccessTokenStore } from "./managedRelayTokenStore";

const layerRelayDpopSigner = DpopProof.layerSigner({
  keyStore: "expo-secure-store",
  loadOrCreateKey: loadOrCreateProofKey(),
});

export const layer = (relayUrl: string) =>
  ManagedRelay.layer({
    relayUrl,
    backgroundRelayUrl: resolveCloudPublicConfig().relay.backgroundUrl ?? undefined,
    clientId: RelayMobileClientId,
    accessTokenStore: managedRelayAccessTokenStore,
  }).pipe(Layer.provideMerge(layerRelayDpopSigner));
