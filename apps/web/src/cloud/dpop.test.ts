import { verifyDpopProof } from "@t3tools/shared/dpop";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { decodeJwt, SignJWT } from "jose";
import { vi } from "vite-plus/test";

import {
  browserCryptoLayer,
  BrowserDpopKeyError,
  BrowserDpopProofError,
  createBrowserDpopProof,
  generateBrowserDpopKey,
  isBrowserDpopError,
} from "./dpop";

describe("browser DPoP proofs", () => {
  it.effect("signs relay resource proofs with an access-token hash", () =>
    Effect.gen(function* () {
      vi.stubGlobal("indexedDB", undefined);
      const proofKey = yield* generateBrowserDpopKey;
      const proof = yield* createBrowserDpopProof({
        method: "POST",
        url: "https://relay.example.test/v1/environments/env-1/connect?ignored=true",
        accessToken: "relay-access-token",
        proofKey,
      }).pipe(Effect.provide(browserCryptoLayer));
      const issuedAt = decodeJwt(proof.proof).iat;
      expect(issuedAt).toBeTypeOf("number");

      expect(
        verifyDpopProof({
          proof: proof.proof,
          method: "POST",
          url: "https://relay.example.test/v1/environments/env-1/connect",
          expectedThumbprint: proof.thumbprint,
          expectedAccessToken: "relay-access-token",
          nowEpochSeconds: issuedAt!,
        }),
      ).toMatchObject({ ok: true });
    }),
  );

  it.effect("preserves safe invalid URL context and the parser cause", () =>
    Effect.gen(function* () {
      const proofKey = yield* generateBrowserDpopKey;
      const url = "http://";
      const error = yield* createBrowserDpopProof({
        method: "POST",
        url,
        proofKey,
      }).pipe(Effect.provide(browserCryptoLayer), Effect.flip);

      expect(error).toBeInstanceOf(BrowserDpopProofError);
      expect(error).toMatchObject({
        operation: "normalize-url",
        method: "POST",
        requestTarget: "<invalid-url>",
        urlLength: url.length,
        thumbprint: proofKey.thumbprint,
      });
      expect(error).not.toHaveProperty("url");
      expect(error).not.toHaveProperty("normalizedUrl");
      expect(error.cause).toBeInstanceOf(Error);
      expect(error.message).not.toContain((error.cause as Error).message);
      expect(isBrowserDpopError(error)).toBe(true);
    }),
  );

  it.effect("redacts URL credentials, query, and fragment from proof errors", () =>
    Effect.gen(function* () {
      const proofKey = yield* generateBrowserDpopKey;
      const cause = new Error("signing failed");
      const sign = vi.spyOn(SignJWT.prototype, "sign").mockRejectedValueOnce(cause);
      const url = "https://user:password@example.com/oauth/token?access_token=secret#fragment";

      const error = yield* createBrowserDpopProof({
        method: "POST",
        url,
        proofKey,
      }).pipe(Effect.provide(browserCryptoLayer), Effect.flip);

      expect(error).toBeInstanceOf(BrowserDpopProofError);
      expect(error).toMatchObject({
        operation: "sign",
        method: "POST",
        requestTarget: "https://example.com/oauth/token",
        urlLength: url.length,
        thumbprint: proofKey.thumbprint,
        cause,
      });
      expect(error).not.toHaveProperty("url");
      expect(error).not.toHaveProperty("normalizedUrl");
      expect(error.message).not.toContain("user");
      expect(error.message).not.toContain("password");
      expect(error.message).not.toContain("access_token");
      expect(error.message).not.toContain("secret");
      expect(error.message).not.toContain("fragment");
      sign.mockRestore();
    }),
  );

  it.effect("preserves the browser crypto cause when key generation fails", () =>
    Effect.gen(function* () {
      const cause = new Error("browser crypto unavailable");
      const generateKey = vi
        .spyOn(globalThis.crypto.subtle, "generateKey")
        .mockRejectedValueOnce(cause);

      const error = yield* generateBrowserDpopKey.pipe(Effect.flip);

      expect(error).toBeInstanceOf(BrowserDpopKeyError);
      expect(error.operation).toBe("generate");
      expect(error.cause).toBe(cause);
      expect(error.message).not.toContain(cause.message);
      generateKey.mockRestore();
    }),
  );
});
