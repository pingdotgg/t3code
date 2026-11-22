const encoder = new TextEncoder();
const RECORD_SIZE = 4096;
// A single record carries the data, one padding delimiter byte and the 16 byte AES-GCM tag.
const MAX_PLAINTEXT_BYTES = RECORD_SIZE - 17;

export const fromBase64Url = (value: string) =>
  Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/")), (char) => char.charCodeAt(0));

const concat = (...parts: ReadonlyArray<Uint8Array>) => {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
};

const hkdf = async (
  salt: Uint8Array<ArrayBuffer>,
  secret: Uint8Array<ArrayBuffer>,
  info: Uint8Array<ArrayBuffer>,
  bytes: number,
) => {
  const key = await crypto.subtle.importKey("raw", secret, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(
    await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, bytes * 8),
  );
};

/**
 * Encrypts one message for a Web Push subscription (RFC 8291, aes128gcm). The
 * receiver's keys are the connector's `p256dh` public key and `auth` secret.
 * `ephemeral` and `salt` exist only so a test can pin the otherwise random inputs.
 */
export async function encryptWebPush(input: {
  readonly plaintext: Uint8Array<ArrayBuffer>;
  readonly p256dh: string;
  readonly auth: string;
  readonly ephemeral?: CryptoKeyPair;
  readonly salt?: Uint8Array<ArrayBuffer>;
}) {
  if (input.plaintext.length > MAX_PLAINTEXT_BYTES) throw new RangeError("Message too large");
  const receiverPublic = fromBase64Url(input.p256dh);
  const sender =
    input.ephemeral ??
    (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]));
  const senderPublic = new Uint8Array(await crypto.subtle.exportKey("raw", sender.publicKey));
  const shared = new Uint8Array(
    await crypto.subtle.deriveBits(
      {
        name: "ECDH",
        public: await crypto.subtle.importKey(
          "raw",
          receiverPublic,
          { name: "ECDH", namedCurve: "P-256" },
          false,
          [],
        ),
      },
      sender.privateKey,
      256,
    ),
  );
  const secret = await hkdf(
    fromBase64Url(input.auth),
    shared,
    concat(encoder.encode("WebPush: info\0"), receiverPublic, senderPublic),
    32,
  );
  const salt = input.salt ?? crypto.getRandomValues(new Uint8Array(16));
  const contentKey = await crypto.subtle.importKey(
    "raw",
    await hkdf(salt, secret, encoder.encode("Content-Encoding: aes128gcm\0"), 16),
    "AES-GCM",
    false,
    ["encrypt"],
  );
  const nonce = await hkdf(salt, secret, encoder.encode("Content-Encoding: nonce\0"), 12);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: nonce },
      contentKey,
      concat(input.plaintext, Uint8Array.of(2)),
    ),
  );
  const recordSize = new Uint8Array(4);
  new DataView(recordSize.buffer).setUint32(0, RECORD_SIZE);
  return concat(salt, recordSize, Uint8Array.of(senderPublic.length), senderPublic, ciphertext);
}
