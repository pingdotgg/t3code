import { ManagedRelay } from "@t3tools/client-runtime/relay";
import { RelayMobileClientId } from "@t3tools/contracts/relay";
import * as Cache from "effect/Cache";
import * as Crypto from "effect/Crypto";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";

import { createDpopProof, loadOrCreateDpopProofKeyPair } from "./dpop";
import { managedRelayAccessTokenStore } from "./managedRelayTokenStore";

const relayDpopSignerLayer = Layer.effect(
  ManagedRelay.ManagedRelayDpopSigner,
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    // Keeps the loaded key for the app's lifetime. A failed or interrupted
    // load is not kept, so the next relay request loads it again.
    const proofKeyCache = yield* Cache.makeWith(
      () => loadOrCreateDpopProofKeyPair().pipe(Effect.provideService(Crypto.Crypto, crypto)),
      {
        capacity: 1,
        timeToLive: (exit) => (Exit.isSuccess(exit) ? Duration.infinity : Duration.zero),
      },
    );
    const loadProofKey = Cache.get(proofKeyCache, undefined);
    return ManagedRelay.ManagedRelayDpopSigner.of({
      thumbprint: loadProofKey.pipe(
        Effect.map((proofKey) => proofKey.thumbprint),
        Effect.mapError(
          (error) =>
            new ManagedRelay.ManagedRelayDpopKeyLoadError({
              keyStore: "expo-secure-store",
              cause: error,
            }),
        ),
        Effect.withSpan("mobile.managedRelayDpopSigner.loadThumbprint"),
      ),
      createProof: Effect.fn("mobile.managedRelayDpopSigner.createProof")(function* (input) {
        const proofKey = yield* loadProofKey.pipe(
          Effect.mapError(
            (error) =>
              new ManagedRelay.ManagedRelayDpopProofCreationError({
                method: input.method,
                url: input.url,
                cause: error,
              }),
          ),
        );
        return yield* createDpopProof({ ...input, proofKey }).pipe(
          Effect.provideService(Crypto.Crypto, crypto),
          Effect.map((proof) => proof.proof),
          Effect.mapError(
            (error) =>
              new ManagedRelay.ManagedRelayDpopProofCreationError({
                method: input.method,
                url: input.url,
                cause: error,
              }),
          ),
        );
      }),
    });
  }),
);

export const managedRelayClientLayer = (relayUrl: string) =>
  ManagedRelay.layer({
    relayUrl,
    clientId: RelayMobileClientId,
    accessTokenStore: managedRelayAccessTokenStore,
  }).pipe(Layer.provideMerge(relayDpopSignerLayer));
