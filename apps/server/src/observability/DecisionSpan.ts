/**
 * DecisionSpan — the decision-trace convention every silently-deciding
 * subsystem must use.
 *
 * A "silent decision" is any branch the runtime takes without telling the user
 * why: fire or suppress a notification, settle or snooze a thread, capture or
 * skip a checkpoint, approve or deny a tool call. Post-hoc, an agent asked
 * "why did that happen?" has nothing to read unless the decision left a span
 * behind. So:
 *
 * - **Name**: `<subsystem>.decide.<what>` (enforced by the parameter type).
 * - **Sampling**: `{ sampled: true }`, always. Without it `T3CODE_TRACE_MIN_LEVEL`
 *   or an unsampled parent silently drops the span from the trace file — see
 *   `effect/internal/effect.ts` `makeSpanUnsafe`, where `options.sampled`
 *   short-circuits both the level filter and the parent's `sampled === false`.
 * - **Attributes**: `decision.candidate` (stable, namespaced trigger name),
 *   `decision.verdict` (closed lowercase enum per subsystem),
 *   `decision.reason` (free text for the agent reading it), plus the
 *   cross-artifact join keys — `orchestration.correlation_id` above all, since
 *   that is what pivots a span into
 *   `SELECT * FROM orchestration_events WHERE correlation_id = ?`.
 *
 * Usage: put the *evaluation* inside `withDecisionSpan` and act on the verdict
 * outside it, so the span records the decision rather than the work.
 *
 * ```ts
 * const decision = yield* withDecisionSpan(
 *   "checkpointing.decide.capture",
 *   { candidate: "checkpoint.on_turn_end", keys: { correlationId, threadId } },
 *   evaluateCapture(event),
 * );
 * if (decision.verdict === "capture") { ... }
 * ```
 *
 * @module observability/DecisionSpan
 */
import * as Effect from "effect/Effect";

/** `<subsystem>.decide.<what>`, e.g. `notifications.decide.edge`. */
export type DecisionSpanName = `${string}.decide.${string}`;

/**
 * Cross-artifact join keys carried by every decision span.
 *
 * `correlationId` is not optional — authors must state it, even when the
 * trigger has no command chain to inherit from (then: `null`, and the
 * attribute is omitted rather than faked).
 */
export interface DecisionKeys {
  readonly correlationId: string | null;
  readonly commandId?: string | null;
  readonly threadId?: string | null;
  readonly turnId?: string | null;
  readonly approvalRequestId?: string | null;
}

export type DecisionAttributeValue = string | number | boolean;

/** The outcome an evaluation returns; `verdict` is a closed per-subsystem enum. */
export interface Decision<Verdict extends string> {
  readonly verdict: Verdict;
  readonly reason: string;
  readonly attributes?: Readonly<Record<string, DecisionAttributeValue>>;
}

export interface DecisionSpanInput {
  readonly candidate: string;
  readonly keys: DecisionKeys;
  readonly attributes?: Readonly<Record<string, DecisionAttributeValue>>;
}

function joinKeyAttributes(keys: DecisionKeys): Record<string, DecisionAttributeValue> {
  return {
    ...(keys.correlationId ? { "orchestration.correlation_id": keys.correlationId } : {}),
    ...(keys.commandId ? { "orchestration.command_id": keys.commandId } : {}),
    ...(keys.threadId ? { "orchestration.thread_id": keys.threadId } : {}),
    ...(keys.turnId ? { "orchestration.turn_id": keys.turnId } : {}),
    ...(keys.approvalRequestId
      ? { "orchestration.approval_request_id": keys.approvalRequestId }
      : {}),
  };
}

/** Attributes present from the moment the span opens (before the verdict). */
export function decisionCandidateAttributes(
  input: DecisionSpanInput,
): Record<string, DecisionAttributeValue> {
  return {
    "decision.candidate": input.candidate,
    ...joinKeyAttributes(input.keys),
    ...input.attributes,
  };
}

/** Attributes added once the evaluation produced a verdict. */
export function decisionVerdictAttributes(
  decision: Decision<string>,
): Record<string, DecisionAttributeValue> {
  return {
    "decision.verdict": decision.verdict,
    "decision.reason": decision.reason,
    ...decision.attributes,
  };
}

/**
 * Wraps an evaluation in a `<subsystem>.decide.<what>` span that always
 * reaches the trace file, and annotates the verdict onto it.
 */
export const withDecisionSpan = <Decided extends Decision<string>, E, R>(
  spanName: DecisionSpanName,
  input: DecisionSpanInput,
  decide: Effect.Effect<Decided, E, R>,
): Effect.Effect<Decided, E, R> =>
  decide.pipe(
    Effect.tap((decision) => Effect.annotateCurrentSpan(decisionVerdictAttributes(decision))),
    Effect.withSpan(spanName, {
      // Required: keeps the decision in the trace file regardless of
      // `T3CODE_TRACE_MIN_LEVEL` and of an unsampled parent span.
      sampled: true,
      attributes: decisionCandidateAttributes(input),
    }),
  );
