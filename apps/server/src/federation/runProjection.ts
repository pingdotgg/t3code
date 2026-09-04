import type {
  EnvironmentId,
  FederationArtifactRef,
  FederationRun,
  FederationRunEvent,
  FederationRunStatus,
  OrchestrationCheckpointSummary,
  OrchestrationEvent,
  OrchestrationLatestTurnState,
  OrchestrationThreadShell,
  ThreadId,
} from "@t3tools/contracts";

/**
 * Pure projections from orchestration state onto the federation protocol.
 * Runs are threads the peer started; the projection deliberately exposes the
 * few facts a coordinating environment needs and nothing about the rest of
 * the thread.
 */

export const FEDERATION_PREVIEW_MAX_CHARS = 240;

export function federationRunStatus(
  state: OrchestrationLatestTurnState | null,
): FederationRunStatus {
  switch (state) {
    case null:
      return "queued";
    case "running":
      return "running";
    case "completed":
      return "completed";
    case "interrupted":
      return "interrupted";
    case "error":
      return "error";
  }
}

export function truncatePreview(text: string, max = FEDERATION_PREVIEW_MAX_CHARS): string {
  const collapsed = text.replace(/\s+/gu, " ").trim();
  return collapsed.length <= max ? collapsed : `${collapsed.slice(0, max - 1)}…`;
}

export function projectFederationRun(input: {
  readonly environmentId: EnvironmentId;
  readonly thread: OrchestrationThreadShell;
  readonly assistantPreview: string | null;
  readonly turnCount: number;
}): FederationRun {
  const latestTurn = input.thread.latestTurn;
  return {
    environmentId: input.environmentId,
    projectId: input.thread.projectId,
    threadId: input.thread.id,
    turnId: latestTurn?.turnId ?? null,
    title: input.thread.title,
    status: federationRunStatus(latestTurn?.state ?? null),
    runtimeMode: input.thread.runtimeMode,
    modelSelection: input.thread.modelSelection,
    requestedAt: latestTurn?.requestedAt ?? input.thread.createdAt,
    startedAt: latestTurn?.startedAt ?? null,
    completedAt: latestTurn?.completedAt ?? null,
    assistantPreview: input.assistantPreview,
    turnCount: input.turnCount,
  };
}

export function isFederationRunActive(run: FederationRun): boolean {
  return run.status === "queued" || run.status === "running";
}

/** Summarizes one persisted event for a peer; null when it carries nothing worth relaying. */
export function summarizeFederationRunEvent(
  event: OrchestrationEvent,
  threadId: ThreadId,
): FederationRunEvent | null {
  if (event.aggregateKind !== "thread" || event.aggregateId !== threadId) {
    return null;
  }
  const base = { sequence: event.sequence, at: event.occurredAt, type: event.type };
  switch (event.type) {
    case "thread.message-sent":
      return {
        ...base,
        summary: `${event.payload.role}: ${truncatePreview(event.payload.text)}`,
      };
    case "thread.turn-start-requested":
      return { ...base, summary: "Turn started" };
    case "thread.turn-interrupt-requested":
      return { ...base, summary: "Interrupt requested" };
    case "thread.session-set":
      return {
        ...base,
        summary: event.payload.session.lastError
          ? `Session ${event.payload.session.status}: ${truncatePreview(event.payload.session.lastError)}`
          : `Session ${event.payload.session.status}`,
      };
    case "thread.turn-diff-completed":
      return {
        ...base,
        summary: `Changes recorded (${event.payload.files.length} ${event.payload.files.length === 1 ? "file" : "files"})`,
      };
    case "thread.activity-appended":
      return { ...base, summary: truncatePreview(event.payload.activity.summary) };
    default:
      return null;
  }
}

export function projectFederationArtifacts(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly checkpoints: ReadonlyArray<OrchestrationCheckpointSummary>;
}): ReadonlyArray<FederationArtifactRef> {
  return input.checkpoints
    .filter((checkpoint) => checkpoint.status === "ready" && checkpoint.checkpointTurnCount > 0)
    .map((checkpoint) => ({
      environmentId: input.environmentId,
      threadId: input.threadId,
      turnId: checkpoint.turnId,
      kind: "turn-diff" as const,
      fromTurnCount: checkpoint.checkpointTurnCount - 1,
      toTurnCount: checkpoint.checkpointTurnCount,
      files: checkpoint.files.map((file) => ({ path: file.path, status: file.kind })),
    }));
}
