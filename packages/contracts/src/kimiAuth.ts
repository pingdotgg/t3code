/**
 * Kimi in-app sign-in contracts.
 *
 * T3 Code runs Moonshot's OAuth 2.0 Device Authorization Grant on the server
 * and writes the resulting credential where the Kimi CLI (`kimi`) expects it
 * (`$KIMI_CODE_HOME/credentials/kimi-code.json`). The CLI owns the credential
 * from then on, including refreshes, so the sign-in surface is a single
 * streaming RPC: one `verification` event to show the user, then a terminal
 * `completed` event (or a typed error).
 *
 * @module kimiAuth
 */
import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

export const KimiAuthSignInInput = Schema.Struct({
  /**
   * Provider instance whose `homePath` (KIMI_CODE_HOME) receives the
   * credential. Omitted means the default instance / default home.
   */
  instanceId: Schema.optional(ProviderInstanceId),
});
export type KimiAuthSignInInput = typeof KimiAuthSignInInput.Type;

export const KimiAuthSignOutInput = Schema.Struct({
  instanceId: Schema.optional(ProviderInstanceId),
});
export type KimiAuthSignOutInput = typeof KimiAuthSignOutInput.Type;

/** The user-facing half of the device flow: where to go and what to enter. */
export const KimiAuthVerificationEvent = Schema.Struct({
  type: Schema.Literal("verification"),
  /** URL to open in a browser; usually carries the code pre-filled. */
  verificationUri: TrimmedNonEmptyString,
  /** Short code the user confirms on the verification page. */
  userCode: Schema.optional(TrimmedNonEmptyString),
  /** Seconds until the device authorization expires. */
  expiresInSeconds: Schema.optional(Schema.Number),
});
export type KimiAuthVerificationEvent = typeof KimiAuthVerificationEvent.Type;

export const KimiAuthCompletedEvent = Schema.Struct({
  type: Schema.Literal("completed"),
});
export type KimiAuthCompletedEvent = typeof KimiAuthCompletedEvent.Type;

export const KimiAuthSignInEvent = Schema.Union([
  KimiAuthVerificationEvent,
  KimiAuthCompletedEvent,
]);
export type KimiAuthSignInEvent = typeof KimiAuthSignInEvent.Type;

export const KimiOAuthErrorCode = Schema.Literals([
  "authorization_pending",
  "slow_down",
  "access_denied",
  "expired_token",
  "invalid_request",
  "invalid_client",
  "invalid_grant",
  "unauthorized_client",
  "unsupported_grant_type",
  "server_error",
  "temporarily_unavailable",
]);
export type KimiOAuthErrorCode = typeof KimiOAuthErrorCode.Type;

export class KimiAuthDeniedError extends Schema.TaggedErrorClass<KimiAuthDeniedError>()(
  "KimiAuthDeniedError",
  {},
) {
  override get message(): string {
    return "Kimi sign-in was denied.";
  }
}

export class KimiAuthExpiredError extends Schema.TaggedErrorClass<KimiAuthExpiredError>()(
  "KimiAuthExpiredError",
  {},
) {
  override get message(): string {
    return "Kimi sign-in expired before it was approved.";
  }
}

export class KimiAuthRequestError extends Schema.TaggedErrorClass<KimiAuthRequestError>()(
  "KimiAuthRequestError",
  {
    operation: Schema.Literals([
      "provider-settings",
      "device-authorization-request",
      "device-authorization-response",
      "token-poll",
    ]),
    status: Schema.optional(Schema.Number),
    oauthErrorCode: Schema.optional(KimiOAuthErrorCode),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    switch (this.operation) {
      case "provider-settings":
        return "Failed to load provider settings for Kimi authentication.";
      case "device-authorization-request":
        return "Failed to request Kimi device authorization.";
      case "device-authorization-response":
        return "Kimi device authorization returned an invalid response.";
      case "token-poll":
        return "Failed to poll Kimi device authorization.";
    }
  }
}

export class KimiCredentialWriteError extends Schema.TaggedErrorClass<KimiCredentialWriteError>()(
  "KimiCredentialWriteError",
  {
    credentialsPath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Kimi sign-in succeeded but the credential could not be saved.";
  }
}

export class KimiCredentialRemoveError extends Schema.TaggedErrorClass<KimiCredentialRemoveError>()(
  "KimiCredentialRemoveError",
  {
    credentialsPath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Kimi credentials could not be removed.";
  }
}

export class KimiAuthInstanceInvalidError extends Schema.TaggedErrorClass<KimiAuthInstanceInvalidError>()(
  "KimiAuthInstanceInvalidError",
  {
    instanceId: ProviderInstanceId,
    issue: Schema.Literals(["not-found", "wrong-driver", "invalid-settings"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return "The selected Kimi provider instance is unavailable.";
  }
}

export const KimiAuthError = Schema.Union([
  KimiAuthDeniedError,
  KimiAuthExpiredError,
  KimiAuthRequestError,
  KimiCredentialWriteError,
  KimiCredentialRemoveError,
  KimiAuthInstanceInvalidError,
]);
export type KimiAuthError = typeof KimiAuthError.Type;
