import { createRemoteJWKSet, jwtVerify } from "jose";

export function makeAuthenticate(baseUrl: string, jwksUrl: string) {
  const jwks = createRemoteJWKSet(new URL(jwksUrl));
  const issuer = new URL(baseUrl).origin;
  return async (authorization: string | null): Promise<string | undefined> => {
    if (!authorization?.toLowerCase().startsWith("bearer ")) return;
    try {
      const { payload } = await jwtVerify(authorization.slice(7), jwks, {
        issuer,
        audience: issuer,
        algorithms: ["EdDSA"],
        requiredClaims: ["sub", "exp", "iat"],
        maxTokenAge: "15 minutes",
      });
      return payload.sub || undefined;
    } catch {
      return;
    }
  };
}
