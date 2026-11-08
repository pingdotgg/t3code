import { DpopProof } from "@t3tools/client-runtime/relay";
import { computeDpopJwkThumbprint, DpopPublicJwk } from "@t3tools/shared/dpop";
import * as Digest from "effect/crypto/Digest";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Signature from "effect/crypto/Signature";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

export interface BrowserDpopKey {
  readonly privateKey: CryptoKey;
  readonly publicJwk: DpopPublicJwk;
  readonly thumbprint: string;
}

export class BrowserDpopError extends Schema.TaggedError<BrowserDpopError>()("BrowserDpopError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

const isBrowserDpopError = Schema.is(BrowserDpopError);

const DPOP_DATABASE_NAME = "t3code:cloud-auth";
const DPOP_DATABASE_VERSION = 1;
const DPOP_KEY_STORE_NAME = "keys";
const DPOP_KEY_ID = "relay-dpop-proof-key";
const decodeDpopPublicJwk = Schema.decodeUnknownEffect(DpopPublicJwk);

export const layer = Layer.mergeAll(Digest.layerWebCrypto, Signature.layerWebCrypto).pipe(
  Layer.provideMerge(SecureRandom.layerWebCrypto),
);

function dpopError(message: string, cause?: unknown) {
  return new BrowserDpopError({ message, ...(cause === undefined ? {} : { cause }) });
}

function openDpopDatabase(): Effect.Effect<IDBDatabase, BrowserDpopError> {
  return Effect.callback<IDBDatabase, BrowserDpopError>((resume) => {
    const request = indexedDB.open(DPOP_DATABASE_NAME, DPOP_DATABASE_VERSION);
    request.addEventListener("error", () =>
      resume(
        Effect.fail(dpopError("Could not open DPoP key storage.", request.error ?? undefined)),
      ),
    );
    request.addEventListener("upgradeneeded", () => {
      if (!request.result.objectStoreNames.contains(DPOP_KEY_STORE_NAME)) {
        request.result.createObjectStore(DPOP_KEY_STORE_NAME);
      }
    });
    request.addEventListener("success", () => resume(Effect.succeed(request.result)));
  });
}

function readStoredBrowserDpopKey(): Effect.Effect<BrowserDpopKey | null, BrowserDpopError> {
  if (typeof indexedDB === "undefined") {
    return Effect.succeed(null);
  }
  return Effect.acquireUseRelease(
    openDpopDatabase(),
    (database) =>
      Effect.callback<BrowserDpopKey | null, BrowserDpopError>((resume) => {
        const request = database
          .transaction(DPOP_KEY_STORE_NAME, "readonly")
          .objectStore(DPOP_KEY_STORE_NAME)
          .get(DPOP_KEY_ID);
        request.addEventListener("error", () =>
          resume(Effect.fail(dpopError("Could not read DPoP key.", request.error ?? undefined))),
        );
        request.addEventListener("success", () =>
          resume(Effect.succeed((request.result as BrowserDpopKey | undefined) ?? null)),
        );
      }),
    (database) => Effect.sync(() => database.close()),
  );
}

function writeStoredBrowserDpopKey(key: BrowserDpopKey): Effect.Effect<void, BrowserDpopError> {
  if (typeof indexedDB === "undefined") {
    return Effect.void;
  }
  return Effect.acquireUseRelease(
    openDpopDatabase(),
    (database) =>
      Effect.callback<void, BrowserDpopError>((resume) => {
        const transaction = database.transaction(DPOP_KEY_STORE_NAME, "readwrite");
        // Commit failures can fire abort without error; every failed write fires abort.
        transaction.addEventListener("abort", () =>
          resume(
            Effect.fail(dpopError("Could not write DPoP key.", transaction.error ?? undefined)),
          ),
        );
        transaction.addEventListener("complete", () => resume(Effect.void));
        transaction.objectStore(DPOP_KEY_STORE_NAME).put(key, DPOP_KEY_ID);
      }),
    (database) => Effect.sync(() => database.close()),
  );
}

const generateBrowserDpopKey = Effect.gen(function* () {
  const generated = yield* Effect.tryPromise({
    try: () =>
      crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
        "sign",
        "verify",
      ]) as Promise<CryptoKeyPair>,
    catch: (cause) => dpopError("Could not generate DPoP proof key.", cause),
  });
  const privateJwk = yield* Effect.tryPromise({
    try: () => crypto.subtle.exportKey("jwk", generated.privateKey),
    catch: (cause) => dpopError("Could not export DPoP private key.", cause),
  });
  const publicJwk = yield* Effect.tryPromise({
    try: () => crypto.subtle.exportKey("jwk", generated.publicKey),
    catch: (cause) => dpopError("Could not export DPoP public key.", cause),
  }).pipe(
    Effect.flatMap((jwk) => decodeDpopPublicJwk(jwk)),
    Effect.mapError((cause) =>
      isBrowserDpopError(cause) ? cause : dpopError("Generated DPoP public key is invalid.", cause),
    ),
  );
  const privateKey = yield* Effect.tryPromise({
    try: () =>
      crypto.subtle.importKey("jwk", privateJwk, { name: "ECDSA", namedCurve: "P-256" }, false, [
        "sign",
      ]),
    catch: (cause) => dpopError("Could not import DPoP private key.", cause),
  });
  return {
    privateKey,
    publicJwk,
    thumbprint: computeDpopJwkThumbprint(publicJwk),
  };
});

/** The stored key, or a new one persisted on first use, as a DPoP proof key. */
export const loadOrCreateProofKey = Effect.fn("dpop.loadOrCreateProofKey")(function* () {
  const signature = yield* Signature.Signature;
  const stored = yield* readStoredBrowserDpopKey();
  const browserKey = stored ?? (yield* generateBrowserDpopKey);
  if (stored === null) yield* writeStoredBrowserDpopKey(browserKey);
  const privateKey = yield* Signature.privateKeyFromCryptoKey(
    Signature.ecdsaP256,
    browserKey.privateKey,
  ).pipe(Effect.mapError((cause) => dpopError("Could not load DPoP proof key.", cause)));
  return {
    publicJwk: browserKey.publicJwk,
    sign: (signingInput) =>
      signature
        .sign(privateKey, signingInput)
        .pipe(
          Effect.mapError(
            (cause) =>
              new DpopProof.DpopProofError({ message: "Could not sign DPoP proof.", cause }),
          ),
        ),
  } satisfies DpopProof.DpopProofKey;
});
