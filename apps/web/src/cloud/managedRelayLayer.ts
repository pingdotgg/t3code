import {
  managedRelayClientLayer,
  ManagedRelayDpopSigner,
  ManagedRelayDpopSignerError,
} from "@t3tools/client-runtime";
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

export const webRelayDpopSignerLayer = Layer.effect(
  ManagedRelayDpopSigner,
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
    const signerError = (cause: unknown) => new ManagedRelayDpopSignerError({ cause });
    return ManagedRelayDpopSigner.of({
      thumbprint: loadOrCreateBrowserDpopKey.pipe(
        Effect.map((proofKey) => proofKey.thumbprint),
        Effect.mapError(signerError),
      ),
      createProof: (input) =>
        loadOrCreateBrowserDpopKey.pipe(
          Effect.flatMap((proofKey) => createBrowserDpopProof({ ...input, proofKey })),
          Effect.provideService(Crypto.Crypto, crypto),
          Effect.map((proof) => proof.proof),
          Effect.mapError(signerError),
        ),
    });
  }),
);

export const webManagedRelayClientLayer = (relayUrl: string) =>
  managedRelayClientLayer({ relayUrl, clientId: RelayWebClientId }).pipe(
    Layer.provideMerge(webRelayDpopSignerLayer),
  );
