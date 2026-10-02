import type {
  ChildNudgeUpdate,
  DispatchReportVerdict,
  QueuedTurnId,
  ThreadDelegation,
} from "@t3tools/contracts";

export type DispatchVerdict = DispatchReportVerdict;
export type RecordedReportOutcome = Extract<DispatchVerdict, "accepted" | "stale">;
export type DelegationExecutionReason = "assigned" | "continued" | "replaced";

export function activeDispatchId(delegation: ThreadDelegation): string | null {
  return delegation.dispatchId ?? null;
}

export function activeDispatchTurnId(delegation: ThreadDelegation): string | null {
  return (delegation.dispatchTurnId as string | null | undefined) ?? null;
}

export type ExecutionProvenance = "unfenced" | "superseded" | "unproven" | "authorized";

/**
 * The generation fence, shared by child-report admission and parent-waking
 * lifecycle notification so the two cannot disagree about authorized proof.
 * Terminality is the caller's rule: a settled delegation reports `unfenced`.
 *
 * Identity model: the logical assignment survives retries; the dispatch
 * identifies one authorized execution; the turn proves which execution is
 * reporting. Provenance must arrive WITH the signal from the reporting
 * execution's context — this classifier never substitutes live thread state.
 */
export function classifyExecutionProvenance(input: {
  readonly delegation: ThreadDelegation | null | undefined;
  readonly claimedDispatchId?: string | null | undefined;
  readonly claimedTurnId?: string | null | undefined;
}): ExecutionProvenance {
  const delegation = input.delegation;
  if (delegation == null) {
    return "unfenced";
  }
  if (delegation.completedAt !== null) {
    return "unfenced";
  }
  const activeTurn = activeDispatchTurnId(delegation);
  if (activeTurn === null) {
    // Rejected even when unfenced: a report must not invent a generation.
    if (
      input.claimedDispatchId !== null &&
      input.claimedDispatchId !== undefined &&
      input.claimedDispatchId !== activeDispatchId(delegation)
    ) {
      return "superseded";
    }
    if (delegation.dispatchId === undefined) {
      return "unfenced";
    }
    // A minted dispatch with no bound turn cannot authorize state changes.
    // This covers both the initial startup window and replacement windows:
    // only session binding can establish the execution's authoritative pair.
    return "unproven";
  }
  if (input.claimedTurnId === null || input.claimedTurnId === undefined) {
    // Turn-absent callers (pre-fence integrations) cannot prove execution.
    return "unproven";
  }
  if (input.claimedTurnId !== activeTurn) {
    return "superseded";
  }
  if (
    input.claimedDispatchId !== null &&
    input.claimedDispatchId !== undefined &&
    input.claimedDispatchId !== activeDispatchId(delegation)
  ) {
    return "superseded";
  }
  return "authorized";
}

/**
 * - `accepted`: authoritative execution (or genuinely pre-fence history).
 * - `stale`: superseded execution, missing proof, unminted claim, or novel
 *   report on closed work. No task, wait, or queue mutation.
 */
export function classifyChildReport(input: {
  readonly delegation: ThreadDelegation;
  readonly claimedDispatchId: string | null | undefined;
  readonly claimedTurnId: string | null | undefined;
  readonly kind: "progress" | "decision-needed" | "important-update";
  readonly recordedOutcome?: RecordedReportOutcome | undefined;
}): DispatchVerdict {
  if (input.recordedOutcome !== undefined) {
    return input.recordedOutcome;
  }
  if (input.delegation.completedAt !== null) {
    return "stale";
  }
  const provenance = classifyExecutionProvenance({
    delegation: input.delegation,
    claimedDispatchId: input.claimedDispatchId,
    claimedTurnId: input.claimedTurnId,
  });
  // Unproven progress stays accepted: it mutates nothing.
  const unprovenIsAcceptable = input.kind === "progress";
  return provenance === "authorized" ||
    provenance === "unfenced" ||
    (provenance === "unproven" && unprovenIsAcceptable)
    ? "accepted"
    : "stale";
}

/**
 * Mints a fresh execution generation. The dispatch identifies one authorized
 * execution; the sequence orders generations for audit. Callers bind the
 * generation to a concrete turn via dispatchTurnId separately.
 */
export function mintDispatch(
  previousSequence?: number | null | undefined,
): readonly [dispatchId: string, dispatchSequence: number] {
  return [crypto.randomUUID(), (previousSequence ?? 0) + 1];
}

/**
 * Fresh execution generation for a newly created delegation. The turn
 * binding happens at the first session update (see execution binding),
 * so new work never silently enters the legacy path.
 */
export function mintDispatchRecord(previousSequence?: number | null | undefined): {
  readonly dispatchId: string;
  readonly dispatchSequence: number;
  readonly dispatchTurnId: null;
  readonly dispatchReason: "assigned";
} {
  const [dispatchId, dispatchSequence] = mintDispatch(previousSequence);
  return { dispatchId, dispatchSequence, dispatchTurnId: null, dispatchReason: "assigned" };
}

