import * as NodeCrypto from "node:crypto";

import { vi } from "vitest";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { verifyDpopProof } from "@t3tools/shared/dpop";

import {
  createDpopProof,
  generateDpopProofKeyPair,
  loadOrCreateDpopProofKeyPair,
  mobileCryptoLayer,
} from "./dpop";

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
  digest: (algorithm: string, data: ArrayBuffer) =>
    Promise.resolve(
      new Uint8Array(NodeCrypto.createHash(algorithm).update(new Uint8Array(data)).digest()).buffer,
    ),
}));

const secureStore = new Map<string, string>();
vi.mock("expo-secure-store", () => ({
  getItemAsync: (key: string) => Promise.resolve(secureStore.get(key) ?? null),
  setItemAsync: (key: string, value: string) => {
    secureStore.set(key, value);
    return Promise.resolve();
  },
}));

function proofIat(proof: string): number {
  const payload = proof.split(".")[1];
  if (!payload) {
    throw new Error("Missing DPoP payload.");
  }
  const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
    readonly iat: number;
  };
  return decoded.iat;
}

function proofHtu(proof: string): string {
  const payload = proof.split(".")[1];
  if (!payload) {
    throw new Error("Missing DPoP payload.");
  }
  const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
    readonly htu: string;
  };
  return decoded.htu;
}

describe("mobile DPoP", () => {
  it.effect("persists and reuses the installation proof key", () =>
    Effect.gen(function* () {
      secureStore.clear();
      const first = yield* loadOrCreateDpopProofKeyPair();
      const second = yield* loadOrCreateDpopProofKeyPair();

      expect(second.thumbprint).toBe(first.thumbprint);
      expect(second.privateJwk).toEqual(first.privateJwk);
    }).pipe(Effect.provide(mobileCryptoLayer)),
  );

  it.effect("rejects malformed persisted proof keys", () =>
    Effect.gen(function* () {
      secureStore.set("t3code.cloud.dpop-proof-key", `{"kty":"EC","crv":"P-256","d":42}`);

      const error = yield* loadOrCreateDpopProofKeyPair().pipe(Effect.flip);

      expect(error.message).toBe("Stored DPoP proof key is invalid.");
    }).pipe(Effect.provide(mobileCryptoLayer)),
  );

  it.effect("signs connect and bootstrap proofs with the same ephemeral proof key", () =>
    Effect.gen(function* () {
      const proofKey = yield* generateDpopProofKeyPair();
      const connect = yield* createDpopProof({
        method: "POST",
        url: "https://relay.example.test/v1/environments/env-1/connect",
        accessToken: "clerk-token",
        proofKey,
      });
      const bootstrap = yield* createDpopProof({
        method: "POST",
        url: "https://desktop.example.test/api/auth/bootstrap/bearer",
        proofKey,
      });

      expect(connect.thumbprint).toBe(proofKey.thumbprint);
      expect(bootstrap.thumbprint).toBe(proofKey.thumbprint);
      expect(
        verifyDpopProof({
          proof: connect.proof,
          method: "POST",
          url: "https://relay.example.test/v1/environments/env-1/connect",
          expectedThumbprint: proofKey.thumbprint,
          expectedAccessToken: "clerk-token",
          nowEpochSeconds: proofIat(connect.proof),
        }),
      ).toMatchObject({ ok: true, thumbprint: proofKey.thumbprint });
      expect(
        verifyDpopProof({
          proof: bootstrap.proof,
          method: "POST",
          url: "https://desktop.example.test/api/auth/bootstrap/bearer",
          expectedThumbprint: proofKey.thumbprint,
          nowEpochSeconds: proofIat(bootstrap.proof),
        }),
      ).toMatchObject({ ok: true, thumbprint: proofKey.thumbprint });
    }).pipe(Effect.provide(mobileCryptoLayer)),
  );

  it.effect("signs DPoP proofs with RFC 9449 htu normalization", () =>
    Effect.gen(function* () {
      const proofKey = yield* generateDpopProofKeyPair();
      const proof = yield* createDpopProof({
        method: "POST",
        url: "https://relay.example.test/v1/environments/env-1/connect?debug=1#ignored",
        accessToken: "clerk-token",
        proofKey,
      });

      expect(proofHtu(proof.proof)).toBe(
        "https://relay.example.test/v1/environments/env-1/connect",
      );
      expect(
        verifyDpopProof({
          proof: proof.proof,
          method: "POST",
          url: "https://relay.example.test/v1/environments/env-1/connect?debug=1#ignored",
          expectedThumbprint: proofKey.thumbprint,
          expectedAccessToken: "clerk-token",
          nowEpochSeconds: proofIat(proof.proof),
        }),
      ).toMatchObject({ ok: true });
    }).pipe(Effect.provide(mobileCryptoLayer)),
  );
});
