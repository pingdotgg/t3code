// Ported from LocalRouter (github.com/jayleaton/localrouter @fe24726, apps/companion/src/executor/policy.ts and
// approvals.ts), Apache-2.0, Copyright 2026 Jay Leaton. Modified for Ada.
import * as Schema from "effect/Schema";

import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

/** The fixed controls computer use takes. Locking the screen asks first; the rest run. */
export const COMPUTER_CONTROL_KINDS = [
  "open_app",
  "quit_app",
  "volume",
  "media",
  "dark_mode",
  "lock_screen",
] as const;
export const ComputerControlKind = Schema.Literals(COMPUTER_CONTROL_KINDS);
export type ComputerControlKind = typeof ComputerControlKind.Type;

/**
 * Nothing (`auto`), a person's tap on this exact step (`tap`), a judgment from the decision provider first
 * (`judge`), or nothing at all because it is not a step computer use offers (`refused`).
 */
export const ComputerVerdict = Schema.Literals(["auto", "tap", "judge", "refused"]);
export type ComputerVerdict = typeof ComputerVerdict.Type;

/** A verdict and, for the approval card and the audit, why it asked or refused. */
export const ComputerDecision = Schema.Struct({
  verdict: ComputerVerdict,
  why: Schema.String,
});
export type ComputerDecision = typeof ComputerDecision.Type;

/**
 * One step on the screen, as the helper observed it. Every string except `kind` comes from the screen: data,
 * never instructions. An unknown `kind` decodes and is then refused by the policy, so the reason reaches the
 * caller.
 */
export const ComputerAction = Schema.Struct({
  kind: Schema.String,
  ref: Schema.optionalKey(Schema.String),
  role: Schema.optionalKey(Schema.String),
  label: Schema.optionalKey(Schema.String),
  /** `type`: the exact text to type. The only text computer use ever types. */
  text: Schema.optionalKey(Schema.String),
  /** `press`: enter, space, escape, tab. */
  key: Schema.optionalKey(Schema.String),
  /** `press`: the field typed into before it, if any. */
  fieldRole: Schema.optionalKey(Schema.String),
  fieldLabel: Schema.optionalKey(Schema.String),
  /** `scroll`: up, down, top, bottom. */
  direction: Schema.optionalKey(Schema.String),
  /** `surface`: tab or app. */
  what: Schema.optionalKey(Schema.String),
  /** `surface`: the tab's or app's name. */
  name: Schema.optionalKey(Schema.String),
  /** `pointer`: why the background could not take the step, for the card. */
  why: Schema.optionalKey(Schema.String),
});
export type ComputerAction = typeof ComputerAction.Type;

export const ComputerHostId = TrimmedNonEmptyString.check(Schema.isMaxLength(128));
export type ComputerHostId = typeof ComputerHostId.Type;

export const ComputerTaskId = TrimmedNonEmptyString.check(Schema.isMaxLength(128));
export type ComputerTaskId = typeof ComputerTaskId.Type;

export const ComputerApprovalId = TrimmedNonEmptyString.check(Schema.isMaxLength(128));
export type ComputerApprovalId = typeof ComputerApprovalId.Type;

/**
 * What a tap approves, shown on the card in full and hashed into the approval: who asked, on which computer and
 * task, at which step, what was on screen, and the exact action.
 */
export const ComputerApprovalBinding = Schema.Struct({
  hostId: ComputerHostId,
  taskId: ComputerTaskId,
  step: NonNegativeInt,
  app: Schema.String,
  title: Schema.String,
  url: Schema.String,
  action: ComputerAction,
  /** The policy's reason, for the card. */
  why: Schema.String,
  /** What the person asked for. */
  goal: Schema.String,
  /** Who started the task, such as "agent: opencode". */
  requester: Schema.String,
});
export type ComputerApprovalBinding = typeof ComputerApprovalBinding.Type;

export const ComputerApprovalState = Schema.Literals([
  "pending",
  "approved",
  "denied",
  "expired",
  "used",
  "cancelled",
]);
export type ComputerApprovalState = typeof ComputerApprovalState.Type;

export const ComputerApproval = Schema.Struct({
  id: ComputerApprovalId,
  binding: ComputerApprovalBinding,
  createdAt: Schema.DateTimeUtc,
  expiresAt: Schema.DateTimeUtc,
  state: ComputerApprovalState,
  /** Empty until someone answers it. */
  decidedBy: Schema.String,
});
export type ComputerApproval = typeof ComputerApproval.Type;

/** A person's answer: only a pending, unexpired approval can be answered, once. */
export const ComputerApprovalDecideResult = Schema.Literals([
  "ok",
  "unknown",
  "not_pending",
  "expired",
]);
export type ComputerApprovalDecideResult = typeof ComputerApprovalDecideResult.Type;

/** A waiting step's check: `approved` once, for its own binding only, then `unknown`. */
export const ComputerApprovalTakeResult = Schema.Literals([
  "approved",
  "denied",
  "expired",
  "pending",
  "unknown",
  "mismatch",
  "cancelled",
]);
export type ComputerApprovalTakeResult = typeof ComputerApprovalTakeResult.Type;

export class ComputerApprovalLimitError extends Schema.TaggedError<ComputerApprovalLimitError>()(
  "ComputerApprovalLimitError",
  { limit: Schema.Int },
) {
  override get message(): string {
    return `Too many computer approvals are waiting; the limit is ${this.limit}.`;
  }
}
