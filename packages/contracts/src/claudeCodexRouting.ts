/**
 * Claude Code → Codex bridge contracts (fork feature f5).
 *
 * The bridge is environment-owned: remote clients configure and authenticate
 * the machine that actually runs Claude Code. Credentials never cross this
 * wire; the sign-in stream carries only OpenAI's verification URL and user
 * code.
 */
import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString, TrimmedString } from "./baseSchemas.ts";
import { ProviderSignInEvent } from "./providerAuth.ts";

export const CLAUDE_CODEX_BRIDGE_VERSION = "7.2.120";

/** Stable catalog marker for the single Codex model exposed through a Claude instance. */
export const CLAUDE_CODEX_ROUTED_SUB_PROVIDER = "via Codex";

export const ClaudeCodexBridgeAccount = Schema.Struct({
  email: Schema.optional(TrimmedNonEmptyString),
  plan: Schema.optional(TrimmedNonEmptyString),
});
export type ClaudeCodexBridgeAccount = typeof ClaudeCodexBridgeAccount.Type;

export const ClaudeCodexBridgeStatus = Schema.Struct({
  supported: Schema.Boolean,
  installed: Schema.Boolean,
  authenticated: Schema.Boolean,
  running: Schema.Boolean,
  version: TrimmedNonEmptyString,
  error: Schema.optional(TrimmedString),
  account: Schema.optional(ClaudeCodexBridgeAccount),
});
export type ClaudeCodexBridgeStatus = typeof ClaudeCodexBridgeStatus.Type;

export const ClaudeCodexBridgeModel = Schema.Struct({
  id: TrimmedNonEmptyString,
  ownedBy: Schema.optional(TrimmedNonEmptyString),
});
export type ClaudeCodexBridgeModel = typeof ClaudeCodexBridgeModel.Type;

export const ClaudeCodexBridgeModelsResult = Schema.Struct({
  models: Schema.Array(ClaudeCodexBridgeModel),
  source: Schema.Literals(["live", "cache", "fallback"]),
  fetchedAt: Schema.optional(Schema.Number),
  stale: Schema.optional(Schema.Boolean),
  error: Schema.optional(TrimmedString),
});
export type ClaudeCodexBridgeModelsResult = typeof ClaudeCodexBridgeModelsResult.Type;

export const ClaudeCodexBridgeOperation = Schema.Literals([
  "status",
  "install",
  "sign-in",
  "sign-out",
  "models",
  "start",
]);
export type ClaudeCodexBridgeOperation = typeof ClaudeCodexBridgeOperation.Type;

export class ClaudeCodexBridgeError extends Schema.TaggedErrorClass<ClaudeCodexBridgeError>()(
  "ClaudeCodexBridgeError",
  {
    operation: ClaudeCodexBridgeOperation,
    detail: TrimmedString,
  },
) {
  override get message(): string {
    return `Claude Code Codex bridge ${this.operation} failed: ${this.detail}`;
  }
}

// Re-exporting the existing event type here documents that bridge sign-in has
// the same cancellation and device-code semantics as provider sign-in.
export const ClaudeCodexBridgeSignInEvent = ProviderSignInEvent;
export type ClaudeCodexBridgeSignInEvent = typeof ClaudeCodexBridgeSignInEvent.Type;
