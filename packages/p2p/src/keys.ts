/// <reference path="./holepunch.d.ts" />
import z32 from "z32";

/** Byte length of the secret seed a DHT keypair is derived from. */
export const P2P_SEED_BYTES = 32;

/** Byte length of a DHT public key, the dialable address of an endpoint. */
export const P2P_PUBLIC_KEY_BYTES = 32;

/** Encodes a DHT public key into its shareable z-base-32 address form. */
export const encodeP2pPublicKey = (publicKey: Uint8Array): string => z32.encode(publicKey);

/**
 * Decodes a shared z-base-32 address back into public key bytes. Returns null
 * for anything that is not a well-formed key so callers can surface their own
 * typed error.
 */
export const decodeP2pPublicKey = (value: string): Uint8Array | null => {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }
  try {
    const decoded = z32.decode(trimmed);
    return decoded.length === P2P_PUBLIC_KEY_BYTES ? Uint8Array.from(decoded) : null;
  } catch {
    return null;
  }
};

export const isValidP2pPublicKey = (value: string): boolean => decodeP2pPublicKey(value) !== null;
