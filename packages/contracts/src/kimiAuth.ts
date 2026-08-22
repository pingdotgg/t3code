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

export const KimiAuthFailureReason = Schema.Literals([
  // The user rejected the sign-in on the verification page.
  "denied",
  // The device authorization expired before the user approved it.
  "expired",
  // Requesting or polling the OAuth endpoints failed.
  "request-failed",
  // The token arrived but persisting the credentials file failed.
  "credential-write-failed",
  // Removing an existing credential during sign-out failed.
  "credential-remove-failed",
  // The requested provider instance is missing, invalid, or not Kimi.
  "invalid-instance",
]);
export type KimiAuthFailureReason = typeof KimiAuthFailureReason.Type;

export class KimiAuthError extends Schema.TaggedErrorClass<KimiAuthError>()("KimiAuthError", {
  reason: KimiAuthFailureReason,
  detail: Schema.optional(Schema.String),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    switch (this.reason) {
      case "denied":
        return "Kimi sign-in was denied.";
      case "expired":
        return "Kimi sign-in expired before it was approved.";
      case "credential-write-failed":
        return "Kimi sign-in succeeded but the credential could not be saved.";
      case "credential-remove-failed":
        return "Kimi credentials could not be removed.";
      case "invalid-instance":
        return "The selected Kimi provider instance is unavailable.";
      case "request-failed":
      default:
        return "Kimi sign-in failed.";
    }
  }
}
