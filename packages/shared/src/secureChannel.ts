/**
 * An encrypted channel between a client and an environment, inside a connection a tunnel can read
 * and alter. Both ends swap one-time ECDH keys and sign the transcript with their identity keys;
 * traffic keys come from the ECDH secret and the whole transcript, so any change splits the keys.
 */
import * as Aead from "effect/crypto/Aead";
import * as Digest from "effect/crypto/Digest";
import * as Kdf from "effect/crypto/Kdf";
import * as KeyAgreement from "effect/crypto/KeyAgreement";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

const PROTOCOL = "t3-secure-channel-v1";

const CLIENT_HELLO = 1;
const ENVIRONMENT_HELLO = 2;
const CLIENT_FINISH = 3;

const TEXT_FRAME = 0;
const BINARY_FRAME = 1;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export class SecureChannelError extends Schema.TaggedError<SecureChannelError>()(
  "SecureChannelError",
  {
    reason: Schema.Literals([
      "malformed_message",
      "peer_rejected",
      "crypto_failure",
      "decryption_failed",
    ]),
    cause: Schema.optional(Schema.Defect()),
  },
) {}

const cryptoFailure = (cause: unknown) =>
  new SecureChannelError({ reason: "crypto_failure", cause });
const malformed = () => new SecureChannelError({ reason: "malformed_message" });

/** This side's long-lived key. `sign` must not sign anything else that starts with the protocol name. */
export interface SecureChannelIdentity {
  readonly publicKey: Uint8Array;
  readonly sign: (message: Uint8Array) => Effect.Effect<Uint8Array, SecureChannelError>;
}

/**
 * Answers true only when `publicKey` is the peer this side expects and `signature` is that key's
 * signature over `message`. Checking the signature without checking the key authenticates nobody.
 */
export type SecureChannelVerifyPeer = (input: {
  readonly publicKey: Uint8Array;
  readonly message: Uint8Array;
  readonly signature: Uint8Array;
}) => Effect.Effect<boolean>;

export interface SecureChannel {
  readonly peerPublicKey: Uint8Array;
  /** Frames must go on the wire in the order they were sealed. */
  readonly seal: (frame: string | Uint8Array) => Effect.Effect<Uint8Array, SecureChannelError>;
  /** Frames must be opened in the order they arrived. A failure is final: close the connection. */
  readonly open: (sealed: Uint8Array) => Effect.Effect<string | Uint8Array, SecureChannelError>;
}

interface HandshakeInput {
  /** Bytes both ends already agree on, such as the environment ID. A mismatch fails the handshake. */
  readonly context: Uint8Array;
  readonly identity: SecureChannelIdentity;
  readonly verifyPeer: SecureChannelVerifyPeer;
}

