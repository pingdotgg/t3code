import type {
  CollaborativeAcceptanceStatus,
  CollaborativeAcceptanceProjection,
  PullRequestMonitorStatusResult,
} from "@t3tools/contracts";

export type PullRequestOrthogonalStatus = {
  readonly headline: string;
  readonly execution: string;
  readonly collaboration: string;
  readonly acceptance: string;
  readonly readiness: string;
  readonly blocker: string | null;
};

export function presentCollaborativeAcceptanceStatus(input: {
  readonly monitor: PullRequestMonitorStatusResult | null | undefined;
  readonly acceptance: CollaborativeAcceptanceStatus | null | undefined;
}): PullRequestOrthogonalStatus {
  const projection: CollaborativeAcceptanceProjection | null =
    input.acceptance?.record?.projection ?? null;
  const monitor = input.monitor?.monitor;
  const readiness = monitor?.readiness;
  const automationReason = input.monitor?.automationReason;
  const providerRefreshFailed =
    monitor?.status === "error" ||
    (monitor?.lastError !== null && monitor?.lastError !== undefined);
  const terminalMonitor = monitor?.status === "terminal" || monitor?.status === "stopped";
  const snapshot = input.monitor?.latestSnapshot;
  const missingEvidence = monitor !== null && monitor !== undefined && snapshot === null;
  const providerEvidence = input.acceptance?.record?.providerEvidence;
  const acceptanceEvidenceIncomplete =
    input.acceptance?.record !== null &&
    input.acceptance?.record !== undefined &&
    (providerEvidence === undefined ||
      providerEvidence === null ||
      !providerEvidence.complete ||
      !providerEvidence.reviewEvidenceComplete ||
      !providerEvidence.reviewThreadEvidenceComplete ||
      !providerEvidence.commentEvidenceComplete ||
      !providerEvidence.checkEvidenceComplete ||
      !providerEvidence.requiredChecksKnown);
  const incompleteEvidence =
    snapshot !== null &&
    snapshot !== undefined &&
    (!snapshot.completeness.reviewsComplete ||
      !snapshot.completeness.reviewThreadsComplete ||
      !snapshot.completeness.issueCommentsComplete ||
      !snapshot.completeness.checksComplete ||
      !snapshot.completeness.requiredChecksKnown);
  const headMoved =
    projection !== null &&
    snapshot !== null &&
    snapshot !== undefined &&
    projection.headSha !== snapshot.headSha;
  const failClosedReason =
    monitor?.lastError ??
    (providerRefreshFailed ? "Provider evidence refresh failed." : null) ??
    (terminalMonitor ? "The monitor is terminal or stopped." : null) ??
    (headMoved ? "The candidate head changed; fresh acceptance evidence is required." : null) ??
    (incompleteEvidence || missingEvidence || acceptanceEvidenceIncomplete
      ? "Provider evidence is incomplete; readiness is not verified."
      : null);

  if (projection) {
    const failClosed =
      providerRefreshFailed ||
      terminalMonitor ||
      incompleteEvidence ||
      acceptanceEvidenceIncomplete ||
      missingEvidence ||
      headMoved;
    const execution =
      failClosed && providerRefreshFailed
        ? "Monitoring paused"
        : projection.executionPhase === "paused"
          ? "Monitoring paused"
          : projection.executionPhase === "needs-human"
            ? "Needs human"
            : projection.executionPhase === "verifying"
              ? "Applying feedback"
              : "Working";
    const collaboration =
      projection.collaborationStatus === "exchange-pending"
        ? "Request queued"
        : projection.collaborationStatus === "child-assessment-pending"
          ? "Waiting on child"
          : projection.collaborationStatus === "parent-assessment-pending"
            ? "Waiting on parent"
            : projection.collaborationStatus === "human-input-required"
              ? "Needs human"
              : projection.collaborationStatus === "changes-requested"
                ? "Applying feedback"
                : "Waiting automatically";
    const acceptance =
      providerRefreshFailed || terminalMonitor
        ? "Monitoring"
        : projection.acceptanceLifecycle === "accepted"
          ? "Accepted"
          : projection.acceptanceLifecycle === "monitoring"
            ? "Monitoring"
            : projection.acceptanceLifecycle === "awaiting-review"
              ? "Reviewing candidate"
              : projection.acceptanceLifecycle === "changes-requested"
                ? "Applying feedback"
                : "Working";
    const presentedReadiness = failClosed
      ? "Blocked"
      : projection.readiness === "ready-now"
        ? "Ready now"
        : projection.readiness === "no-known-blockers"
          ? "No known blockers"
          : "Blocked";
    return {
      headline:
        presentedReadiness === "Ready now"
          ? "Ready to merge"
          : execution === "Monitoring paused"
            ? "Automation paused"
            : execution === "Needs human" || collaboration === "Needs human"
              ? "Needs your input"
              : acceptance === "Applying feedback"
                ? "Changes in progress"
                : collaboration,
      execution,
      collaboration,
      acceptance,
      readiness: presentedReadiness,
      blocker: projection.reasons[0] ?? failClosedReason ?? null,
    };
  }

  const readyNow =
    monitor?.status === "ready" &&
    readiness?.ready === true &&
    readiness.label === "ready-to-merge" &&
    input.acceptance?.record !== null &&
    input.acceptance?.record !== undefined &&
    !acceptanceEvidenceIncomplete &&
    !providerRefreshFailed &&
    !terminalMonitor &&
    !incompleteEvidence;
  const acceptanceUnavailable =
    input.acceptance?.record === null || input.acceptance?.record === undefined;
  const execution = providerRefreshFailed
    ? "Monitoring paused"
    : monitor?.status === "monitoring"
      ? "Working"
      : monitor?.status === "ready"
        ? "Monitoring"
        : monitor?.status === "stopped"
          ? "Monitoring paused"
          : "Needs human";
  const collaboration =
    automationReason?.kind === "needs-human"
      ? "Needs human"
      : automationReason?.kind === "waiting-automatic"
        ? "Waiting automatically"
        : input.monitor?.ownerCandidates?.length
          ? "Request queued"
          : "No active exchange";
  const presentedReadiness = readyNow
    ? "Ready now"
    : acceptanceUnavailable ||
        providerRefreshFailed ||
        incompleteEvidence ||
        acceptanceEvidenceIncomplete ||
        missingEvidence ||
        headMoved
      ? "Waiting for evidence"
      : readiness?.label === "no-known-blockers"
        ? "No known blockers"
        : readiness
          ? "Blocked"
          : "Waiting for evidence";
  return {
    headline: readyNow
      ? "Ready to merge"
      : providerRefreshFailed || execution === "Monitoring paused"
        ? "Automation paused"
        : automationReason?.kind === "needs-human"
          ? "Needs your input"
          : acceptanceUnavailable
            ? "Waiting for acceptance"
            : presentedReadiness,
    execution,
    collaboration,
    acceptance:
      input.acceptance?.record !== null && input.acceptance?.record !== undefined
        ? "Monitoring"
        : "Not started",
    readiness: presentedReadiness,
    blocker:
      (acceptanceUnavailable ? "No acceptance run is linked to this pull request yet." : null) ??
      failClosedReason ??
      input.monitor?.automationBlockReason ??
      readiness?.blockers[0]?.detail ??
      readiness?.blockers[0]?.kind ??
      automationReason?.detail ??
      null,
  };
}
