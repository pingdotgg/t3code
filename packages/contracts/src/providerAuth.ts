/**
 * Provider account sign-in contract (fork f1).
 *
 * Models the in-app account lifecycle for provider instances whose driver
 * speaks a native login protocol. Today only the Codex driver does, via the
 * `codex app-server` `account/login/*` methods, but nothing here is Codex
 * specific.
 *
 * Design constraints worth keeping:
 *
 *   - **t3 never handles a credential.** The sign-in stream carries a URL and
 *     a user code; the token exchange happens between the provider CLI and the
 *     provider. `type: "apiKey"` logins are deliberately not modelled — they
 *     would put a raw secret on the WS wire.
 *   - **`ProviderSignInEvent` is a new union on a new RPC.** Growing it later
 *     only affects clients that call that RPC, unlike a union riding
 *     `ServerConfig`.
 *   - **Unsubscribing is cancelling.** There is no cancel RPC; the server
 *     cancels the login and tears down its child process when the stream's
 *     scope closes, so an abandoned browser tab cannot leak a subprocess.
 *
 * Every export is prefixed `Provider*` because `contracts/src/index.ts` is
 * `export *` over every module.
 *
 * @module contracts/providerAuth
 */
import * as Schema from "effect/Schema";

import { IsoDateTime, TrimmedNonEmptyString, TrimmedString } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

/**
 * How the user completes the OAuth handshake.
 *
 *   - `browser` — the driver mints an `authUrl` whose redirect terminates on
 *     the machine running the provider process. Only usable when the client
 *     and the server share that machine.
 *   - `deviceCode` — the driver mints a short user code the user types into a
 *     verification page from any device. Works from every surface, which is
 *     why it is the default everywhere except the primary local desktop.
 */
export const ProviderSignInMode = Schema.Literals(["browser", "deviceCode"]);
export type ProviderSignInMode = typeof ProviderSignInMode.Type;

export const PROVIDER_SIGN_IN_MODES: ReadonlyArray<ProviderSignInMode> = ["browser", "deviceCode"];

/**
 * One step of a sign-in. Exactly one of `browserHandoff` / `deviceCode`
 * follows `started`, and the stream always ends with `completed` or `failed`
 * unless the client unsubscribes first.
 */
export const ProviderSignInEvent = Schema.Union([
  Schema.TaggedStruct("started", {}),
  Schema.TaggedStruct("browserHandoff", {
    authUrl: TrimmedNonEmptyString,
  }),
  Schema.TaggedStruct("deviceCode", {
    userCode: TrimmedNonEmptyString,
    verificationUrl: TrimmedNonEmptyString,
  }),
  Schema.TaggedStruct("completed", {}),
  Schema.TaggedStruct("failed", {
    message: TrimmedString,
  }),
]);
export type ProviderSignInEvent = typeof ProviderSignInEvent.Type;

export const ProviderStartSignInInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  mode: ProviderSignInMode,
});
export type ProviderStartSignInInput = typeof ProviderStartSignInInput.Type;

export const ProviderSignOutInput = Schema.Struct({
  instanceId: ProviderInstanceId,
});
export type ProviderSignOutInput = typeof ProviderSignOutInput.Type;

/**
 * The instance cannot be signed in from the app: either the id is unknown to
 * the registry, or its driver does not implement account operations. `reason`
 * carries which.
 */
export class ProviderAuthUnsupportedError extends Schema.TaggedErrorClass<ProviderAuthUnsupportedError>()(
  "ProviderAuthUnsupportedError",
  {
    instanceId: ProviderInstanceId,
    reason: TrimmedString,
  },
) {
  override get message(): string {
    return `Provider instance ${this.instanceId} does not support in-app sign-in: ${this.reason}`;
  }
}

/**
 * A login for this instance is already in flight. Concurrent logins against
 * one `CODEX_HOME` would race on `auth.json`, so the second is refused rather
 * than queued.
 */
export class ProviderAuthLoginInProgressError extends Schema.TaggedErrorClass<ProviderAuthLoginInProgressError>()(
  "ProviderAuthLoginInProgressError",
  {
    instanceId: ProviderInstanceId,
  },
) {
  override get message(): string {
    return `A sign-in for provider instance ${this.instanceId} is already in progress.`;
  }
}

/**
 * The provider process could not be started, or the account operation itself
 * failed. `detail` is safe to render — it never carries a credential.
 */
export class ProviderAuthFailedError extends Schema.TaggedErrorClass<ProviderAuthFailedError>()(
  "ProviderAuthFailedError",
  {
    instanceId: ProviderInstanceId,
    detail: TrimmedString,
  },
) {
  override get message(): string {
    return `Provider instance ${this.instanceId} account operation failed: ${this.detail}`;
  }
}

export const ProviderAuthError = Schema.Union([
  ProviderAuthUnsupportedError,
  ProviderAuthLoginInProgressError,
  ProviderAuthFailedError,
]);
export type ProviderAuthError = typeof ProviderAuthError.Type;

/* ------------------------------------------------------------------------ *
 * Increment 2 — account plan / quota, carried on `ServerProviderAuth`.
 * ------------------------------------------------------------------------ */

/**
 * One rolling usage window (Codex reports a short "primary" and a long
 * "secondary" one).
 *
 * `usedPercent` is the only field the provider always supplies; everything
 * else is best-effort, so a window with a percentage and nothing else is a
 * legitimate value rather than a decode failure.
 */
export const ProviderAccountRateLimitWindow = Schema.Struct({
  /** 0–100. Clamped by the producer; consumers may render it directly. */
  usedPercent: Schema.Number,
  /** When the window rolls over. Absent when the provider did not say. */
  resetsAt: Schema.optional(IsoDateTime),
  /** Nominal window length, for copy like "5h limit". */
  windowMinutes: Schema.optional(Schema.Number),
});
export type ProviderAccountRateLimitWindow = typeof ProviderAccountRateLimitWindow.Type;

/**
 * Quota snapshot for the signed-in account, read at `checkedAt`.
 *
 * Deliberately *not* a mirror of the provider's wire shape: every field here
 * is one a UI can render without knowing which provider produced it, and none
 * of them is a closed literal union — §1.4 rule 1, since this rides
 * `ServerConfig` and an older client must never fail to decode the whole
 * config over a value it has not heard of.
 */
export const ProviderAccountRateLimits = Schema.Struct({
  checkedAt: IsoDateTime,
  primary: Schema.optional(ProviderAccountRateLimitWindow),
  secondary: Schema.optional(ProviderAccountRateLimitWindow),
  /** True when the provider says the account is currently limited. */
  limitReached: Schema.optional(Schema.Boolean),
  /** Free-form reason slug, rendered as-is when present. */
  limitReason: Schema.optional(TrimmedNonEmptyString),
  /** Pre-formatted credit balance, e.g. `"$12.40"`. Never a number: currency. */
  creditBalance: Schema.optional(TrimmedNonEmptyString),
});
export type ProviderAccountRateLimits = typeof ProviderAccountRateLimits.Type;

/**
 * Token-usage summary for the signed-in account. Coarse on purpose — this is a
 * status surface, not an analytics dashboard.
 */
export const ProviderAccountUsage = Schema.Struct({
  lifetimeTokens: Schema.optional(Schema.Number),
  /** Sum of the daily buckets the provider returned. */
  recentTokens: Schema.optional(Schema.Number),
  /** How many days `recentTokens` covers, so the label can be honest. */
  recentDays: Schema.optional(Schema.Number),
});
export type ProviderAccountUsage = typeof ProviderAccountUsage.Type;
