import * as NodeCrypto from "node:crypto";

import { assert, describe, it } from "@effect/vitest";

import {
  computeDpopAccessTokenHash,
  computeDpopJwkThumbprint,
  normalizeDpopHtu,
  redactDpopRequestTarget,
  type DpopPublicJwk,
  verifyDpopProof,
} from "./dpop.ts";

function signDpopProof(input: {
  readonly method: string;
  readonly url: string;
  readonly iat: number;
  readonly privateKey: NodeCrypto.KeyObject;
  readonly publicJwk: DpopPublicJwk | (DpopPublicJwk & { readonly d: string });
  readonly accessToken?: string;
}) {
  const header = Buffer.from(
    JSON.stringify({
      typ: "dpop+jwt",
      alg: "ES256",
      jwk: input.publicJwk,
    }),
  ).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      htm: input.method,
      htu: input.url,
      jti: "proof-1",
      iat: input.iat,
      ...(input.accessToken ? { ath: computeDpopAccessTokenHash(input.accessToken) } : {}),
    }),
  ).toString("base64url");
  const signature = NodeCrypto.sign("sha256", Buffer.from(`${header}.${payload}`), {
    key: input.privateKey,
    dsaEncoding: "ieee-p1363",
  }).toString("base64url");
  return `${header}.${payload}.${signature}`;
}

describe("redactDpopRequestTarget", () => {
  it("retains the scheme, host, port, and path while removing sensitive URL components", () => {
    const url = "https://user:password@example.com:8443/oauth/token?code=secret#fragment";

    assert.equal(redactDpopRequestTarget(url), "https://example.com:8443/oauth/token");
  });

  it("returns a safe sentinel for invalid input", () => {
    assert.equal(redactDpopRequestTarget("not a URL?token=secret"), "<invalid-url>");
  });
});

