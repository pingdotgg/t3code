/// <reference types="node" />

import * as NodeCrypto from "node:crypto";

import { vi } from "vite-plus/test";
import { describe, expect, it } from "@effect/vitest";
import { DpopProof } from "@t3tools/client-runtime/relay";
import { verifyDpopProof } from "@t3tools/shared/dpop";
import * as Digest from "effect/crypto/Digest";
import * as Effect from "effect/Effect";

import { loadOrCreateDpopProofKeyPair, loadOrCreateProofKey } from "./dpop";
import * as Dpop from "./dpop";

vi.mock("expo-crypto", () => ({
  CryptoDigestAlgorithm: {
    SHA1: "SHA-1",
    SHA256: "SHA-256",
    SHA384: "SHA-384",
    SHA512: "SHA-512",
  },
  getRandomBytes: (byteCount: number) => new Uint8Array(NodeCrypto.randomBytes(byteCount)),
  getRandomBytesAsync: (byteCount: number) =>
    Promise.resolve(new Uint8Array(NodeCrypto.randomBytes(byteCount))),
  digest: (algorithm: string, data: unknown) => {
    if (!(data instanceof Uint8Array)) {
      return Promise.reject(new TypeError("expo-crypto digest data must be a typed array."));
    }
    return Promise.resolve(
      new Uint8Array(NodeCrypto.createHash(algorithm).update(data).digest()).buffer,
    );
  },
}));

const secureStore = new Map<string, string>();
vi.mock("expo-secure-store", () => ({
  getItemAsync: (key: string) => Promise.resolve(secureStore.get(key) ?? null),
  setItemAsync: (key: string, value: string) => {
    secureStore.set(key, value);
    return Promise.resolve();
  },
}));

function publicKeyFor(privateKey: Uint8Array) {
  const ecdh = NodeCrypto.createECDH("prime256v1");
  ecdh.setPrivateKey(privateKey);
  return ecdh.getPublicKey();
}

// The native module's contract, backed by Node's P-256.
const nativeDpopKeys = {
  generateDpopKey: () => {
    const ecdh = NodeCrypto.createECDH("prime256v1");
    const publicKey = ecdh.generateKeys();
    const privateKey = ecdh.getPrivateKey();
    return Promise.resolve(
      new Uint8Array(Buffer.concat([Buffer.alloc(32 - privateKey.length), privateKey, publicKey])),
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
    return Promise.resolve(
      new Uint8Array(NodeCrypto.sign("sha256", signingInput, { key, dsaEncoding: "ieee-p1363" })),
    );
  },
};
vi.mock("expo", () => ({ requireNativeModule: () => nativeDpopKeys }));

describe("mobile DPoP", () => {
  it.effect("passes typed-array digest input through the Expo Crypto adapter", () =>
    Effect.gen(function* () {
      const digest = yield* Digest.Digest;
      const hex = yield* digest.digestHex(Digest.sha256, new TextEncoder().encode("typed-array"));

      expect(hex).toBe(NodeCrypto.createHash("sha256").update("typed-array").digest("hex"));
    }).pipe(Effect.provide(Dpop.layer)),
  );

  it.effect("persists and reuses the installation proof key", () =>
    Effect.gen(function* () {
      secureStore.clear();
      const first = yield* loadOrCreateDpopProofKeyPair();
      const second = yield* loadOrCreateDpopProofKeyPair();

      expect(second.privateJwk).toEqual(first.privateJwk);
    }).pipe(Effect.provide(Dpop.layer)),
  );

  it.effect("rejects malformed persisted proof keys", () =>
    Effect.gen(function* () {
      secureStore.set("t3code.cloud.dpop-proof-key", `{"kty":"EC","crv":"P-256","d":42}`);

      const error = yield* loadOrCreateDpopProofKeyPair().pipe(Effect.flip);

      expect(error.message).toBe("Stored DPoP proof key is invalid.");
    }).pipe(Effect.provide(Dpop.layer)),
  );

  it.effect("rejects a persisted key whose public half belongs to another key", () =>
    Effect.gen(function* () {
      secureStore.clear();
      const { privateJwk } = yield* loadOrCreateDpopProofKeyPair();
      secureStore.clear();
      const other = yield* loadOrCreateDpopProofKeyPair();
      secureStore.set(
        "t3code.cloud.dpop-proof-key",
        JSON.stringify({ ...privateJwk, x: other.publicJwk.x, y: other.publicJwk.y }),
      );

      const error = yield* loadOrCreateDpopProofKeyPair().pipe(Effect.flip);

      expect(error.message).toBe("Stored DPoP proof key is invalid.");
    }),
  );

  it.effect("signs proofs that the relay's verifier accepts", () =>
    Effect.gen(function* () {
      secureStore.clear();
      const key = yield* loadOrCreateProofKey();
      const url = "https://relay.t3.codes/v1/environments";
      const proof = yield* DpopProof.createProof({
        method: "GET",
        url,
        accessToken: "access-token",
        key,
      });

      // The proof's `iat` comes from the TestClock, which starts at 0.
      expect(
        verifyDpopProof({
          proof,
          method: "GET",
          url,
          nowEpochSeconds: 0,
          expectedAccessToken: "access-token",
        }),
      ).toMatchObject({ ok: true });
    }).pipe(Effect.provide(Dpop.layer)),
  );
});
