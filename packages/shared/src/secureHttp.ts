/**
 * Whole HTTP requests sealed for one environment, so a tunnel that ends TLS can neither read nor
 * alter them. The environment signs an in-memory P-256 exchange key with its identity key; a
 * client encrypts each request to it under keys from ECDH and a random salt, and the response
 * comes back under a second key from the same derivation.
 */
import { ed25519 } from "@noble/curves/ed25519";
import * as Aead from "effect/crypto/Aead";
import * as Digest from "effect/crypto/Digest";
import * as Kdf from "effect/crypto/Kdf";
import * as KeyAgreement from "effect/crypto/KeyAgreement";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import type { SecureChannelIdentity } from "./secureChannel.ts";

export const SECURE_HTTP_PATH = "/api/secure";
export const SECURE_HTTP_KEY_PATH = "/api/secure/key";
/** Inner bodies are buffered whole on both sides. A five-minute voice upload is about 19.3 MB. */
export const SECURE_HTTP_MAX_BODY_BYTES = 24 * 1024 * 1024;
/** Room for the inner head and the envelope's own bytes. */
export const SECURE_HTTP_MAX_ENVELOPE_BYTES = SECURE_HTTP_MAX_BODY_BYTES + 256 * 1024;
/** The environment no longer holds the exchange key the request was sealed to. */
export const SECURE_HTTP_STALE_KEY_STATUS = 409;

const KEY_LABEL = "t3-secure-http-key-v1";
const INFO_LABEL = "t3-secure-http-v1";
const KEY_ID_LENGTH = 8;
const PUBLIC_KEY_LENGTH = 65;
const SALT_LENGTH = 16;
const NONCE_LENGTH = 12;
const ENVELOPE_HEADER_LENGTH = KEY_ID_LENGTH + PUBLIC_KEY_LENGTH + SALT_LENGTH;
// The request key is used for exactly one message: the salt is fresh per request, so a zero nonce
// never repeats under it. Never reuse a salt.
const ZERO_NONCE = new Uint8Array(NONCE_LENGTH);
const SHARED_SECRET_CACHE_SIZE = 256;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const SecureHttpKey = Schema.Struct({
  /** Base64url of the 65-byte uncompressed P-256 point. */
  publicKey: Schema.String,
  issuedAt: Schema.String,
  /** Base64url Ed25519 signature by the environment's identity key. */
  signature: Schema.String,
});
export type SecureHttpKey = typeof SecureHttpKey.Type;

export class SecureHttpError extends Schema.TaggedError<SecureHttpError>()("SecureHttpError", {
  reason: Schema.Literals([
    "malformed_message",
    "unknown_key",
    "decryption_failed",
    "crypto_failure",
    "too_large",
  ]),
  cause: Schema.optional(Schema.Defect()),
}) {}

const cryptoFailure = (cause: unknown) => new SecureHttpError({ reason: "crypto_failure", cause });
const malformed = () => new SecureHttpError({ reason: "malformed_message" });

const HeaderRecord = Schema.Record(Schema.String, Schema.String);

export interface SecureHttpInnerRequest {
  readonly method: string;
  /** Absolute, exactly as the client would have sent it; DPoP `htu` is checked against it. */
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
}

export interface SecureHttpInnerResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
}

const decodeRequestHead = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({ method: Schema.String, url: Schema.String, headers: HeaderRecord }),
  ),
);
const decodeResponseHead = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ status: Schema.Int, headers: HeaderRecord })),
);

function concat(...parts: ReadonlyArray<Uint8Array>): Uint8Array {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

const sameBytes = (left: Uint8Array, right: Uint8Array) =>
  left.length === right.length && left.every((byte, index) => byte === right[index]);

/** `u32 head length ‖ UTF-8 JSON head ‖ body`, so the body is never re-encoded. */
function encodeMessage(head: unknown, body: Uint8Array): Uint8Array {
  const headBytes = encoder.encode(JSON.stringify(head));
  const out = new Uint8Array(4 + headBytes.length + body.length);
  new DataView(out.buffer).setUint32(0, headBytes.length);
  out.set(headBytes, 4);
  out.set(body, 4 + headBytes.length);
  return out;
}

function splitMessage(bytes: Uint8Array) {
  if (bytes.length < 4) return undefined;
  const headLength = new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0);
  if (4 + headLength > bytes.length) return undefined;
  return {
    head: decoder.decode(bytes.subarray(4, 4 + headLength)),
    body: bytes.subarray(4 + headLength),
  };
}

const checkBodySize = (body: Uint8Array) =>
  body.length > SECURE_HTTP_MAX_BODY_BYTES
    ? Effect.fail(new SecureHttpError({ reason: "too_large" }))
    : Effect.void;

function secureHttpKeyMessage(
  environmentId: string,
  publicKey: Uint8Array,
  issuedAt: string,
): Uint8Array {
  return concat(
    encoder.encode(KEY_LABEL),
    Uint8Array.of(0),
    encoder.encode(environmentId),
    Uint8Array.of(0),
    publicKey,
    encoder.encode(issuedAt),
  );
}