describe("verifyDpopProof", () => {
  const { privateKey, publicKey } = NodeCrypto.generateKeyPairSync("ec", {
    namedCurve: "P-256",
  });
  const publicJwk = publicKey.export({ format: "jwk" }) as DpopPublicJwk;
  const proof = signDpopProof({
    method: "POST",
    url: "https://example.com/oauth/token",
    iat: 100,
    privateKey,
    publicJwk,
  });

  it("verifies an ES256 DPoP proof and returns the RFC 7638 thumbprint", () => {
    const thumbprint = computeDpopJwkThumbprint(publicJwk);
    const result = verifyDpopProof({
      proof,
      method: "POST",
      url: "https://example.com/oauth/token",
      nowEpochSeconds: 101,
      expectedThumbprint: thumbprint,
    });

    if (!result.ok) {
      assert.fail(result.reason);
    }
    assert.equal(result.thumbprint, thumbprint);
    assert.equal(result.jti, "proof-1");
  });

  it("rejects malformed DPoP header and payload JSON", () => {
    const [header, payload, signature] = proof.split(".");
    if (!header || !payload || !signature) {
      assert.fail("Expected the test DPoP proof to use compact JWT format.");
    }
    const malformedJson = Buffer.from("{").toString("base64url");

    const malformedHeader = verifyDpopProof({
      proof: `${malformedJson}.${payload}.${signature}`,
      method: "POST",
      url: "https://example.com/oauth/token",
      nowEpochSeconds: 101,
    });
    if (malformedHeader.ok) {
      assert.fail("Expected malformed DPoP header JSON to fail.");
    }
    assert.equal(malformedHeader.reason, "Invalid DPoP JWT header.");

    const malformedPayload = verifyDpopProof({
      proof: `${header}.${malformedJson}.${signature}`,
      method: "POST",
      url: "https://example.com/oauth/token",
      nowEpochSeconds: 101,
    });
    if (malformedPayload.ok) {
      assert.fail("Expected malformed DPoP payload JSON to fail.");
    }
    assert.equal(malformedPayload.reason, "Invalid DPoP JWT payload.");
  });

  it("rejects method, URL, thumbprint, and time-window mismatches", () => {
    const thumbprint = computeDpopJwkThumbprint(publicJwk);
    assert.equal(
      verifyDpopProof({
        proof,
        method: "GET",
        url: "https://example.com/oauth/token",
        nowEpochSeconds: 101,
        expectedThumbprint: thumbprint,
      }).ok,
      false,
    );
    assert.equal(
      verifyDpopProof({
        proof,
        method: "POST",
        url: "https://example.com/other",
        nowEpochSeconds: 101,
        expectedThumbprint: thumbprint,
      }).ok,
      false,
    );
    assert.equal(
      verifyDpopProof({
        proof,
        method: "POST",
        url: "https://example.com/oauth/token",
        nowEpochSeconds: 101,
        expectedThumbprint: "other-thumbprint",
      }).ok,
      false,
    );
    assert.equal(
      verifyDpopProof({
        proof,
        method: "POST",
        url: "https://example.com/oauth/token",
        nowEpochSeconds: 1_000,
        expectedThumbprint: thumbprint,
      }).ok,
      false,
    );
  });

  it("requires the RFC 9449 access token hash when an access token is expected", () => {
    const thumbprint = computeDpopJwkThumbprint(publicJwk);
    const accessTokenProof = signDpopProof({
      method: "POST",
      url: "https://example.com/v1/environments/env/connect",
      iat: 100,
      privateKey,
      publicJwk,
      accessToken: "clerk-access-token",
    });

    assert.equal(
      verifyDpopProof({
        proof: accessTokenProof,
        method: "POST",
        url: "https://example.com/v1/environments/env/connect",
        nowEpochSeconds: 101,
        expectedThumbprint: thumbprint,
        expectedAccessToken: "clerk-access-token",
      }).ok,
      true,
    );

    const missingHash = verifyDpopProof({
      proof,
      method: "POST",
      url: "https://example.com/oauth/token",
      nowEpochSeconds: 101,
      expectedThumbprint: thumbprint,
      expectedAccessToken: "clerk-access-token",
    });
    if (missingHash.ok) {
      assert.fail("Expected DPoP proof without an access token hash to fail.");
    }
    assert.equal(missingHash.reason, "DPoP access token hash mismatch.");

    const mismatchedHash = verifyDpopProof({
      proof: accessTokenProof,
      method: "POST",
      url: "https://example.com/v1/environments/env/connect",
      nowEpochSeconds: 101,
      expectedThumbprint: thumbprint,
      expectedAccessToken: "other-access-token",
    });
    if (mismatchedHash.ok) {
      assert.fail("Expected DPoP proof with a mismatched access token hash to fail.");
    }
    assert.equal(mismatchedHash.reason, "DPoP access token hash mismatch.");
  });

  it("normalizes htu by excluding query and fragment components per RFC 9449", () => {
    assert.equal(
      normalizeDpopHtu("https://example.com/v1/environments/env/connect?foo=bar#frag"),
      "https://example.com/v1/environments/env/connect",
    );

    const thumbprint = computeDpopJwkThumbprint(publicJwk);
    const queryProof = signDpopProof({
      method: "POST",
      url: "https://example.com/v1/environments/env/connect",
      iat: 100,
      privateKey,
      publicJwk,
    });

    assert.equal(
      verifyDpopProof({
        proof: queryProof,
        method: "POST",
        url: "https://example.com/v1/environments/env/connect?foo=bar#frag",
        nowEpochSeconds: 101,
        expectedThumbprint: thumbprint,
      }).ok,
      true,
    );
  });

  it("rejects DPoP public JWK headers that expose private key material", () => {
    const thumbprint = computeDpopJwkThumbprint(publicJwk);
    const privateJwk = privateKey.export({ format: "jwk" }) as DpopPublicJwk & {
      readonly d: string;
    };
    const proofWithPrivateJwk = signDpopProof({
      method: "POST",
      url: "https://example.com/oauth/token",
      iat: 100,
      privateKey,
      publicJwk: privateJwk,
    });

    const result = verifyDpopProof({
      proof: proofWithPrivateJwk,
      method: "POST",
      url: "https://example.com/oauth/token",
      nowEpochSeconds: 101,
      expectedThumbprint: thumbprint,
    });

    if (result.ok) {
      assert.fail("Expected DPoP proof with private JWK material to fail.");
    }
    assert.equal(result.reason, "Invalid DPoP JWT header.");
  });
});
