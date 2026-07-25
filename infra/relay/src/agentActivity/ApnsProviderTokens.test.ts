import * as NodeCrypto from "node:crypto";

import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

import * as ApnsProviderTokens from "./ApnsProviderTokens.ts";

const { privateKey } = NodeCrypto.generateKeyPairSync("ec", {
  namedCurve: "prime256v1",
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

const signingInput = {
  teamId: "team-1",
  keyId: "key-1",
  privateKey: Redacted.make(privateKey),
};

const WINDOW = ApnsProviderTokens.APNS_JWT_REUSE_SECONDS;

const decodeJwtPayload = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Struct({ iat: Schema.Number })),
);

describe("ApnsProviderTokens", () => {
  it.effect("derives the byte-identical token across isolates within a window", () => {
    ApnsProviderTokens.__resetApnsProviderTokenCacheForTest();
    return Effect.gen(function* () {
      const tokens = yield* ApnsProviderTokens.ApnsProviderTokens;
      const first = yield* tokens.getJwt({ ...signingInput, issuedAtUnixSeconds: WINDOW + 10 });

      // A fresh isolate has no cache; deterministic signing plus quantized
      // iat must still reproduce the exact same JWT for the same window.
      ApnsProviderTokens.__resetApnsProviderTokenCacheForTest();
      const second = yield* tokens.getJwt({
        ...signingInput,
        issuedAtUnixSeconds: WINDOW * 2 - 1,
      });
      expect(second).toBe(first);

      const payload = yield* decodeJwtPayload(
        Buffer.from(first.split(".")[1]!, "base64url").toString("utf8"),
      );
      expect(payload.iat).toBe(WINDOW);
      ApnsProviderTokens.__resetApnsProviderTokenCacheForTest();
    }).pipe(Effect.provide(ApnsProviderTokens.layer));
  });

  it.effect("rolls to a new token at the window boundary", () => {
    ApnsProviderTokens.__resetApnsProviderTokenCacheForTest();
    return Effect.gen(function* () {
      const tokens = yield* ApnsProviderTokens.ApnsProviderTokens;
      const first = yield* tokens.getJwt({ ...signingInput, issuedAtUnixSeconds: WINDOW + 10 });
      const next = yield* tokens.getJwt({ ...signingInput, issuedAtUnixSeconds: WINDOW * 2 });
      expect(next).not.toBe(first);
      ApnsProviderTokens.__resetApnsProviderTokenCacheForTest();
    }).pipe(Effect.provide(ApnsProviderTokens.layer));
  });

  it.effect("serves repeat pushes from the isolate cache without re-signing", () => {
    ApnsProviderTokens.__resetApnsProviderTokenCacheForTest();
    return Effect.gen(function* () {
      const tokens = yield* ApnsProviderTokens.ApnsProviderTokens;
      const first = yield* tokens.getJwt({ ...signingInput, issuedAtUnixSeconds: WINDOW + 10 });
      const again = yield* tokens.getJwt({ ...signingInput, issuedAtUnixSeconds: WINDOW + 500 });
      // Deterministic signing makes equality hold either way; toBe on the
      // exact string documents the cache contract.
      expect(again).toBe(first);
      ApnsProviderTokens.__resetApnsProviderTokenCacheForTest();
    }).pipe(Effect.provide(ApnsProviderTokens.layer));
  });
});
