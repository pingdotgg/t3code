import { ed25519 } from "@noble/curves/ed25519";
import { sha256 } from "@noble/hashes/sha2";
import { concatBytes } from "@noble/hashes/utils";
import { PAIRING_CODE_ALPHABET } from "@t3tools/contracts";

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

const DEVICE_CODE_V2_LABEL = "t3-connect-device-code-v2";

/**
 * The code a waiting T3 Connect device and its approver compare. It binds the device's proof key,
 * the environment's identity key and a nonce the environment chose after recording the device key,
 * so a match also proves the device saw the real environment key. 80 bits: a path attacker needs a
 * second preimage within the request's lifetime.
 */
export function connectDeviceVerificationCodeV2(input: {
  readonly proofKeyThumbprint: string;
  readonly environmentPublicKey: Uint8Array;
  readonly nonce: Uint8Array;
}): string {
  const encoder = new TextEncoder();
  const digest = sha256(
    concatBytes(
      encoder.encode(DEVICE_CODE_V2_LABEL),
      new Uint8Array([0]),
      encoder.encode(input.proofKeyThumbprint),
      new Uint8Array([0]),
      input.environmentPublicKey,
      input.nonce,
    ),
  );
  // The alphabet has 32 symbols, so each takes exactly 5 bits of the digest.
  let code = "";
  for (let index = 0; index < 16; index++) {
    const bit = index * 5;
    const window = (digest[bit >> 3]! << 8) | digest[(bit >> 3) + 1]!;
    code += PAIRING_CODE_ALPHABET[(window >> (11 - (bit & 7))) & 31]!;
  }
  return code.match(/.{4}/g)!.join("-");
}
