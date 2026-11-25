import { DpopProof, ManagedRelay } from "@t3tools/client-runtime/relay";
import { RelayMobileClientId } from "@t3tools/contracts/relay";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { loadOrCreateProofKey } from "./dpop";
import { managedRelayAccessTokenStore } from "./managedRelayTokenStore";
import * as SecureChannelCrypto from "./secureChannelCrypto";

const layerRelayDpopSigner = Layer.unwrap(
  Effect.map(Effect.promise(SecureChannelCrypto.load), (secureChannelCrypto) =>
    DpopProof.layerSigner({
      keyStore: "expo-secure-store",
      loadOrCreateKey: loadOrCreateProofKey(),
      ...(secureChannelCrypto === undefined ? {} : { secureChannelCrypto }),
    }),
  ),
);

export const layer = (relayUrl: string) =>
  ManagedRelay.layer({
    relayUrl,
    clientId: RelayMobileClientId,
    accessTokenStore: managedRelayAccessTokenStore,
  }).pipe(Layer.provideMerge(layerRelayDpopSigner));
