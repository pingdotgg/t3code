import {
  computeDpopAccessTokenHash,
  computeDpopJwkThumbprint,
  DpopPublicJwk,
} from "@t3tools/shared/dpop";
import * as Crypto from "effect/Crypto";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { importJWK, SignJWT, type JWK } from "jose";

export interface BrowserDpopKey {
  readonly privateKey: CryptoKey;
  readonly publicJwk: DpopPublicJwk;
  readonly thumbprint: string;
}

export class BrowserDpopError extends Data.TaggedError("BrowserDpopError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

const DPOP_DATABASE_NAME = "t3code:cloud-auth";
const DPOP_DATABASE_VERSION = 1;
const DPOP_KEY_STORE_NAME = "keys";
const DPOP_KEY_ID = "relay-dpop-proof-key";
const decodeDpopPublicJwk = Schema.decodeUnknownEffect(DpopPublicJwk);

export const browserCryptoLayer = Layer.succeed(
  Crypto.Crypto,
  Crypto.make({
    randomBytes: (size) => globalThis.crypto.getRandomValues(new Uint8Array(size)),
    digest: (algorithm, data) =>
      Effect.promise(async () => {
        const input = new Uint8Array(data.length);
        input.set(data);
        return new Uint8Array(await globalThis.crypto.subtle.digest(algorithm, input.buffer));
      }),
  }),
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

export function readStoredBrowserDpopKey(): Effect.Effect<BrowserDpopKey | null, BrowserDpopError> {
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

export function writeStoredBrowserDpopKey(
  key: BrowserDpopKey,
): Effect.Effect<void, BrowserDpopError> {
  if (typeof indexedDB === "undefined") {
    return Effect.void;
  }
  return Effect.acquireUseRelease(
    openDpopDatabase(),
    (database) =>
      Effect.callback<void, BrowserDpopError>((resume) => {
        const transaction = database.transaction(DPOP_KEY_STORE_NAME, "readwrite");
        transaction.addEventListener("error", () =>
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

export const generateBrowserDpopKey: Effect.Effect<BrowserDpopKey, BrowserDpopError> = Effect.gen(
  function* () {
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
        cause instanceof BrowserDpopError
          ? cause
          : dpopError("Generated DPoP public key is invalid.", cause),
      ),
    );
    const privateKey = yield* Effect.tryPromise({
      try: () =>
        importJWK(privateJwk as JWK, "ES256", { extractable: false }) as Promise<CryptoKey>,
      catch: (cause) => dpopError("Could not import DPoP private key.", cause),
    });
    return {
      privateKey,
      publicJwk,
      thumbprint: computeDpopJwkThumbprint(publicJwk),
    };
  },
);

export function createBrowserDpopProof(input: {
  readonly method: string;
  readonly url: string;
  readonly accessToken?: string;
  readonly proofKey: BrowserDpopKey;
}): Effect.Effect<
  { readonly proof: string; readonly thumbprint: string },
  BrowserDpopError,
  Crypto.Crypto
> {
  return Effect.gen(function* () {
    const normalizedUrl = yield* Effect.try({
      try: () => new URL(input.url),
      catch: (cause) => dpopError("Could not normalize DPoP proof URL.", cause),
    });
    normalizedUrl.search = "";
    normalizedUrl.hash = "";
    const jti = yield* Crypto.Crypto.pipe(
      Effect.flatMap((crypto) => crypto.randomUUIDv4),
      Effect.mapError((cause) => dpopError("Could not generate DPoP proof identifier.", cause)),
    );
    const proof = yield* Effect.tryPromise({
      try: () =>
        new SignJWT({
          htm: input.method.toUpperCase(),
          htu: normalizedUrl.toString(),
          jti,
          ...(input.accessToken ? { ath: computeDpopAccessTokenHash(input.accessToken) } : {}),
        })
          .setProtectedHeader({
            typ: "dpop+jwt",
            alg: "ES256",
            jwk: input.proofKey.publicJwk,
          })
          .setIssuedAt()
          .sign(input.proofKey.privateKey),
      catch: (cause) => dpopError("Could not sign DPoP proof.", cause),
    });
    return { proof, thumbprint: input.proofKey.thumbprint };
  });
}
