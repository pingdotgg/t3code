// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect's Crypto cannot import a PEM private key.
import * as NodeCrypto from "node:crypto";

export interface ApnsProviderCredentials {
  readonly teamId: string;
  readonly keyId: string;
  /** PEM contents of the `.p8` key. */
  readonly privateKey: string;
}

// APNs answers 429 TooManyProviderTokenUpdates when a provider token is
// refreshed more than about once per 20 minutes, and rejects tokens older than
// 60. Reusing one for 45 minutes stays inside both limits.
export const APNS_JWT_REUSE_SECONDS = 45 * 60;

const encodePart = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");

export function signApnsProviderJwt(
  input: ApnsProviderCredentials & { readonly issuedAtUnixSeconds: number },
): string {
  const signingInput = `${encodePart({ alg: "ES256", kid: input.keyId })}.${encodePart({
    iss: input.teamId,
    iat: input.issuedAtUnixSeconds,
  })}`;
  // Env files often store a PEM with literal "\n" escapes.
  const key = NodeCrypto.createPrivateKey(input.privateKey.replaceAll("\\n", "\n"));
  // APNs wants the raw r||s signature (IEEE P1363), not node's default DER.
  const signature = NodeCrypto.sign("sha256", Buffer.from(signingInput), {
    key,
    dsaEncoding: "ieee-p1363",
  });
  return `${signingInput}.${signature.toString("base64url")}`;
}

export function makeApnsProviderTokenCache() {
  const cache = new Map<string, { readonly jwt: string; readonly issuedAtUnixSeconds: number }>();
  return {
    getJwt(credentials: ApnsProviderCredentials, nowUnixSeconds: number): string {
      const cacheKey = JSON.stringify([
        credentials.teamId,
        credentials.keyId,
        NodeCrypto.createHash("sha256").update(credentials.privateKey).digest("hex"),
      ]);
      const cached = cache.get(cacheKey);
      if (cached && nowUnixSeconds - cached.issuedAtUnixSeconds < APNS_JWT_REUSE_SECONDS) {
        return cached.jwt;
      }
      const jwt = signApnsProviderJwt({ ...credentials, issuedAtUnixSeconds: nowUnixSeconds });
      cache.set(cacheKey, { jwt, issuedAtUnixSeconds: nowUnixSeconds });
      return jwt;
    },
  };
}
