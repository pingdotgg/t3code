import {
  createCipheriv,
  createDecipheriv,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  type KeyObject,
} from "node:crypto";

export interface PreviewBootstrapKeyPair {
  readonly publicKey: string;
  readonly privateKey: KeyObject;
}

export interface PreviewBootstrapCryptoContext {
  readonly environmentId: string;
  readonly origin: string;
  readonly challenge: string;
  readonly clientPublicKey: string;
  readonly serverPublicKey: string;
}

export interface PreviewBootstrapCiphertext {
  readonly nonce: string;
  readonly ciphertext: string;
  readonly tag: string;
}

export type PreviewBootstrapDirection = "request" | "response";

const MAX_PUBLIC_KEY_BYTES = 512;
const MAX_CIPHERTEXT_BYTES = 1_536;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

const encode = (value: Buffer): string => value.toString("base64url");

const decode = (value: string, maxBytes: number): Buffer => {
  if (
    value.length === 0 ||
    value.length > Math.ceil((maxBytes * 4) / 3) ||
    !BASE64URL.test(value)
  ) {
    throw new Error("Invalid preview bootstrap ciphertext.");
  }
  const decoded = Buffer.from(value, "base64url");
  if (decoded.length > maxBytes || encode(decoded) !== value) {
    throw new Error("Invalid preview bootstrap ciphertext.");
  }
  return decoded;
};

const validateContext = (context: PreviewBootstrapCryptoContext): void => {
  if (
    !context.environmentId ||
    !context.challenge ||
    !context.clientPublicKey ||
    !context.serverPublicKey ||
    new URL(context.origin).origin !== context.origin
  ) {
    throw new Error("Invalid preview bootstrap context.");
  }
};

const contextBytes = (
  context: PreviewBootstrapCryptoContext,
  direction: PreviewBootstrapDirection,
): Buffer => {
  validateContext(context);
  return Buffer.from(
    JSON.stringify([
      "t3-preview-bootstrap-v1",
      direction,
      context.environmentId,
      context.origin,
      context.challenge,
      context.clientPublicKey,
      context.serverPublicKey,
    ]),
    "utf8",
  );
};

const deriveKey = (
  privateKey: KeyObject,
  peerPublicKey: string,
  context: PreviewBootstrapCryptoContext,
  direction: PreviewBootstrapDirection,
): Buffer => {
  const publicKeyBytes = decode(peerPublicKey, MAX_PUBLIC_KEY_BYTES);
  const peerKey = createPublicKey({
    key: publicKeyBytes,
    format: "der",
    type: "spki",
  });
  const secret = diffieHellman({ privateKey, publicKey: peerKey });
  try {
    const info = contextBytes(context, direction);
    const salt = Buffer.from(`t3-preview-bootstrap-v1\u0000${context.challenge}`, "utf8");
    return Buffer.from(hkdfSync("sha256", secret, salt, info, 32));
  } finally {
    secret.fill(0);
  }
};

export const createPreviewBootstrapKeyPair = (): PreviewBootstrapKeyPair => {
  const pair = generateKeyPairSync("x25519");
  return {
    publicKey: encode(pair.publicKey.export({ format: "der", type: "spki" })),
    privateKey: pair.privateKey,
  };
};

export const sealPreviewBootstrapPayload = (input: {
  readonly privateKey: KeyObject;
  readonly peerPublicKey: string;
  readonly context: PreviewBootstrapCryptoContext;
  readonly direction: PreviewBootstrapDirection;
  readonly plaintext: string;
}): PreviewBootstrapCiphertext => {
  const key = deriveKey(input.privateKey, input.peerPublicKey, input.context, input.direction);
  try {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    cipher.setAAD(contextBytes(input.context, input.direction));
    const ciphertext = Buffer.concat([cipher.update(input.plaintext, "utf8"), cipher.final()]);
    return {
      nonce: encode(nonce),
      ciphertext: encode(ciphertext),
      tag: encode(cipher.getAuthTag()),
    };
  } finally {
    key.fill(0);
  }
};

export const openPreviewBootstrapPayload = (input: {
  readonly privateKey: KeyObject;
  readonly peerPublicKey: string;
  readonly context: PreviewBootstrapCryptoContext;
  readonly direction: PreviewBootstrapDirection;
  readonly encrypted: PreviewBootstrapCiphertext;
}): string => {
  const nonce = decode(input.encrypted.nonce, 12);
  const ciphertext = decode(input.encrypted.ciphertext, MAX_CIPHERTEXT_BYTES);
  const tag = decode(input.encrypted.tag, 16);
  if (nonce.length !== 12 || tag.length !== 16 || ciphertext.length === 0) {
    throw new Error("Invalid preview bootstrap ciphertext.");
  }

  const key = deriveKey(input.privateKey, input.peerPublicKey, input.context, input.direction);
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, nonce);
    decipher.setAAD(contextBytes(input.context, input.direction));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } finally {
    key.fill(0);
  }
};
