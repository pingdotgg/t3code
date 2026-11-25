import { ed25519 } from "@noble/curves/ed25519";
import { describe, expect, it } from "@effect/vitest";

import { checkEnvironmentKey, connectDeviceVerificationCodeV2 } from "./secureChannelPeer.ts";

const privateKey = ed25519.utils.randomPrivateKey();
const publicKey = ed25519.getPublicKey(privateKey);
const message = new TextEncoder().encode("transcript");
const signature = ed25519.sign(message, privateKey);
const otherKey = ed25519.getPublicKey(ed25519.utils.randomPrivateKey());

describe("checkEnvironmentKey", () => {
  it("trusts a valid signature with no pin, or from the pinned key", () => {
    expect(checkEnvironmentKey({ pinned: undefined, publicKey, message, signature })).toBe(
      "trusted",
    );
    expect(checkEnvironmentKey({ pinned: publicKey.slice(), publicKey, message, signature })).toBe(
      "trusted",
    );
  });

  it("reports a key other than the pinned one, even with a valid signature", () => {
    expect(checkEnvironmentKey({ pinned: otherKey, publicKey, message, signature })).toBe(
      "key_changed",
    );
  });

  it("rejects a bad signature or a malformed key", () => {
    const tampered = signature.slice();
    tampered[0]! ^= 1;
    expect(
      checkEnvironmentKey({ pinned: undefined, publicKey, message, signature: tampered }),
    ).toBe("invalid");
    expect(
      checkEnvironmentKey({ pinned: undefined, publicKey: otherKey, message, signature }),
    ).toBe("invalid");
    expect(
      checkEnvironmentKey({
        pinned: undefined,
        publicKey: publicKey.subarray(1),
        message,
        signature,
      }),
    ).toBe("invalid");
  });
});

describe("connectDeviceVerificationCodeV2", () => {
  const input = {
    proofKeyThumbprint: "NzbLsXh8uDCcd-6MNwXF4W_7noWXFZAfHkxZsRGC9Xs",
    environmentPublicKey: Uint8Array.from({ length: 32 }, (_, index) => index),
    nonce: Uint8Array.from({ length: 16 }, (_, index) => 0xa0 + index),
  };

  it("matches the published vector", () => {
    // SHA-256("t3-connect-device-code-v2" 00 thumbprint 00 key nonce), first 80 bits, 5 per symbol.
    expect(connectDeviceVerificationCodeV2(input)).toBe("WMZE-4QK6-3299-QRQ8");
  });

  it("changes with the environment key or the nonce", () => {
    const code = connectDeviceVerificationCodeV2(input);
    const otherKey = input.environmentPublicKey.slice();
    otherKey[31] = 30;
    const otherNonce = input.nonce.slice();
    otherNonce[0] = 0;
    expect(connectDeviceVerificationCodeV2({ ...input, environmentPublicKey: otherKey })).not.toBe(
      code,
    );
    expect(connectDeviceVerificationCodeV2({ ...input, nonce: otherNonce })).not.toBe(code);
  });
});
