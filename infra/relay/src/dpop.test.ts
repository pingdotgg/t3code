import * as NodeCrypto from "node:crypto";

import { describe, expect, it } from "@effect/vitest";
import {
  computeDpopAccessTokenHash,
  computeDpopJwkThumbprint,
  type DpopPublicJwk,
} from "@t3tools/shared/dpop";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import { verifyAndConsumeDpopProof } from "./dpop.ts";
import type * as DpopProofs from "./persistence/DpopProofs.ts";

function makeDpopProof(input: {
  readonly method: string;
  readonly url: string;
  readonly iat: number;
  readonly jti: string;
  readonly accessToken?: string;
}) {
  const { privateKey, publicKey } = NodeCrypto.generateKeyPairSync("ec", {
    namedCurve: "P-256",
  });
  const publicJwk = publicKey.export({ format: "jwk" }) as DpopPublicJwk;
  const header = Buffer.from(
    JSON.stringify({
      typ: "dpop+jwt",
      alg: "ES256",
      jwk: publicJwk,
    }),
  ).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      htm: input.method,
      htu: input.url,
      jti: input.jti,
      iat: input.iat,
      ...(input.accessToken ? { ath: computeDpopAccessTokenHash(input.accessToken) } : {}),
    }),
  ).toString("base64url");
  const signature = NodeCrypto.sign("sha256", Buffer.from(`${header}.${payload}`), {
    key: privateKey,
    dsaEncoding: "ieee-p1363",
  }).toString("base64url");
  return {
    proof: `${header}.${payload}.${signature}`,
    thumbprint: computeDpopJwkThumbprint(publicJwk),
  };
}

describe("verifyAndConsumeDpopProof", () => {
  it.effect("rejects replayed proofs after persistence consumes the jti once", () => {
    const now = DateTime.makeUnsafe("2026-05-25T12:00:00.000Z");
    const proof = makeDpopProof({
      method: "POST",
      url: "https://relay.example.com/v1/environments/env/connect",
      iat: Math.floor(now.epochMilliseconds / 1_000),
      jti: "proof-1",
    });
    const consumed = new Set<string>();
    const dpopProofs: DpopProofs.DpopProofReplayShape = {
      consume: (input) =>
        Effect.sync(() => {
          const key = `${input.thumbprint}:${input.jti}`;
          if (consumed.has(key)) {
            return false;
          }
          consumed.add(key);
          return true;
        }),
    };

    return Effect.gen(function* () {
      const first = yield* verifyAndConsumeDpopProof({
        proof: proof.proof,
        method: "POST",
        url: "https://relay.example.com/v1/environments/env/connect",
        expectedThumbprint: proof.thumbprint,
        now,
        dpopProofs,
      });
      const replay = yield* Effect.exit(
        verifyAndConsumeDpopProof({
          proof: proof.proof,
          method: "POST",
          url: "https://relay.example.com/v1/environments/env/connect",
          expectedThumbprint: proof.thumbprint,
          now,
          dpopProofs,
        }),
      );

      expect(first).toBe(proof.thumbprint);
      expect(replay._tag).toBe("Failure");
    });
  });

  it.effect("rejects proofs missing the expected access token hash", () => {
    const now = DateTime.makeUnsafe("2026-05-25T12:00:00.000Z");
    const proof = makeDpopProof({
      method: "POST",
      url: "https://relay.example.com/v1/environments/env/connect",
      iat: Math.floor(now.epochMilliseconds / 1_000),
      jti: "proof-1",
    });
    const dpopProofs: DpopProofs.DpopProofReplayShape = {
      consume: () => Effect.succeed(true),
    };

    return Effect.gen(function* () {
      const result = yield* Effect.exit(
        verifyAndConsumeDpopProof({
          proof: proof.proof,
          method: "POST",
          url: "https://relay.example.com/v1/environments/env/connect",
          expectedThumbprint: proof.thumbprint,
          expectedAccessToken: "clerk-access-token",
          now,
          dpopProofs,
        }),
      );

      expect(result._tag).toBe("Failure");
    });
  });

  it.effect("accepts unbound DPoP proofs when they are bound to the access token hash", () => {
    const now = DateTime.makeUnsafe("2026-05-25T12:00:00.000Z");
    const proof = makeDpopProof({
      method: "POST",
      url: "https://relay.example.com/v1/environments/env/status",
      iat: Math.floor(now.epochMilliseconds / 1_000),
      jti: "proof-status-1",
      accessToken: "clerk-access-token",
    });
    const consumed = new Set<string>();
    const dpopProofs: DpopProofs.DpopProofReplayShape = {
      consume: (input) =>
        Effect.sync(() => {
          const key = `${input.thumbprint}:${input.jti}`;
          if (consumed.has(key)) {
            return false;
          }
          consumed.add(key);
          return true;
        }),
    };

    return Effect.gen(function* () {
      const thumbprint = yield* verifyAndConsumeDpopProof({
        proof: proof.proof,
        method: "POST",
        url: "https://relay.example.com/v1/environments/env/status",
        expectedAccessToken: "clerk-access-token",
        now,
        dpopProofs,
      });
      const replay = yield* Effect.exit(
        verifyAndConsumeDpopProof({
          proof: proof.proof,
          method: "POST",
          url: "https://relay.example.com/v1/environments/env/status",
          expectedAccessToken: "clerk-access-token",
          now,
          dpopProofs,
        }),
      );

      expect(thumbprint).toBe(proof.thumbprint);
      expect(replay._tag).toBe("Failure");
    });
  });
});
