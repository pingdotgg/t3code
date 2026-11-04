import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Jwk from "effect/jose/Jwk";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import { decodeRelayJwt, RelayJwtError, signRelayJwt, verifyRelayJwt } from "./relayJwt.ts";

const Claims = Schema.Struct({ sub: Schema.String });

const keyPair = Effect.gen(function* () {
  const pair = yield* Jwk.generateKeyPair({ algorithm: "EdDSA" });
  const publicKey = yield* Jwk.importPublic(pair.publicKey, "EdDSA").pipe(
    Effect.flatMap((key) => Jwk.exportSpki(key, { format: "pem" })),
  );
  const privateKey = yield* Jwk.importPrivate(pair.privateKey, "EdDSA").pipe(
    Effect.flatMap((key) => Jwk.exportPkcs8(key, { format: "pem" })),
  );
  return { publicKey, privateKey: Redacted.value(privateKey) };
});

describe("relayJwt", () => {
  it.effect("verifies against the ambient clock and reports claim diagnostics", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(1_000_000);
      const keys = yield* keyPair;
      const token = yield* signRelayJwt({
        privateKey: keys.privateKey,
        typ: "test+jwt",
        payload: { sub: "user", iss: "relay", aud: "env", iat: 1_000, exp: 1_100 },
      });
      const verify = verifyRelayJwt(Claims, {
        publicKey: keys.publicKey,
        token,
        typ: "test+jwt",
        issuer: "relay",
        audience: "env",
      });

      expect(yield* verify).toEqual({ sub: "user" });
      expect((yield* decodeRelayJwt(token)).sub).toBe("user");

      yield* TestClock.adjust("161 seconds");
      const error = yield* Effect.flip(verify);
      expect(RelayJwtError.diagnosticCode(error)).toBe("ClaimValidationFailed.exp.expired");
      expect(error.message).toBe('Failed to verify relay JWT of type "test+jwt".');
    }).pipe(Effect.provide(NodeCrypto.layerSignature)),
  );
});
