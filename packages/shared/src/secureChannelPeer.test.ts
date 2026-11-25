import { ed25519 } from "@noble/curves/ed25519";
import { describe, expect, it } from "@effect/vitest";

import { checkEnvironmentKey } from "./secureChannelPeer.ts";

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