/**
 * The exchange key's public bytes when `pinned` (the environment's raw Ed25519 identity key)
 * signed it for `environmentId`, otherwise undefined.
 */
export function verifySecureHttpKey(input: {
  readonly pinned: Uint8Array;
  readonly environmentId: string;
  readonly key: SecureHttpKey;
}): Uint8Array | undefined {
  const publicKey = Result.getOrUndefined(Base64Url.decode(input.key.publicKey));
  const signature = Result.getOrUndefined(Base64Url.decode(input.key.signature));
  if (
    publicKey?.length !== PUBLIC_KEY_LENGTH ||
    publicKey[0] !== 0x04 ||
    signature === undefined ||
    input.pinned.length !== 32
  ) {
    return undefined;
  }
  try {
    return ed25519.verify(
      signature,
      secureHttpKeyMessage(input.environmentId, publicKey, input.key.issuedAt),
      input.pinned,
      { zip215: false },
    )
      ? publicKey
      : undefined;
  } catch {
    return undefined;
  }
}

const keyIdOf = Effect.fnUntraced(function* (publicKey: Uint8Array) {
  const digest = yield* Digest.Digest;
  const hash = yield* digest.digest(Digest.sha256, publicKey);
  return hash.slice(0, KEY_ID_LENGTH);
});

const sharedSecret = Effect.fnUntraced(function* (
  privateKey: KeyAgreement.PrivateKey<typeof KeyAgreement.ecdhP256>,
  peerPublicKey: Uint8Array,
) {
  const keyAgreement = yield* KeyAgreement.KeyAgreement;
  return yield* KeyAgreement.publicKey(KeyAgreement.ecdhP256, peerPublicKey).pipe(
    Effect.flatMap((publicKey) => keyAgreement.deriveSharedSecret(privateKey, publicKey)),
    Effect.mapError(cryptoFailure),
  );
});

const deriveKeys = Effect.fnUntraced(function* (input: {
  readonly shared: Uint8Array;
  readonly salt: Uint8Array;
  readonly exchangePublicKey: Uint8Array;
  readonly clientPublicKey: Uint8Array;
}) {
  const kdf = yield* Kdf.Kdf;
  const keys = yield* kdf
    .derive(Kdf.hkdfSha256, input.shared, {
      salt: input.salt,
      info: concat(encoder.encode(INFO_LABEL), input.exchangePublicKey, input.clientPublicKey),
      length: 64,
    })
    .pipe(Effect.mapError(cryptoFailure));
  return {
    requestKey: yield* Aead.key(Aead.aes256Gcm, keys.subarray(0, 32)).pipe(
      Effect.mapError(cryptoFailure),
    ),
    responseKey: yield* Aead.key(Aead.aes256Gcm, keys.subarray(32)).pipe(
      Effect.mapError(cryptoFailure),
    ),
  };
});

type ResponseKey = Effect.Success<ReturnType<typeof deriveKeys>>["responseKey"];

// A replayed envelope derives the same response key, so each response takes a random nonce: a
// zero nonce would encrypt two different responses under one key and nonce.
const sealResponse = Effect.fnUntraced(function* (
  responseKey: ResponseKey,
  response: SecureHttpInnerResponse,
) {
  yield* checkBodySize(response.body);
  const aead = yield* Aead.Aead;
  const nonce = yield* (yield* SecureRandom.SecureRandom).randomBytes(NONCE_LENGTH);
  const sealed = yield* aead
    .encrypt(
      responseKey,
      encodeMessage({ status: response.status, headers: response.headers }, response.body),
      { nonce },
    )
    .pipe(Effect.mapError(cryptoFailure));
  return concat(nonce, sealed);
});

const openResponse = Effect.fnUntraced(function* (responseKey: ResponseKey, sealed: Uint8Array) {
  if (sealed.length < NONCE_LENGTH) return yield* malformed();
  const aead = yield* Aead.Aead;
  const plaintext = yield* aead
    .decrypt(responseKey, sealed.subarray(NONCE_LENGTH), {
      nonce: sealed.subarray(0, NONCE_LENGTH),
    })
    .pipe(Effect.mapError((cause) => new SecureHttpError({ reason: "decryption_failed", cause })));
  const split = splitMessage(plaintext);
  const head = split === undefined ? Option.none() : decodeResponseHead(split.head);
  if (split === undefined || Option.isNone(head)) return yield* malformed();
  return { ...head.value, body: split.body } satisfies SecureHttpInnerResponse;
});

type SecureHttpCrypto =
  | Aead.Aead
  | Digest.Digest
  | Kdf.Kdf
  | KeyAgreement.KeyAgreement
  | SecureRandom.SecureRandom;

/**
 * The environment side: one exchange key, kept only in memory. A new one each server start bounds
 * how much past traffic one key compromise exposes.
 */
