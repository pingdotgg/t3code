import { decodeJwt, importPKCS8, importSPKI, jwtVerify, SignJWT, type JWTPayload } from "jose";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

export const RELAY_LINK_PROOF_TYP = "t3-env-link+jwt";
export const RELAY_MINT_REQUEST_TYP = "t3-cloud-mint+jwt";
export const RELAY_HEALTH_REQUEST_TYP = "t3-cloud-health+jwt";
export const RELAY_MINT_RESPONSE_TYP = "t3-env-mint+jwt";
export const RELAY_HEALTH_RESPONSE_TYP = "t3-env-health+jwt";
export const RELAY_ACTIVITY_PUBLISH_TYP = "t3-env-activity+jwt";

export class RelayJwtError extends Schema.TaggedError<RelayJwtError>()("RelayJwtError", {
  operation: Schema.Literals(["sign", "verify"]),
  typ: Schema.String,
  issuer: Schema.optional(Schema.String),
  audience: Schema.optional(Schema.String),
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return `Failed to ${this.operation} relay JWT of type "${this.typ}".`;
  }

  static diagnosticCode(error: RelayJwtError): string {
    if (
      Predicate.isObject(error.cause) &&
      Predicate.hasProperty(error.cause, "code") &&
      Predicate.isString(error.cause.code) &&
      error.cause.code.length > 0
    ) {
      return error.cause.code;
    }

    return error.cause instanceof Error && error.cause.name ? error.cause.name : "unknown";
  }
}

export function normalizeRelayIssuer(value: string): string {
  return value.trim().replace(/\/+$/gu, "");
}

export function decodeRelayJwt(token: string): JWTPayload {
  return decodeJwt(token);
}

function normalizePem(value: string): string {
  return value.replace(/\\n/gu, "\n").trim();
}

// PEM parsing + key import cost ~0.3–1ms per call and runs on every relay
// JWT sign/verify (link, connect, status, publish, DPoP). Keys rotate rarely,
// so cache the imported keys by normalized PEM with a small FIFO bound.
const MAX_CACHED_KEYS = 50;
const privateKeyCache = new Map<string, Promise<Awaited<ReturnType<typeof importPKCS8>>>>();
const publicKeyCache = new Map<string, Promise<Awaited<ReturnType<typeof importSPKI>>>>();

function cachedKeyImport<T>(
  cache: Map<string, Promise<T>>,
  normalizedPem: string,
  importKey: (pem: string) => Promise<T>,
): Promise<T> {
  const existing = cache.get(normalizedPem);
  if (existing !== undefined) {
    return existing;
  }
  let pending: Promise<T>;
  pending = importKey(normalizedPem).then(
    (key) => key,
    (error: unknown) => {
      if (cache.get(normalizedPem) === pending) {
        cache.delete(normalizedPem);
      }
      throw error;
    },
  );
  if (cache.size >= MAX_CACHED_KEYS) {
    const oldest = cache.keys().next();
    if (!oldest.done) {
      cache.delete(oldest.value);
    }
  }
  cache.set(normalizedPem, pending);
  return pending;
}

export function signRelayJwt(input: {
  readonly privateKey: string;
  readonly typ: string;
  readonly payload: JWTPayload;
}): Effect.Effect<string, RelayJwtError> {
  return Effect.tryPromise({
    try: async () => {
      const key = await cachedKeyImport(privateKeyCache, normalizePem(input.privateKey), (pem) =>
        importPKCS8(pem, "EdDSA"),
      );
      return new SignJWT(input.payload)
        .setProtectedHeader({ alg: "EdDSA", typ: input.typ })
        .sign(key);
    },
    catch: (cause) => new RelayJwtError({ operation: "sign", typ: input.typ, cause }),
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
      const key = await cachedKeyImport(publicKeyCache, normalizePem(input.publicKey), (pem) =>
        importSPKI(pem, "EdDSA"),
      );
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
    catch: (cause) =>
      new RelayJwtError({
        operation: "verify",
        typ: input.typ,
        issuer: input.issuer,
        audience: input.audience,
        cause,
      }),
  });
}