function concat(...parts: ReadonlyArray<Uint8Array>): Uint8Array {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

const label = (name: string) => encoder.encode(`${PROTOCOL} ${name}`);

const field = (bytes: Uint8Array) =>
  concat(Uint8Array.of(bytes.length >> 8, bytes.length & 0xff), bytes);

// Strict: a message with trailing bytes is rejected, so re-encoding the parsed fields gives back
// exactly the bytes that were received and both ends hash the same transcript.
function parse(
  message: Uint8Array,
  tag: number,
  fields: number,
): ReadonlyArray<Uint8Array> | undefined {
  if (message[0] !== tag) return undefined;
  const out: Array<Uint8Array> = [];
  let offset = 1;
  for (let index = 0; index < fields; index += 1) {
    if (offset + 2 > message.length) return undefined;
    const length = (message[offset]! << 8) | message[offset + 1]!;
    offset += 2;
    if (offset + length > message.length) return undefined;
    out.push(message.subarray(offset, offset + length));
    offset += length;
  }
  return offset === message.length ? out : undefined;
}

// Counters stay exact below 2^53 frames, far more than one connection can send, so a nonce never repeats.
function nonce(counter: number): Uint8Array {
  const bytes = new Uint8Array(12);
  const view = new DataView(bytes.buffer);
  view.setUint32(4, Math.floor(counter / 2 ** 32));
  view.setUint32(8, counter >>> 0);
  return bytes;
}

const makeChannel = Effect.fnUntraced(function* (input: {
  readonly role: "client" | "environment";
  readonly secret: Uint8Array;
  readonly transcript: Uint8Array;
  readonly peerPublicKey: Uint8Array;
}) {
  const aead = yield* Aead.Aead;
  const kdf = yield* Kdf.Kdf;
  const keys = yield* kdf.derive(Kdf.hkdfSha256, input.secret, {
    salt: input.transcript,
    info: label("keys"),
    length: 64,
  });
  // One key per direction, so both ends can count from zero and a frame cannot be reflected back.
  const clientKey = yield* Aead.key(Aead.aes256Gcm, keys.subarray(0, 32));
  const environmentKey = yield* Aead.key(Aead.aes256Gcm, keys.subarray(32));
  const sendKey = input.role === "client" ? clientKey : environmentKey;
  const receiveKey = input.role === "client" ? environmentKey : clientKey;
  let sent = 0;
  let received = 0;
  const channel: SecureChannel = {
    peerPublicKey: input.peerPublicKey,
    seal: (frame) =>
      Effect.suspend(() => {
        const payload = typeof frame === "string" ? encoder.encode(frame) : frame;
        const plaintext = new Uint8Array(payload.length + 1);
        plaintext[0] = typeof frame === "string" ? TEXT_FRAME : BINARY_FRAME;
        plaintext.set(payload, 1);
        return aead.encrypt(sendKey, plaintext, { nonce: nonce(sent++) });
      }).pipe(Effect.mapError(cryptoFailure)),
    open: (sealed) =>
      Effect.suspend(() => aead.decrypt(receiveKey, sealed, { nonce: nonce(received++) })).pipe(
        Effect.mapError((cause) => new SecureChannelError({ reason: "decryption_failed", cause })),
        Effect.flatMap((plaintext): Effect.Effect<string | Uint8Array, SecureChannelError> => {
          if (plaintext[0] === TEXT_FRAME) {
            return Effect.succeed(decoder.decode(plaintext.subarray(1)));
          }
          return plaintext[0] === BINARY_FRAME
            ? Effect.succeed(plaintext.subarray(1))
            : Effect.fail(malformed());
        }),
      ),
  };
  return channel;
});

const mix = Effect.fnUntraced(function* (transcript: Uint8Array, data: Uint8Array) {
  const digest = yield* Digest.Digest;
  return yield* digest.digest(Digest.sha256, concat(transcript, data));
});

const startTranscript = (context: Uint8Array) => mix(label("handshake"), field(context));

const requirePeer = Effect.fnUntraced(function* (
  verifyPeer: SecureChannelVerifyPeer,
  input: Parameters<SecureChannelVerifyPeer>[0],
) {
  if (!(yield* verifyPeer(input))) {
    return yield* new SecureChannelError({ reason: "peer_rejected" });
  }
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

/** Client side. Send `hello`, then pass the environment's answer to `finish` and send what it returns. */
export const initiateSecureChannel = Effect.fn("secureChannel.initiate")(function* (
  input: HandshakeInput,
) {
  const keyAgreement = yield* KeyAgreement.KeyAgreement;
  const ephemeral = yield* keyAgreement
    .generateKeyPair(KeyAgreement.ecdhP256)
    .pipe(Effect.mapError(cryptoFailure));
  const hello = concat(
    Uint8Array.of(CLIENT_HELLO),
    field(yield* KeyAgreement.toBytes(ephemeral.publicKey).pipe(Effect.mapError(cryptoFailure))),
  );
  const helloTranscript = yield* mix(yield* startTranscript(input.context), hello);

  const finish = Effect.fn("secureChannel.initiate.finish")(function* (
    environmentHello: Uint8Array,
  ) {
    const parsed = parse(environmentHello, ENVIRONMENT_HELLO, 3);
    if (parsed === undefined) return yield* malformed();
    const environmentEphemeral = parsed[0]!;
    const environmentPublicKey = parsed[1]!;
    const environmentSignature = parsed[2]!;
    const offered = yield* mix(
      helloTranscript,
      concat(
        Uint8Array.of(ENVIRONMENT_HELLO),
        field(environmentEphemeral),
        field(environmentPublicKey),
      ),
    );
    yield* requirePeer(input.verifyPeer, {
      publicKey: environmentPublicKey,
      message: concat(label("environment"), offered),
      signature: environmentSignature,
    });
    const identified = yield* mix(
      yield* mix(offered, field(environmentSignature)),
      concat(Uint8Array.of(CLIENT_FINISH), field(input.identity.publicKey)),
    );
    const signature = yield* input.identity.sign(concat(label("client"), identified));
    const channel = yield* makeChannel({
      role: "client",
      secret: yield* sharedSecret(ephemeral.privateKey, environmentEphemeral),
      transcript: yield* mix(identified, field(signature)),
      peerPublicKey: environmentPublicKey,
    }).pipe(Effect.mapError(cryptoFailure));
    return {
      finish: concat(
        Uint8Array.of(CLIENT_FINISH),
        field(input.identity.publicKey),
        field(signature),
      ),
      channel,
    };
  });

  return { hello, finish };
});

/** Environment side. Send `hello`, then pass the client's answer to `accept`. */
export const respondSecureChannel = Effect.fn("secureChannel.respond")(function* (
  input: HandshakeInput & { readonly clientHello: Uint8Array },
) {
  const parsed = parse(input.clientHello, CLIENT_HELLO, 1);
  if (parsed === undefined) return yield* malformed();
  const clientEphemeral = parsed[0]!;
  const keyAgreement = yield* KeyAgreement.KeyAgreement;
  const ephemeral = yield* keyAgreement
    .generateKeyPair(KeyAgreement.ecdhP256)
    .pipe(Effect.mapError(cryptoFailure));
  const unsigned = concat(
    Uint8Array.of(ENVIRONMENT_HELLO),
    field(yield* KeyAgreement.toBytes(ephemeral.publicKey).pipe(Effect.mapError(cryptoFailure))),
    field(input.identity.publicKey),
  );
  const offered = yield* mix(
    yield* mix(yield* startTranscript(input.context), input.clientHello),
    unsigned,
  );
  const signature = yield* input.identity.sign(concat(label("environment"), offered));
  const signed = yield* mix(offered, field(signature));

  const accept = Effect.fn("secureChannel.respond.accept")(function* (clientFinish: Uint8Array) {
    const finish = parse(clientFinish, CLIENT_FINISH, 2);
    if (finish === undefined) return yield* malformed();
    const clientPublicKey = finish[0]!;
    const clientSignature = finish[1]!;
    const identified = yield* mix(
      signed,
      concat(Uint8Array.of(CLIENT_FINISH), field(clientPublicKey)),
    );
    yield* requirePeer(input.verifyPeer, {
      publicKey: clientPublicKey,
      message: concat(label("client"), identified),
      signature: clientSignature,
    });
    return yield* makeChannel({
      role: "environment",
      secret: yield* sharedSecret(ephemeral.privateKey, clientEphemeral),
      transcript: yield* mix(identified, field(clientSignature)),
      peerPublicKey: clientPublicKey,
    }).pipe(Effect.mapError(cryptoFailure));
  });

  return { hello: concat(unsigned, field(signature)), accept };
});
