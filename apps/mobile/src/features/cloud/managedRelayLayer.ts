import {
  managedRelayClientLayer as makeManagedRelayClientLayer,
  ManagedRelayDpopSigner,
  ManagedRelayDpopSignerError,
} from "@t3tools/client-runtime/relay";
import { RelayMobileClientId } from "@t3tools/contracts/relay";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { createDpopProof, loadOrCreateDpopProofKeyPair } from "./dpop";
import { managedRelayAccessTokenStore } from "./managedRelayTokenStore";

const relayDpopSignerLayer = Layer.effect(
  ManagedRelayDpopSigner,
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    const loadProofKey = yield* Effect.cached(
      loadOrCreateDpopProofKeyPair().pipe(Effect.provideService(Crypto.Crypto, crypto)),
    );
    return ManagedRelayDpopSigner.of({
      thumbprint: loadProofKey.pipe(
        Effect.map((proofKey) => proofKey.thumbprint),
        Effect.mapError((cause) => new ManagedRelayDpopSignerError({ cause })),
        Effect.withSpan("mobile.managedRelayDpopSigner.loadThumbprint"),
      ),
      createProof: Effect.fn("mobile.managedRelayDpopSigner.createProof")(
        function* (input) {
          const proofKey = yield* loadProofKey;
          return yield* createDpopProof({ ...input, proofKey }).pipe(
            Effect.provideService(Crypto.Crypto, crypto),
            Effect.map((proof) => proof.proof),
          );
        },
        Effect.mapError((cause) => new ManagedRelayDpopSignerError({ cause })),
      ),
    });
  }),
);

export const managedRelayClientLayer = (relayUrl: string) =>
  makeManagedRelayClientLayer({
    relayUrl,
    clientId: RelayMobileClientId,
    accessTokenStore: managedRelayAccessTokenStore,
  }).pipe(Layer.provideMerge(relayDpopSignerLayer));
