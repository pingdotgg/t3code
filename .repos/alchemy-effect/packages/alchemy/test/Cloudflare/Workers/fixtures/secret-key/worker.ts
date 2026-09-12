import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

// Fixtures — generated once and checked in as constants (never generate key
// material at test time).
// 32 bytes 0x00..0x1f, base64-encoded (raw HMAC-SHA-256 key material).
const RAW_HMAC_KEY_BASE64 = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=";
// The same 32 bytes as an HMAC JSON Web Key.
const HMAC_JWK = {
  kty: "oct",
  k: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8",
  alg: "HS256",
};

/**
 * Fixture worker for `SecretKey.local.test.ts`.
 *
 * Uses the `Cloudflare.Workers.SecretKey` capability to attach two
 * `secret_key` bindings carrying the same HMAC key material in different
 * formats — `raw` (Redacted, exercising the unwrap-at-bind path) and `jwk`
 * (plain) — so a signature produced with one must verify with the other,
 * proving both format paths decode to the same CryptoKey.
 */
export default class SecretKeyWorker extends Cloudflare.Worker<SecretKeyWorker>()(
  "SecretKeyLocalWorker",
  {
    main: import.meta.url,
  },
  Effect.gen(function* () {
    // Attaches the bindings to this Worker AND returns deferred accessors.
    const rawKey = yield* Cloudflare.Workers.SecretKey("HMAC_KEY_RAW", {
      format: "raw",
      algorithm: { name: "HMAC", hash: "SHA-256" },
      usages: ["sign", "verify"],
      keyBase64: Redacted.make(RAW_HMAC_KEY_BASE64),
    });
    const jwkKey = yield* Cloudflare.Workers.SecretKey("HMAC_KEY_JWK", {
      format: "jwk",
      algorithm: { name: "HMAC", hash: "SHA-256" },
      usages: ["sign", "verify"],
      keyJwk: HMAC_JWK,
    });
    return {
      fetch: Effect.gen(function* () {
        const raw = yield* rawKey;
        const jwk = yield* jwkKey;
        const data = new TextEncoder().encode("hello");
        // Sign with the raw-format key, verify with the jwk-format key —
        // both bindings carry the same material, so this only succeeds if
        // both formats imported correctly.
        const signature = yield* Effect.promise(() =>
          crypto.subtle.sign("HMAC", raw, data),
        );
        const crossVerified = yield* Effect.promise(() =>
          crypto.subtle.verify("HMAC", jwk, signature, data),
        );
        return yield* HttpServerResponse.json({
          crossVerified,
          rawIsCryptoKey: raw instanceof CryptoKey,
          jwkIsCryptoKey: jwk instanceof CryptoKey,
          algorithm: raw.algorithm.name,
          usages: [...raw.usages].sort(),
          extractable: raw.extractable,
        });
      }),
    };
  }).pipe(Effect.provide(Cloudflare.Workers.SecretKeyBinding)),
) {}
