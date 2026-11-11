import * as Schema from "effect/Schema";

import { IsoDateTime, ProofJudgeId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * Named acceptance gate on a thread: request → accept | reject → reopen.
 * Inspired by OpenRig's `rig proof`: work is not finished when the worker says so,
 * only when a named judge accepts. Rejected stays open until reopened and accepted.
 */
export const ProofJudgeStatus = Schema.Literals(["requested", "accepted", "rejected"]);
export type ProofJudgeStatus = typeof ProofJudgeStatus.Type;

/** Requested and rejected keep the thread from counting as finished. */
export const OPEN_PROOF_JUDGE_STATUSES: ReadonlySet<ProofJudgeStatus> = new Set([
  "requested",
  "rejected",
]);

export const ProofJudge = Schema.Struct({
  id: ProofJudgeId,
  /** Named person or agent who must accept before work counts as finished. */
  name: TrimmedNonEmptyString,
  /** What must be proven; free text criteria. */
  criteria: Schema.String,
  status: ProofJudgeStatus,
  requestedByThreadId: ThreadId,
  requestedAt: IsoDateTime,
  /** Who decided accept/reject; null while still requested. */
  decidedBy: Schema.NullOr(Schema.Union([Schema.Literal("user"), ThreadId])),
  decidedAt: Schema.NullOr(IsoDateTime),
  note: Schema.NullOr(Schema.String),
  reopenedAt: Schema.NullOr(IsoDateTime),
});
export type ProofJudge = typeof ProofJudge.Type;

export const openProofJudgeCount = (judges: ReadonlyArray<ProofJudge> | null | undefined): number =>
  judges?.filter((judge) => OPEN_PROOF_JUDGE_STATUSES.has(judge.status)).length ?? 0;
