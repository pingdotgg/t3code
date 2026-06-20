import {
  computeDpopAccessTokenHash,
  computeDpopJwkThumbprint,
  DpopPublicJwk,
} from "@t3tools/shared/dpop";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { importJWK, SignJWT, type JWK } from "jose";

export interface BrowserDpopKey {
  readonly privateKey: CryptoKey;
  readonly publicJwk: DpopPublicJwk;
  readonly thumbprint: string;
}

export class BrowserDpopStorageError extends Schema.TaggedErrorClass<BrowserDpopStorageError>()(
  "BrowserDpopStorageError",
  {
    operation: Schema.Literals(["open", "read", "write"]),
    databaseName: Schema.String,
    storeName: Schema.String,
    keyId: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Browser DPoP key storage operation "${this.operation}" failed for database "${this.databaseName}".`;
  }
}

export class BrowserDpopKeyError extends Schema.TaggedErrorClass<BrowserDpopKeyError>()(
  "BrowserDpopKeyError",
  {
    operation: Schema.Literals([
      "generate",
      "export-private",
      "export-public",
      "validate-public",
      "import-private",
    ]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Browser DPoP key operation "${this.operation}" failed.`;
  }
}

export class BrowserDpopProofError extends Schema.TaggedErrorClass<BrowserDpopProofError>()(
  "BrowserDpopProofError",
  {
    operation: Schema.Literals(["normalize-url", "generate-id", "sign"]),
    method: Schema.String,
    requestTarget: Schema.String,
    urlLength: Schema.Number,
    thumbprint: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Browser DPoP proof operation "${this.operation}" failed for ${this.method.toUpperCase()} ${this.requestTarget}.`;
  }
}

export const BrowserDpopError = Schema.Union([
  BrowserDpopStorageError,
  BrowserDpopKeyError,
  BrowserDpopProofError,
]);
export type BrowserDpopError = typeof BrowserDpopError.Type;
export const isBrowserDpopError = Schema.is(BrowserDpopError);

const DPOP_DATABASE_NAME = "t3code:cloud-auth";
const DPOP_DATABASE_VERSION = 1;
const DPOP_KEY_STORE_NAME = "keys";
const DPOP_KEY_ID = "relay-dpop-proof-key";
const decodeDpopPublicJwk = Schema.decodeUnknownEffect(DpopPublicJwk);

function redactDpopRequestTarget(url: string): string {
  try {
    const parsedUrl = new URL(url);
    return `${parsedUrl.protocol}//${parsedUrl.host}${parsedUrl.pathname}`;
  } catch {
    return "<invalid-url>";
  }
}

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

function openDpopDatabase(): Effect.Effect<IDBDatabase, BrowserDpopError> {
  return Effect.callback<IDBDatabase, BrowserDpopError>((resume) => {
    const request = indexedDB.open(DPOP_DATABASE_NAME, DPOP_DATABASE_VERSION);
    request.addEventListener("error", () =>
      resume(
        Effect.fail(
          new BrowserDpopStorageError({
            operation: "open",
            databaseName: DPOP_DATABASE_NAME,
            storeName: DPOP_KEY_STORE_NAME,
            keyId: DPOP_KEY_ID,
            ...(request.error === null ? {} : { cause: request.error }),
          }),
        ),
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
          resume(
            Effect.fail(
              new BrowserDpopStorageError({
                operation: "read",
                databaseName: DPOP_DATABASE_NAME,
                storeName: DPOP_KEY_STORE_NAME,
                keyId: DPOP_KEY_ID,
                ...(request.error === null ? {} : { cause: request.error }),
              }),
            ),
          ),
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
            Effect.fail(
              new BrowserDpopStorageError({
                operation: "write",
                databaseName: DPOP_DATABASE_NAME,
                storeName: DPOP_KEY_STORE_NAME,
                keyId: DPOP_KEY_ID,
                ...(transaction.error === null ? {} : { cause: transaction.error }),
              }),
            ),
          ),
        );
        transaction.addEventListener("complete", () => resume(Effect.void));
        transaction.objectStore(DPOP_KEY_STORE_NAME).put(key, DPOP_KEY_ID);
      }),
    (database) => Effect.sync(() => database.close()),
  );
}

export const generateBrowserDpopKey = Effect.gen(function* () {
  const generated = yield* Effect.tryPromise({
    try: () =>
      crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
        "sign",
        "verify",
      ]) as Promise<CryptoKeyPair>,
    catch: (cause) => new BrowserDpopKeyError({ operation: "generate", cause }),
  });
  const privateJwk = yield* Effect.tryPromise({
    try: () => crypto.subtle.exportKey("jwk", generated.privateKey),
    catch: (cause) => new BrowserDpopKeyError({ operation: "export-private", cause }),
  });
  const encodedPublicJwk = yield* Effect.tryPromise({
    try: () => crypto.subtle.exportKey("jwk", generated.publicKey),
    catch: (cause) => new BrowserDpopKeyError({ operation: "export-public", cause }),
  });
  const publicJwk = yield* decodeDpopPublicJwk(encodedPublicJwk).pipe(
    Effect.mapError((cause) => new BrowserDpopKeyError({ operation: "validate-public", cause })),
  );
  const privateKey = yield* Effect.tryPromise({
    try: () => importJWK(privateJwk as JWK, "ES256", { extractable: false }) as Promise<CryptoKey>,
    catch: (cause) => new BrowserDpopKeyError({ operation: "import-private", cause }),
  });
  return {
    privateKey,
    publicJwk,
    thumbprint: computeDpopJwkThumbprint(publicJwk),
  };
});

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
    const requestTarget = redactDpopRequestTarget(input.url);
    const urlLength = input.url.length;
    const normalizedUrl = yield* Effect.try({
      try: () => new URL(input.url),
      catch: (cause) =>
        new BrowserDpopProofError({
          operation: "normalize-url",
          method: input.method,
          requestTarget,
          urlLength,
          thumbprint: input.proofKey.thumbprint,
          cause,
        }),
    });
    normalizedUrl.search = "";
    normalizedUrl.hash = "";
    const jti = yield* Crypto.Crypto.pipe(
      Effect.flatMap((crypto) => crypto.randomUUIDv4),
      Effect.mapError(
        (cause) =>
          new BrowserDpopProofError({
            operation: "generate-id",
            method: input.method,
            requestTarget,
            urlLength,
            thumbprint: input.proofKey.thumbprint,
            cause,
          }),
      ),
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
      catch: (cause) =>
        new BrowserDpopProofError({
          operation: "sign",
          method: input.method,
          requestTarget,
          urlLength,
          thumbprint: input.proofKey.thumbprint,
          cause,
        }),
    });
    return { proof, thumbprint: input.proofKey.thumbprint };
  });
}