export const makeSecureHttpExchange = Effect.fn("secureHttp.makeExchange")(function* (input: {
  readonly environmentId: string;
  readonly identity: SecureChannelIdentity;
  readonly issuedAt: string;
}) {
  const context = yield* Effect.context<SecureHttpCrypto>();
  const keyAgreement = yield* KeyAgreement.KeyAgreement;
  const pair = yield* keyAgreement
    .generateKeyPair(KeyAgreement.ecdhP256)
    .pipe(Effect.mapError(cryptoFailure));
  const publicKey = yield* KeyAgreement.toBytes(pair.publicKey).pipe(
    Effect.mapError(cryptoFailure),
  );
  const keyId = yield* keyIdOf(publicKey);
  const signature = yield* input.identity
    .sign(secureHttpKeyMessage(input.environmentId, publicKey, input.issuedAt))
    .pipe(Effect.mapError(cryptoFailure));
  // Clients reuse an ephemeral key for minutes, so most requests skip the key agreement.
  const secrets = new Map<string, Uint8Array>();
  const secretFor = Effect.fnUntraced(function* (clientPublicKey: Uint8Array) {
    const id = Base64Url.encode(clientPublicKey);
    const cached = secrets.get(id);
    if (cached !== undefined) return cached;
    const shared = yield* sharedSecret(pair.privateKey, clientPublicKey);
    if (secrets.size >= SHARED_SECRET_CACHE_SIZE) secrets.delete(secrets.keys().next().value!);
    secrets.set(id, shared);
    return shared;
  });

  const open = Effect.fn("secureHttp.open")(function* (envelope: Uint8Array) {
    if (envelope.length < ENVELOPE_HEADER_LENGTH) return yield* malformed();
    if (!sameBytes(envelope.subarray(0, KEY_ID_LENGTH), keyId)) {
      return yield* new SecureHttpError({ reason: "unknown_key" });
    }
    const clientPublicKey = envelope.slice(KEY_ID_LENGTH, KEY_ID_LENGTH + PUBLIC_KEY_LENGTH);
    const salt = envelope.subarray(KEY_ID_LENGTH + PUBLIC_KEY_LENGTH, ENVELOPE_HEADER_LENGTH);
    const keys = yield* deriveKeys({
      shared: yield* secretFor(clientPublicKey),
      salt,
      exchangePublicKey: publicKey,
      clientPublicKey,
    });
    const aead = yield* Aead.Aead;
    const plaintext = yield* aead
      .decrypt(keys.requestKey, envelope.subarray(ENVELOPE_HEADER_LENGTH), { nonce: ZERO_NONCE })
      .pipe(
        Effect.mapError((cause) => new SecureHttpError({ reason: "decryption_failed", cause })),
      );
    const split = splitMessage(plaintext);
    const head = split === undefined ? Option.none() : decodeRequestHead(split.head);
    if (split === undefined || Option.isNone(head)) return yield* malformed();
    return {
      request: { ...head.value, body: split.body } satisfies SecureHttpInnerRequest,
      seal: (response: SecureHttpInnerResponse) =>
        sealResponse(keys.responseKey, response).pipe(Effect.provideContext(context)),
    };
  }, Effect.provideContext(context));

  return {
    key: {
      publicKey: Base64Url.encode(publicKey),
      issuedAt: input.issuedAt,
      signature: Base64Url.encode(signature),
    } satisfies SecureHttpKey,
    open,
  };
});

/**
 * The client side for one verified exchange key: an ephemeral key pair and its shared secret, reused
 * for every request until the caller replaces the session.
 */
export const makeSecureHttpClientSession = Effect.fn("secureHttp.makeClientSession")(function* (
  exchangePublicKey: Uint8Array,
) {
  const context = yield* Effect.context<SecureHttpCrypto>();
  const keyAgreement = yield* KeyAgreement.KeyAgreement;
  const ephemeral = yield* keyAgreement
    .generateKeyPair(KeyAgreement.ecdhP256)
    .pipe(Effect.mapError(cryptoFailure));
  const clientPublicKey = yield* KeyAgreement.toBytes(ephemeral.publicKey).pipe(
    Effect.mapError(cryptoFailure),
  );
  const shared = yield* sharedSecret(ephemeral.privateKey, exchangePublicKey);
  const keyId = yield* keyIdOf(exchangePublicKey);

  const seal = Effect.fn("secureHttp.seal")(function* (request: SecureHttpInnerRequest) {
    yield* checkBodySize(request.body);
    const salt = yield* (yield* SecureRandom.SecureRandom).randomBytes(SALT_LENGTH);
    const keys = yield* deriveKeys({ shared, salt, exchangePublicKey, clientPublicKey });
    const aead = yield* Aead.Aead;
    const sealed = yield* aead
      .encrypt(
        keys.requestKey,
        encodeMessage(
          { method: request.method, url: request.url, headers: request.headers },
          request.body,
        ),
        { nonce: ZERO_NONCE },
      )
      .pipe(Effect.mapError(cryptoFailure));
    return {
      envelope: concat(keyId, clientPublicKey, salt, sealed),
      open: (sealedResponse: Uint8Array) =>
        openResponse(keys.responseKey, sealedResponse).pipe(Effect.provideContext(context)),
    };
  }, Effect.provideContext(context));

  return { exchangePublicKey, seal };
});

export type SecureHttpClientSession = Effect.Success<
  ReturnType<typeof makeSecureHttpClientSession>
>;
