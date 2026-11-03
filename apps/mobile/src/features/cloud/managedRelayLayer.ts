import { ManagedRelay } from "@t3tools/client-runtime/relay";
import { RelayMobileClientId } from "@t3tools/contracts/relay";
import * as Cache from "effect/Cache";
import * as Digest from "effect/crypto/Digest";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";

import { createDpopProof, loadOrCreateDpopProofKeyPair } from "./dpop";
import { managedRelayAccessTokenStore } from "./managedRelayTokenStore";

const layerRelayDpopSigner = Layer.effect(
  ManagedRelay.ManagedRelayDpopSigner,
  Effect.gen(function* () {
    const random = yield* SecureRandom.SecureRandom;
    const digest = yield* Digest.Digest;
    const proofKeyCache = yield* Cache.makeWith(
      () =>
        loadOrCreateDpopProofKeyPair().pipe(
          Effect.provideService(SecureRandom.SecureRandom, random),
          Effect.provideService(Digest.Digest, digest),
        ),
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
          Effect.provideService(SecureRandom.SecureRandom, random),
          Effect.provideService(Digest.Digest, digest),
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

export const layer = (relayUrl: string) =>
  ManagedRelay.layer({
    relayUrl,
    clientId: RelayMobileClientId,
    accessTokenStore: managedRelayAccessTokenStore,
  }).pipe(Layer.provideMerge(layerRelayDpopSigner));
