import { ed25519 } from "@noble/curves/ed25519";

export type EnvironmentKeyCheck = "trusted" | "key_changed" | "invalid";

/**
 * Checks the key an environment presents in the secure channel handshake: a raw 32-byte Ed25519
 * key that must equal `pinned` when one is pinned, and must have signed `message`.
 */
export function checkEnvironmentKey(input: {
  readonly pinned: Uint8Array | undefined;
  readonly publicKey: Uint8Array;
  readonly message: Uint8Array;
  readonly signature: Uint8Array;
}): EnvironmentKeyCheck {
  const { pinned, publicKey } = input;
  if (publicKey.length !== 32) return "invalid";
  if (pinned !== undefined && !(pinned.length === 32 && pinned.every((b, i) => b === publicKey[i])))
    return "key_changed";
  try {
    return ed25519.verify(input.signature, input.message, publicKey, { zip215: false })
      ? "trusted"
      : "invalid";
  } catch {
    return "invalid";
  }
}
