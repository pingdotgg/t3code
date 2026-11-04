import type * as Signature from "effect/crypto/Signature";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as JoseError from "effect/jose/JoseError";
import * as Jwk from "effect/jose/Jwk";
import * as Jws from "effect/jose/Jws";
import * as Jwt from "effect/jose/Jwt";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

export const RELAY_LINK_PROOF_TYP = "t3-env-link+jwt";
export const RELAY_MINT_REQUEST_TYP = "t3-cloud-mint+jwt";
export const RELAY_HEALTH_REQUEST_TYP = "t3-cloud-health+jwt";
export const RELAY_MINT_RESPONSE_TYP = "t3-env-mint+jwt";
export const RELAY_HEALTH_RESPONSE_TYP = "t3-env-health+jwt";
export const RELAY_ACTIVITY_PUBLISH_TYP = "t3-env-activity+jwt";
export const RELAY_MANAGED_TUNNEL_RECOVERY_TYP = "t3-env-managed-tunnel-recovery+jwt";
export const RELAY_HOOK_DELIVERY_TYP = "t3-relay-hook-delivery+jwt";
export const RELAY_HOOK_DELIVERY_HEADER = "x-t3-relay-delivery";

export class RelayJwtError extends Schema.TaggedError<RelayJwtError>()("RelayJwtError", {
  operation: Schema.Literals(["sign", "verify", "decode"]),
  typ: Schema.optional(Schema.String),
  issuer: Schema.optional(Schema.String),
  audience: Schema.optional(Schema.String),
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return this.typ === undefined
      ? `Failed to ${this.operation} relay JWT.`
      : `Failed to ${this.operation} relay JWT of type "${this.typ}".`;
  }

  static diagnosticCode(error: RelayJwtError): string {
    if (JoseError.isJoseError(error.cause)) {
      const reason = error.cause.reason;
      return reason._tag === "ClaimValidationFailed"
        ? `${reason._tag}.${reason.claim}.${reason.reason}`
        : reason._tag;
    }
    return Schema.isSchemaError(error.cause) ? "SchemaError" : "unknown";
  }
}

export type RelayJwtClaims = Readonly<Record<string, Schema.Json>>;

export function normalizeRelayIssuer(value: string): string {
  return value.trim().replace(/\/+$/gu, "");
}

/** Reads claims without verifying them. Never authorize on the result. */
export const decodeRelayJwt = Effect.fn("relayJwt.decode")(function* (
  token: string,
): Effect.fn.Return<RelayJwtClaims, RelayJwtError> {
  const unverified = yield* Jwt.decodeUnverified(token).pipe(
    Effect.mapError((cause) => new RelayJwtError({ operation: "decode", cause })),
  );
  return unverified.claims;
});

function normalizePem(value: string): string {
  return value.replace(/\\n/gu, "\n").trim();
}

/** Parses a PKCS#8 PEM relay signing key once, for callers that sign repeatedly. */
export const importRelayPrivateKey = (pem: string) =>
  Jwk.importPkcs8(Redacted.make(normalizePem(pem)), "EdDSA");

/** Parses an SPKI PEM relay verification key once, for callers that verify repeatedly. */
export const importRelayPublicKey = (pem: string) => Jwk.importSpki(normalizePem(pem), "EdDSA");

// A parsed key carries its own algorithm; relay JWTs are EdDSA only.
const requireEdDsa = <K extends Jwk.PrivateKey | Jwk.PublicKey>(key: K) =>
  key.algorithm === "EdDSA"
    ? Effect.succeed(key)
    : Effect.fail(new JoseError.JoseError({ reason: new JoseError.AlgorithmNotAllowed() }));

export const signRelayJwt = Effect.fn("relayJwt.sign")(function* (input: {
  readonly privateKey: string | Jwk.PrivateKey;
  readonly typ: string;
  readonly payload: Readonly<Record<string, unknown>>;
}): Effect.fn.Return<string, RelayJwtError, Signature.Signature> {
  const privateKey = input.privateKey;
  const token = yield* (
    typeof privateKey === "string" ? importRelayPrivateKey(privateKey) : requireEdDsa(privateKey)
  ).pipe(
    Effect.flatMap((key) =>
      Jws.sign(new TextEncoder().encode(JSON.stringify(input.payload)), key, { typ: input.typ }),
    ),
    Effect.mapError((cause) => new RelayJwtError({ operation: "sign", typ: input.typ, cause })),
  );
  return Redacted.value(token);
});

/** Verifies an EdDSA relay JWT against the ambient `Clock` and decodes its claims. */
export const verifyRelayJwt = Effect.fn("relayJwt.verify")(function* <A>(
  schema: Schema.ConstraintDecoder<A>,
  input: {
    readonly publicKey: string | Jwk.PublicKey;
    readonly token: string;
    readonly typ: string;
    readonly issuer: string;
    readonly audience: string;
    readonly maxTokenAge?: Duration.Input;
  },
): Effect.fn.Return<A, RelayJwtError, Signature.Signature> {
  const publicKey = input.publicKey;
  const verified = yield* (
    typeof publicKey === "string" ? importRelayPublicKey(publicKey) : requireEdDsa(publicKey)
  ).pipe(
    Effect.flatMap((key) =>
      Jwt.verify(schema, input.token, key, {
        typ: input.typ,
        issuer: input.issuer,
        audience: input.audience,
        maxTokenAge: input.maxTokenAge ?? "5 minutes",
        clockTolerance: "60 seconds",
      }),
    ),
    Effect.mapError(
      (cause) =>
        new RelayJwtError({
          operation: "verify",
          typ: input.typ,
          issuer: input.issuer,
          audience: input.audience,
          cause,
        }),
    ),
  );
  return verified.claims;
});