export function transitionDelegationExecution(
  delegation: ThreadDelegation,
  reason: Exclude<DelegationExecutionReason, "assigned">,
): {
  readonly delegation: ThreadDelegation;
  readonly retiredPendingResponseQueuedTurnId: QueuedTurnId | null;
} {
  const previousDispatchId = delegation.dispatchId;
  const previousSequence = delegation.dispatchSequence ?? (delegation.dispatchId ? 1 : 0);
  const [dispatchId, dispatchSequence] = mintDispatch(previousSequence);
  return {
    delegation: {
      ...delegation,
      dispatchId,
      dispatchSequence,
      dispatchTurnId: null,
      dispatchReason: reason,
      ...(previousDispatchId ? { previousDispatchId } : {}),
      decision: null,
      pendingResponse: null,
      outcome: undefined,
    },
    retiredPendingResponseQueuedTurnId: delegation.pendingResponse?.queuedTurnId ?? null,
  };
}

export function bindDelegationExecution(
  delegation: ThreadDelegation,
  turnId: NonNullable<ThreadDelegation["dispatchTurnId"]>,
): ThreadDelegation {
  return { ...delegation, dispatchTurnId: turnId };
}

export function reportBelongsToDelegation(
  report: ChildNudgeUpdate,
  delegation: ThreadDelegation,
): boolean {
  return (
    report.assignmentId === delegation.assignmentId &&
    (report.dispatchId === undefined ||
      delegation.dispatchId === undefined ||
      report.dispatchId === delegation.dispatchId)
  );
}
/**
 * Idempotency key for a logical report. The exact pre-fence format is kept
 * when no dispatch is involved so reports accepted before the upgrade and
 * retried afterward still deduplicate instead of waking the parent twice.
 */
export function childReportDedupeKey(input: {
  readonly childThreadId: string;
  readonly dispatchId: string | null | undefined;
  readonly originTurnId?: string | null | undefined;
  readonly assignmentId: string;
  readonly reportId: string;
}): string {
  if (input.dispatchId === null || input.dispatchId === undefined) {
    if (input.originTurnId !== null && input.originTurnId !== undefined) {
      return `report:${input.childThreadId}:turn:${input.originTurnId}:${input.assignmentId}:${input.reportId}`;
    }
    return `report:${input.childThreadId}:${input.assignmentId}:${input.reportId}`;
  }
  return `report:${input.childThreadId}:${input.dispatchId}:${input.assignmentId}:${input.reportId}`;
}

/**
 * Single derivation of a report's assignment, generation and idempotency key.
 * The decider and the engine's durable receipt must agree or a retried report is
 * admitted twice instead of replaying its recorded verdict. Callers must not
 * re-derive the assignment and dispatch fallbacks themselves.
 */
export function childReportIdentity<
  TAssignmentId extends ThreadDelegation["assignmentId"],
  TDispatchId extends string,
>(input: {
  readonly childThreadId: string;
  readonly delegation: ThreadDelegation | null | undefined;
  readonly claimedAssignmentId?: TAssignmentId | null | undefined;
  readonly claimedDispatchId?: TDispatchId | null | undefined;
  readonly originTurnId?: string | null | undefined;
  readonly reportId: string;
}): {
  readonly assignmentId: TAssignmentId | ThreadDelegation["assignmentId"];
  readonly dispatchId: TDispatchId | NonNullable<ThreadDelegation["dispatchId"]> | undefined;
  readonly reportKey: string;
} | null {
  const assignmentId = input.claimedAssignmentId ?? input.delegation?.assignmentId;
  if (assignmentId === null || assignmentId === undefined) {
    return null;
  }
  const dispatchId = input.claimedDispatchId ?? input.delegation?.dispatchId ?? undefined;
  return {
    assignmentId,
    dispatchId,
    reportKey: childReportDedupeKey({
      childThreadId: input.childThreadId,
      dispatchId,
      originTurnId: input.originTurnId,
      assignmentId,
      reportId: input.reportId,
    }),
  };
}

/**
 * Report key as written by the pre-unification engine and by migration 090's
 * backfill, which read the dispatch off the report's claimed provenance without
 * inheriting the delegation's generation. Keeps those receipts reachable on
 * replay; null when the two derivations already agree.
 */
export function legacyChildReportKey(input: {
  readonly childThreadId: string;
  readonly claimedDispatchId?: string | null | undefined;
  readonly originTurnId?: string | null | undefined;
  readonly assignmentId: string;
  readonly reportId: string;
  readonly resolvedDispatchId: string | null | undefined;
}): string | null {
  if (input.claimedDispatchId === input.resolvedDispatchId) {
    return null;
  }
  return childReportDedupeKey({
    childThreadId: input.childThreadId,
    dispatchId: input.claimedDispatchId,
    originTurnId: input.originTurnId,
    assignmentId: input.assignmentId,
    reportId: input.reportId,
  });
}

/**
 * Legacy rendering of a fenced update id (`report:child:assignment:report`),
 * for inputs that predate execution generations: hardcoded supersede
 * references and pre-upgrade receipts. The dispatch segment is a known
 * prefix built from the update's own fields, so stripping it is exact.
 */
export function legacyUpdateId(input: {
  readonly id: string;
  readonly childThreadId: string;
  readonly dispatchId: string | null | undefined;
  readonly assignmentId: string;
}): string | null {
  if (input.dispatchId === null || input.dispatchId === undefined) {
    return null;
  }
  const prefix = `report:${input.childThreadId}:${input.dispatchId}:${input.assignmentId}:`;
  if (!input.id.startsWith(prefix)) {
    return null;
  }
  return `report:${input.childThreadId}:${input.assignmentId}:${input.id.slice(prefix.length)}`;
}
