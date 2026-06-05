import {
  managedRelayClientLayer,
  ManagedRelayDpopSigner,
  ManagedRelayDpopSignerError,
} from "@t3tools/client-runtime";
import { RelayMobileClientId } from "@t3tools/contracts/relay";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { createDpopProof, loadOrCreateDpopProofKeyPair } from "./dpop";

const mobileRelayDpopSignerLayer = Layer.effect(
  ManagedRelayDpopSigner,
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    return ManagedRelayDpopSigner.of({
      thumbprint: Effect.suspend(() =>
        loadOrCreateDpopProofKeyPair().pipe(
          Effect.provideService(Crypto.Crypto, crypto),
          Effect.map((proofKey) => proofKey.thumbprint),
          Effect.mapError((cause) => new ManagedRelayDpopSignerError({ cause })),
        ),
      ),
      createProof: (input) =>
        Effect.gen(function* () {
          const proofKey = yield* loadOrCreateDpopProofKeyPair().pipe(
            Effect.provideService(Crypto.Crypto, crypto),
          );
          return yield* createDpopProof({ ...input, proofKey }).pipe(
            Effect.provideService(Crypto.Crypto, crypto),
            Effect.map((proof) => proof.proof),
          );
        }).pipe(Effect.mapError((cause) => new ManagedRelayDpopSignerError({ cause }))),
    });
  }),
);

export const mobileManagedRelayClientLayer = (relayUrl: string) =>
  managedRelayClientLayer({ relayUrl, clientId: RelayMobileClientId }).pipe(
    Layer.provideMerge(mobileRelayDpopSignerLayer),
  );
