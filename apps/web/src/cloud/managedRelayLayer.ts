import { ManagedRelay } from "@t3tools/client-runtime/relay";
import { RelayWebClientId } from "@t3tools/contracts/relay";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";

import {
  createBrowserDpopProof,
  generateBrowserDpopKey,
  readStoredBrowserDpopKey,
  writeStoredBrowserDpopKey,
  type BrowserDpopKey,
} from "./dpop";

export const relayDpopSignerLayer = Layer.effect(
  ManagedRelay.ManagedRelayDpopSigner,
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    const keyLoadSemaphore = yield* Semaphore.make(1);
    let loadedKey: BrowserDpopKey | null = null;
    const loadOrCreateBrowserDpopKey = keyLoadSemaphore.withPermit(
      Effect.gen(function* () {
        if (loadedKey) {
          return loadedKey;
        }
        const stored = yield* readStoredBrowserDpopKey();
        if (stored) {
          loadedKey = stored;
          return stored;
        }
        const generated = yield* generateBrowserDpopKey;
        yield* writeStoredBrowserDpopKey(generated);
        loadedKey = generated;
        return generated;
      }),
    );

    return ManagedRelay.ManagedRelayDpopSigner.of({
      thumbprint: loadOrCreateBrowserDpopKey.pipe(
        Effect.map((proofKey) => proofKey.thumbprint),
        Effect.mapError(
          (error) =>
            new ManagedRelay.ManagedRelayDpopKeyLoadError({
              keyStore: "indexed-db",
              cause: error,
            }),
        ),
        Effect.withSpan("web.managedRelayDpopSigner.loadThumbprint"),
      ),
      createProof: Effect.fn("web.managedRelayDpopSigner.createProof")(function* (input) {
        const proofKey = yield* loadOrCreateBrowserDpopKey.pipe(
          Effect.mapError(
            (error) =>
              new ManagedRelay.ManagedRelayDpopProofCreationError({
                method: input.method,
                url: input.url,
                cause: error,
              }),
          ),
        );
        return yield* createBrowserDpopProof({ ...input, proofKey }).pipe(
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
  ManagedRelay.layer({ relayUrl, clientId: RelayWebClientId }).pipe(
    Layer.provideMerge(relayDpopSignerLayer),
  );
