import { decodeJwt, importPKCS8, importSPKI, jwtVerify, SignJWT, type JWTPayload } from "jose";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

export const RELAY_LINK_PROOF_TYP = "t3-env-link+jwt";
export const RELAY_MINT_REQUEST_TYP = "t3-cloud-mint+jwt";
export const RELAY_HEALTH_REQUEST_TYP = "t3-cloud-health+jwt";
export const RELAY_MINT_RESPONSE_TYP = "t3-env-mint+jwt";
export const RELAY_HEALTH_RESPONSE_TYP = "t3-env-health+jwt";
export const RELAY_ACTIVITY_PUBLISH_TYP = "t3-env-activity+jwt";

export class RelayJwtError extends Data.TaggedError("RelayJwtError")<{
  readonly cause: unknown;
}> {}

export function normalizeRelayIssuer(value: string): string {
  return value.trim().replace(/\/+$/gu, "");
}

export function decodeRelayJwt(token: string): JWTPayload {
  return decodeJwt(token);
}

function normalizePem(value: string): string {
  return value.replace(/\\n/gu, "\n").trim();
}

export function signRelayJwt(input: {
  readonly privateKey: string;
  readonly typ: string;
  readonly payload: JWTPayload;
}): Effect.Effect<string, RelayJwtError> {
  return Effect.tryPromise({
    try: async () => {
      const key = await importPKCS8(normalizePem(input.privateKey), "EdDSA");
      return new SignJWT(input.payload)
        .setProtectedHeader({ alg: "EdDSA", typ: input.typ })
        .sign(key);
    },
    catch: (cause) => new RelayJwtError({ cause }),
  });
}

export function verifyRelayJwt(input: {
  readonly publicKey: string;
  readonly token: string;
  readonly typ: string;
  readonly issuer: string;
  readonly audience: string;
  readonly nowEpochSeconds: number;
  readonly maxTokenAge?: string | number;
}): Effect.Effect<JWTPayload, RelayJwtError> {
  return Effect.tryPromise({
    try: async () => {
      const key = await importSPKI(normalizePem(input.publicKey), "EdDSA");
      const verified = await jwtVerify(input.token, key, {
        algorithms: ["EdDSA"],
        typ: input.typ,
        issuer: input.issuer,
        audience: input.audience,
        maxTokenAge: input.maxTokenAge ?? "5 minutes",
        clockTolerance: 60,
        currentDate: DateTime.toDate(DateTime.makeUnsafe(input.nowEpochSeconds * 1_000)),
      });
      return verified.payload;
    },
    catch: (cause) => new RelayJwtError({ cause }),
  });
}
