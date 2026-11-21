import { AuthStandardClientScopes } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Signature from "effect/crypto/Signature";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as JoseError from "effect/jose/JoseError";
import * as Jwks from "effect/jose/Jwks";
import * as Jwt from "effect/jose/Jwt";

import * as ManagedLimits from "../policy/managedLimits.ts";
import { readCloudflareAccessConfig } from "./cloudflareAccessConfig.ts";
import * as EnvironmentAuth from "./EnvironmentAuth.ts";

// Cloudflare's assertions are a few KiB; bound untrusted input before verifying it.
const MAX_ASSERTION_LENGTH = 16 * 1024;
const PAIRING_TTL = Duration.minutes(2);

const AccessClaims = Schema.Struct({ email: Schema.NonEmptyString });

export class CloudflareAccessLoginDisabledError extends Schema.TaggedError<CloudflareAccessLoginDisabledError>()(
  "CloudflareAccessLoginDisabledError",
  {},
) {
  override get message(): string {
    return "Cloudflare Access sign-in is not configured.";
  }
}

export class CloudflareAccessAssertionMissingError extends Schema.TaggedError<CloudflareAccessAssertionMissingError>()(
  "CloudflareAccessAssertionMissingError",
  {},
) {
  override get message(): string {
    return "The request carries no Cloudflare Access assertion.";
  }
}

export class CloudflareAccessAssertionInvalidError extends Schema.TaggedError<CloudflareAccessAssertionInvalidError>()(
  "CloudflareAccessAssertionInvalidError",
  {
    /** The jose failure, such as `ClaimValidationFailed:aud:mismatch`; never token material. */
    reason: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `The Cloudflare Access assertion was rejected (${this.reason}).`;
  }
}

export class CloudflareAccessEmailNotAllowedError extends Schema.TaggedError<CloudflareAccessEmailNotAllowedError>()(
  "CloudflareAccessEmailNotAllowedError",
  { email: Schema.String },
) {
  override get message(): string {
    return "This Cloudflare Access identity is not allowed to sign in.";
  }
}

export class CloudflareAccessKeysUnavailableError extends Schema.TaggedError<CloudflareAccessKeysUnavailableError>()(
  "CloudflareAccessKeysUnavailableError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Cloudflare Access signing keys are unavailable.";
  }
}

export class CloudflareAccessLogin extends Context.Service<
  CloudflareAccessLogin,
  {
    /**
     * Verifies a `Cf-Access-Jwt-Assertion` and mints a one-time pairing credential for it, the same
     * grant `t3 pair` issues. Never a session: the browser still redeems it through `/pair`.
     */
    readonly login: (
      assertion: string | undefined,
    ) => Effect.Effect<
      { readonly credential: string; readonly expiresAt: DateTime.Utc },
      | CloudflareAccessLoginDisabledError
      | CloudflareAccessAssertionMissingError
      | CloudflareAccessAssertionInvalidError
      | CloudflareAccessEmailNotAllowedError
      | CloudflareAccessKeysUnavailableError
      | EnvironmentAuth.ServerAuthInternalError
      | ManagedLimits.ManagedPolicyRefusedError
    >;
  }
>()("t3/auth/CloudflareAccessLogin") {}

const disabled = CloudflareAccessLogin.of({
  login: Effect.fn("CloudflareAccessLogin.login")(function* () {
    return yield* new CloudflareAccessLoginDisabledError();
  }),
});

const toVerificationError = (error: Jwt.JwtError) => {
  if (!JoseError.isJoseError(error)) {
    return new CloudflareAccessAssertionInvalidError({ reason: "claims", cause: error });
  }
  if (error.reason._tag === "KeySetUnavailable") {
    return new CloudflareAccessKeysUnavailableError({ cause: error });
  }
  const reason =
    error.reason._tag === "ClaimValidationFailed"
      ? `${error.reason._tag}:${error.reason.claim}:${error.reason.reason}`
      : error.reason._tag;
  return new CloudflareAccessAssertionInvalidError({ reason, cause: error });
};

const make = Effect.gen(function* () {
  const config = yield* readCloudflareAccessConfig;
  if (config._tag === "Misconfigured") {
    yield* Effect.logWarning(
      "Cloudflare Access sign-in is off: set T3CODE_CLOUDFLARE_ACCESS_TEAM_DOMAIN, T3CODE_CLOUDFLARE_ACCESS_AUD and T3CODE_CLOUDFLARE_ACCESS_EMAILS together, with valid values.",
      { reason: config.reason },
    );
  }
  if (config._tag !== "Enabled") return disabled;
  const { settings } = config;

  const environmentAuth = yield* EnvironmentAuth.EnvironmentAuth;
  const signature = yield* Signature.Signature;
  const keySet = yield* Jwks.makeRemote({ url: settings.certsUrl }).pipe(Effect.option);
  if (keySet._tag === "None") {
    yield* Effect.logWarning("Cloudflare Access sign-in is off: the key set URL is invalid.");
    return disabled;
  }
  const jwks = keySet.value;

  const login: CloudflareAccessLogin["Service"]["login"] = Effect.fn("CloudflareAccessLogin.login")(
    function* (assertion) {
      if (assertion === undefined || assertion.trim() === "") {
        return yield* new CloudflareAccessAssertionMissingError();
      }
      if (assertion.length > MAX_ASSERTION_LENGTH) {
        return yield* new CloudflareAccessAssertionInvalidError({ reason: "too_long" });
      }
      // The LAN port answers outside Cloudflare too, so the header is trusted only once signed.
      const verified = yield* Jwt.verifyWithKeySet(AccessClaims, Redacted.make(assertion.trim()), {
        issuer: settings.issuer,
        audience: settings.audience,
        algorithms: ["RS256"],
        clockTolerance: "10 seconds",
        requiredClaims: ["exp", "iss", "aud"],
      }).pipe(
        Effect.provideService(Jwks.Jwks, jwks),
        Effect.provideService(Signature.Signature, signature),
        Effect.mapError(toVerificationError),
      );
      const email = verified.claims.email.trim().toLowerCase();
      if (!settings.allowedEmails.has(email)) {
        return yield* new CloudflareAccessEmailNotAllowedError({ email });
      }
      const issued = yield* environmentAuth.createPairingLink({
        scopes: AuthStandardClientScopes,
        subject: "one-time-token",
        ttl: PAIRING_TTL,
        label: `Google: ${email}`,
      });
      return { credential: issued.credential, expiresAt: issued.expiresAt };
    },
  );

  return CloudflareAccessLogin.of({ login });
});

export const layer = Layer.effect(CloudflareAccessLogin, make);
