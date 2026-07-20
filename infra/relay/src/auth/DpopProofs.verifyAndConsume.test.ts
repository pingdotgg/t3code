import * as NodeCrypto from "node:crypto";

import { describe, expect, it } from "@effect/vitest";
import {
  computeDpopAccessTokenHash,
  computeDpopJwkThumbprint,
  type DpopPublicJwk,
} from "@t3tools/shared/dpop";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as RelayDb from "../db.ts";
import { relayDpopProofs } from "../persistence/schema.ts";
import * as DpopProofs from "./DpopProofs.ts";

interface DpopProofInsertValues {
  readonly thumbprint: string;
  readonly jti: string;
  readonly iat: number;
  readonly expiresAt: string;
  readonly createdAt: string;
}

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

function layer(
  insert: (
    values: DpopProofInsertValues,
  ) => Effect.Effect<ReadonlyArray<{ readonly jti: string }>, { _tag: string }>,
) {
  const fakeDb = {
    insert: (table: unknown) => {
      expect(table).toBe(relayDpopProofs);
      return {
        values: (values: DpopProofInsertValues) => ({
          onConflictDoNothing: () => ({
            returning: (selection: unknown) => {
              expect(selection).toBeDefined();
              return insert(values);
            },
          }),
        }),
      };
    },
  } as unknown as RelayDb.RelayDb["Service"];
  return DpopProofs.layer.pipe(Layer.provide(Layer.succeed(RelayDb.RelayDb, fakeDb)));
}

function consumeEachProofOnce() {
  const consumed = new Set<string>();
  return (values: DpopProofInsertValues) =>
    Effect.sync(() => {
      const key = `${values.thumbprint}:${values.jti}`;
      if (consumed.has(key)) {
        return [];
      }
      consumed.add(key);
      return [{ jti: values.jti }];
    });
}

describe("DpopProofReplay.verifyAndConsume", () => {
  it.effect("rejects replayed proofs after persistence consumes the jti once", () => {
    const now = DateTime.makeUnsafe("2026-05-25T12:00:00.000Z");
    const proof = makeDpopProof({
      method: "POST",
      url: "https://relay.example.com/v1/environments/env/connect",
      iat: Math.floor(now.epochMilliseconds / 1_000),
      jti: "proof-1",
    });

    return Effect.gen(function* () {
      const replay = yield* DpopProofs.DpopProofReplay;
      const first = yield* replay.verifyAndConsume({
        proof: proof.proof,
        method: "POST",
        url: "https://relay.example.com/v1/environments/env/connect",
        expectedThumbprint: proof.thumbprint,
        now,
      });
      const second = yield* Effect.exit(
        replay.verifyAndConsume({
          proof: proof.proof,
          method: "POST",
          url: "https://relay.example.com/v1/environments/env/connect",
          expectedThumbprint: proof.thumbprint,
          now,
        }),
      );

      expect(first).toBe(proof.thumbprint);
      expect(second._tag).toBe("Failure");
    }).pipe(Effect.provide(layer(consumeEachProofOnce())));
  });

  it.effect("rejects proofs missing the expected access token hash", () => {
    const now = DateTime.makeUnsafe("2026-05-25T12:00:00.000Z");
    const proof = makeDpopProof({
      method: "POST",
      url: "https://relay.example.com/v1/environments/env/connect",
      iat: Math.floor(now.epochMilliseconds / 1_000),
      jti: "proof-1",
    });

    return Effect.gen(function* () {
      const replay = yield* DpopProofs.DpopProofReplay;
      const result = yield* Effect.exit(
        replay.verifyAndConsume({
          proof: proof.proof,
          method: "POST",
          url: "https://relay.example.com/v1/environments/env/connect",
          expectedThumbprint: proof.thumbprint,
          expectedAccessToken: "clerk-access-token",
          now,
        }),
      );

      expect(result._tag).toBe("Failure");
    }).pipe(Effect.provide(layer(() => Effect.die("unexpected DPoP replay persistence"))));
  });

  it.effect("preserves replay persistence failures", () => {
    const now = DateTime.makeUnsafe("2026-05-25T12:00:00.000Z");
    const proof = makeDpopProof({
      method: "POST",
      url: "https://relay.example.com/v1/environments/env/connect",
      iat: Math.floor(now.epochMilliseconds / 1_000),
      jti: "proof-persistence-failure",
    });
    const cause = { _tag: "DatabaseUnavailable" } as const;

    return Effect.gen(function* () {
      const replay = yield* DpopProofs.DpopProofReplay;
      const error = yield* Effect.flip(
        replay.verifyAndConsume({
          proof: proof.proof,
          method: "POST",
          url: "https://relay.example.com/v1/environments/env/connect",
          expectedThumbprint: proof.thumbprint,
          now,
        }),
      );

      expect(error).toMatchObject({
        _tag: "DpopProofReplayPersistenceError",
        operation: "consume",
        thumbprint: proof.thumbprint,
        jti: "proof-persistence-failure",
        iat: Math.floor(now.epochMilliseconds / 1_000),
      });
      expect(error.cause).toBe(cause);
      expect(error).not.toHaveProperty("proof");
    }).pipe(Effect.provide(layer(() => Effect.fail(cause))));
  });

  it.effect("accepts proofs bound to the access token hash", () => {
    const now = DateTime.makeUnsafe("2026-05-25T12:00:00.000Z");
    const proof = makeDpopProof({
      method: "POST",
      url: "https://relay.example.com/v1/environments/env/status",
      iat: Math.floor(now.epochMilliseconds / 1_000),
      jti: "proof-status-1",
      accessToken: "clerk-access-token",
    });

    return Effect.gen(function* () {
      const replay = yield* DpopProofs.DpopProofReplay;
      const thumbprint = yield* replay.verifyAndConsume({
        proof: proof.proof,
        method: "POST",
        url: "https://relay.example.com/v1/environments/env/status",
        expectedAccessToken: "clerk-access-token",
        now,
      });
      const second = yield* Effect.exit(
        replay.verifyAndConsume({
          proof: proof.proof,
          method: "POST",
          url: "https://relay.example.com/v1/environments/env/status",
          expectedAccessToken: "clerk-access-token",
          now,
        }),
      );

      expect(thumbprint).toBe(proof.thumbprint);
      expect(second._tag).toBe("Failure");
    }).pipe(Effect.provide(layer(consumeEachProofOnce())));
  });
});
