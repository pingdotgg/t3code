// @effect-diagnostics nodeBuiltinImport:off
/// <reference types="node" />

import * as NodeCrypto from "node:crypto";

function publicKeyFor(privateKey: Uint8Array) {
  const ecdh = NodeCrypto.createECDH("prime256v1");
  ecdh.setPrivateKey(privateKey);
  return ecdh.getPublicKey();
}

/**
 * Stands in for the T3NativeControls DPoP functions with Node's P-256.
 * Return it from a mocked `expo` `requireNativeModule`.
 */
export function createNodeDpopKeysModule() {
  return {
    generateDpopKey: () => {
      const ecdh = NodeCrypto.createECDH("prime256v1");
      const publicKey = ecdh.generateKeys();
      const privateKey = ecdh.getPrivateKey();
      return Promise.resolve(
        new Uint8Array(
          Buffer.concat([Buffer.alloc(32 - privateKey.length), privateKey, publicKey]),
        ),
      );
    },
    dpopKeyMatches: (privateKey: Uint8Array, publicKey: Uint8Array) =>
      Promise.resolve(publicKeyFor(privateKey).equals(publicKey)),
    signDpop: (privateKey: Uint8Array, signingInput: Uint8Array) => {
      const publicKey = publicKeyFor(privateKey);
      const key = NodeCrypto.createPrivateKey({
        format: "jwk",
        key: {
          kty: "EC",
          crv: "P-256",
          d: Buffer.from(privateKey).toString("base64url"),
          x: publicKey.subarray(1, 33).toString("base64url"),
          y: publicKey.subarray(33).toString("base64url"),
        },
      });
      // ieee-p1363 is the raw r‖s pair the native functions return.
      return Promise.resolve(
        new Uint8Array(NodeCrypto.sign("sha256", signingInput, { key, dsaEncoding: "ieee-p1363" })),
      );
    },
  };
}
