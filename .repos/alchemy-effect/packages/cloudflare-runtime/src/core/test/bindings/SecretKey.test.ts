import { expect, layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SecretKey from "../../bindings/SecretKey.ts";
import { localRuntimeLayer, startTestWorker } from "../helpers/runtime.ts";

// Fixtures — generated once and checked in as constants.
// 32 bytes 0x00..0x1f, base64-encoded (raw HMAC key material).
const RAW_HMAC_KEY_BASE64 = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=";
// The same 32 bytes as an HMAC JSON Web Key.
const HMAC_JWK = {
  kty: "oct",
  k: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8",
  alg: "HS256",
};
// One ECDSA P-256 key pair: private key as base64 PKCS#8 DER, public key
// as base64 SPKI DER.
const ECDSA_PKCS8_BASE64 =
  "MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgUD1VtKCkONQaQr1Qp9S53Uz2EmQt7QFGYaF/b5Jwu9ChRANCAAQ5xOyH5ZyM1KfBQkXECpkOPqL5YpvodylZAK0ImacZZtygz4VeePFNh5GNv60cok0HTo70qM87YK0rlBMztWqE";
const ECDSA_SPKI_BASE64 =
  "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEOcTsh+WcjNSnwUJFxAqZDj6i+WKb6HcpWQCtCJmnGWbcoM+FXnjxTYeRjb+tHKJNB06O9KjPO2CtK5QTM7VqhA==";

const HMAC_SCRIPT = `
export default {
  async fetch(_request, env) {
    const data = new TextEncoder().encode("hello");
    const signature = await crypto.subtle.sign("HMAC", env.KEY, data);
    const verified = await crypto.subtle.verify("HMAC", env.KEY, signature, data);
    return Response.json({
      verified,
      isCryptoKey: env.KEY instanceof CryptoKey,
      algorithm: env.KEY.algorithm.name,
      usages: [...env.KEY.usages].sort(),
      extractable: env.KEY.extractable,
    });
  },
};
`;

const ECDSA_SCRIPT = `
export default {
  async fetch(_request, env) {
    const data = new TextEncoder().encode("hello");
    const algorithm = { name: "ECDSA", hash: "SHA-256" };
    const signature = await crypto.subtle.sign(algorithm, env.PRIVATE_KEY, data);
    const verified = await crypto.subtle.verify(algorithm, env.PUBLIC_KEY, signature, data);
    return Response.json({
      verified,
      privateType: env.PRIVATE_KEY.type,
      publicType: env.PUBLIC_KEY.type,
    });
  },
};
`;

layer(localRuntimeLayer)("SecretKey binding", (it) => {
  it.effect("exposes a raw-format HMAC CryptoKey that signs and verifies", () =>
    Effect.gen(function* () {
      const { fetchJson } = yield* startTestWorker({
        name: "secret-key-raw",
        compatibilityDate: "2026-03-10",
        compatibilityFlags: [],
        bindings: [
          SecretKey.local({
            binding: "KEY",
            format: "raw",
            algorithm: { name: "HMAC", hash: "SHA-256" },
            usages: ["sign", "verify"],
            keyBase64: RAW_HMAC_KEY_BASE64,
          }),
        ],
        modules: [{ name: "main.js", type: "ESModule", content: HMAC_SCRIPT }],
      });

      const body = yield* fetchJson<{
        verified: boolean;
        isCryptoKey: boolean;
        algorithm: string;
        usages: Array<string>;
        extractable: boolean;
      }>("/");
      expect(body.verified).toBe(true);
      expect(body.isCryptoKey).toBe(true);
      expect(body.algorithm).toBe("HMAC");
      expect(body.usages).toEqual(["sign", "verify"]);
      expect(body.extractable).toBe(false);
    }),
  );

  it.effect("exposes a jwk-format HMAC CryptoKey", () =>
    Effect.gen(function* () {
      const { fetchJson } = yield* startTestWorker({
        name: "secret-key-jwk",
        compatibilityDate: "2026-03-10",
        compatibilityFlags: [],
        bindings: [
          SecretKey.local({
            binding: "KEY",
            format: "jwk",
            algorithm: { name: "HMAC", hash: "SHA-256" },
            usages: ["sign", "verify"],
            keyJwk: HMAC_JWK,
          }),
        ],
        modules: [{ name: "main.js", type: "ESModule", content: HMAC_SCRIPT }],
      });

      const body = yield* fetchJson<{
        verified: boolean;
        isCryptoKey: boolean;
      }>("/");
      expect(body.verified).toBe(true);
      expect(body.isCryptoKey).toBe(true);
    }),
  );

  it.effect("exposes pkcs8 private and spki public ECDSA keys", () =>
    Effect.gen(function* () {
      const { fetchJson } = yield* startTestWorker({
        name: "secret-key-ecdsa",
        compatibilityDate: "2026-03-10",
        compatibilityFlags: [],
        bindings: [
          SecretKey.local({
            binding: "PRIVATE_KEY",
            format: "pkcs8",
            algorithm: { name: "ECDSA", namedCurve: "P-256" },
            usages: ["sign"],
            keyBase64: ECDSA_PKCS8_BASE64,
          }),
          SecretKey.local({
            binding: "PUBLIC_KEY",
            format: "spki",
            algorithm: { name: "ECDSA", namedCurve: "P-256" },
            usages: ["verify"],
            keyBase64: ECDSA_SPKI_BASE64,
          }),
        ],
        modules: [{ name: "main.js", type: "ESModule", content: ECDSA_SCRIPT }],
      });

      const body = yield* fetchJson<{
        verified: boolean;
        privateType: string;
        publicType: string;
      }>("/");
      expect(body.verified).toBe(true);
      expect(body.privateType).toBe("private");
      expect(body.publicType).toBe("public");
    }),
  );

  it.effect("fails with a ConfigError when key material is missing", () =>
    Effect.gen(function* () {
      const error = yield* startTestWorker({
        name: "secret-key-missing-material",
        compatibilityDate: "2026-03-10",
        compatibilityFlags: [],
        bindings: [
          SecretKey.local({
            binding: "KEY",
            format: "raw",
            algorithm: { name: "HMAC", hash: "SHA-256" },
            usages: ["sign"],
          }),
        ],
        modules: [{ name: "main.js", type: "ESModule", content: HMAC_SCRIPT }],
      }).pipe(Effect.flip);
      expect(error._tag).toBe("ConfigError");
      expect(error.subtag).toBe("MissingSecretKeyMaterial");
    }),
  );

  it.effect("fails with a ConfigError on an unsupported format", () =>
    Effect.gen(function* () {
      const error = yield* startTestWorker({
        name: "secret-key-bad-format",
        compatibilityDate: "2026-03-10",
        compatibilityFlags: [],
        bindings: [
          SecretKey.local({
            binding: "KEY",
            format: "der",
            algorithm: { name: "HMAC", hash: "SHA-256" },
            usages: ["sign"],
            keyBase64: RAW_HMAC_KEY_BASE64,
          }),
        ],
        modules: [{ name: "main.js", type: "ESModule", content: HMAC_SCRIPT }],
      }).pipe(Effect.flip);
      expect(error._tag).toBe("ConfigError");
      expect(error.subtag).toBe("UnsupportedSecretKeyFormat");
    }),
  );

  it.effect("fails with a ConfigError on an invalid usage", () =>
    Effect.gen(function* () {
      const error = yield* startTestWorker({
        name: "secret-key-bad-usage",
        compatibilityDate: "2026-03-10",
        compatibilityFlags: [],
        bindings: [
          SecretKey.local({
            binding: "KEY",
            format: "raw",
            algorithm: { name: "HMAC", hash: "SHA-256" },
            usages: ["sign", "launch"],
            keyBase64: RAW_HMAC_KEY_BASE64,
          }),
        ],
        modules: [{ name: "main.js", type: "ESModule", content: HMAC_SCRIPT }],
      }).pipe(Effect.flip);
      expect(error._tag).toBe("ConfigError");
      expect(error.subtag).toBe("InvalidSecretKeyUsage");
    }),
  );
});
