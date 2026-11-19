// @effect-diagnostics-next-line nodeBuiltinImport:off -- Verifies signatures with node's own verifier.
import * as NodeCrypto from "node:crypto";

import { describe, expect, it } from "vite-plus/test";

import {
  APNS_JWT_REUSE_SECONDS,
  makeApnsProviderTokenCache,
  signApnsProviderJwt,
} from "./apnsProviderToken.ts";

const { privateKey, publicKey } = NodeCrypto.generateKeyPairSync("ec", {
  namedCurve: "prime256v1",
});
const privatePem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const credentials = { teamId: "TEAM123456", keyId: "KEY1234567", privateKey: privatePem };

const decodePart = (part: string) =>
  JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<string, unknown>;

describe("signApnsProviderJwt", () => {
  it("emits an ES256 token APNs can verify with the key's public half", () => {
    const jwt = signApnsProviderJwt({ ...credentials, issuedAtUnixSeconds: 1_800_000_000 });
    const [header, payload, signature] = jwt.split(".") as [string, string, string];
    expect(decodePart(header)).toEqual({ alg: "ES256", kid: "KEY1234567" });
    expect(decodePart(payload)).toEqual({ iss: "TEAM123456", iat: 1_800_000_000 });
    expect(
      NodeCrypto.verify(
        "sha256",
        Buffer.from(`${header}.${payload}`),
        { key: publicKey, dsaEncoding: "ieee-p1363" },
        Buffer.from(signature, "base64url"),
      ),
    ).toBe(true);
  });

  it("accepts keys whose newlines were escaped by an env file", () => {
    const escaped = privatePem.replaceAll("\n", "\\n");
    expect(() =>
      signApnsProviderJwt({ ...credentials, privateKey: escaped, issuedAtUnixSeconds: 1 }),
    ).not.toThrow();
  });
});

describe("makeApnsProviderTokenCache", () => {
  it("reuses one token for the reuse window and re-signs after it", () => {
    const cache = makeApnsProviderTokenCache();
    const first = cache.getJwt(credentials, 1_800_000_000);
    expect(cache.getJwt(credentials, 1_800_000_000 + APNS_JWT_REUSE_SECONDS - 1)).toBe(first);
    const refreshed = cache.getJwt(credentials, 1_800_000_000 + APNS_JWT_REUSE_SECONDS);
    expect(refreshed).not.toBe(first);
    expect(decodePart(refreshed.split(".")[1]!).iat).toBe(1_800_000_000 + APNS_JWT_REUSE_SECONDS);
  });

  it("does not hand one key's token to different credentials", () => {
    const cache = makeApnsProviderTokenCache();
    const first = cache.getJwt(credentials, 1_800_000_000);
    const other = cache.getJwt({ ...credentials, keyId: "OTHERKEY12" }, 1_800_000_000);
    expect(decodePart(other.split(".")[0]!).kid).toBe("OTHERKEY12");
    expect(other).not.toBe(first);
  });
});
