import { DpopProof, ManagedRelay } from "@t3tools/client-runtime/relay";
import { RelayWebClientId } from "@t3tools/contracts/relay";
import * as Layer from "effect/Layer";

import { devFakeConnect, layerDevFakeManagedRelay } from "./devFakeConnect";
import { loadOrCreateProofKey } from "./dpop";

const layerRelayDpopSigner = DpopProof.layerSigner({
  keyStore: "indexed-db",
  loadOrCreateKey: loadOrCreateProofKey(),
});

const layerLive = (relayUrl: string) =>
  ManagedRelay.layer({ relayUrl, clientId: RelayWebClientId }).pipe(
    Layer.provideMerge(layerRelayDpopSigner),
  );

export const layer = (relayUrl: string): ReturnType<typeof layerLive> =>
  devFakeConnect === null
    ? layerLive(relayUrl)
    : Layer.merge(layerDevFakeManagedRelay(devFakeConnect), layerRelayDpopSigner);
