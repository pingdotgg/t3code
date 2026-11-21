import { builtinServiceLayer } from "@t3tools/shared/pluginKernel";
import { DpopProof, ManagedRelay } from "@t3tools/client-runtime/relay";
import { RelayWebClientId } from "@t3tools/contracts/relay";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { loadOrCreateProofKey } from "./dpop";

const layerRelayDpopSigner = builtinServiceLayer("t3.client")(
  ManagedRelay.ManagedRelayDpopSigner,
  Layer.build(
    DpopProof.layerSigner({
      keyStore: "indexed-db",
      loadOrCreateKey: loadOrCreateProofKey(),
    }),
  ).pipe(Effect.map((context) => Context.get(context, ManagedRelay.ManagedRelayDpopSigner))),
);

export const layer = (relayUrl: string) =>
  ManagedRelay.layer({ relayUrl, clientId: RelayWebClientId }).pipe(
    Layer.provideMerge(layerRelayDpopSigner),
  );
