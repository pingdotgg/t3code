import type {
  BoardId,
  IsoDateTime,
  LaneKey,
  MessageId,
  PipelineRunId,
  ProjectId,
  StepRunId,
  TicketAttachment,
  TicketId,
  WorkflowBoardMetrics,
  WorkflowBoardProposalView,
  WorkflowDefinitionEncoded,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { WorkflowEventStoreError } from "./Errors.ts";

export interface BoardRow {
  readonly boardId: string;
  readonly projectId: string;
  readonly name: string;
  readonly workflowFilePath: string;
  readonly workflowVersionHash: string;
  readonly maxConcurrentTickets: number;
}

export interface BoardListRow {
  readonly boardId: string;
  readonly name: string;
  readonly filePath: string;
}

export interface TicketPrView {
  readonly number: number;
  readonly url: string;
  readonly state: "open" | "merged" | "closed";
  readonly ciState?: "pending" | "success" | "failure";
}

// One actionable lane transition offered to a human, mirroring the
// WorkflowLaneAction shape ({ label, to, hint? }) from the board definition.
export interface WorkflowLaneActionRow {
  readonly label: string;
  readonly to: string;
  readonly hint?: string;
}

// The ticket's current lane resolved from the board definition — name and the
// human-facing actions available from here. Falls back to key-only when the
// board definition is not registered.
export interface WorkflowCurrentLaneRow {
  readonly key: string;
  readonly name: string;
  readonly actions: ReadonlyArray<WorkflowLaneActionRow>;
}

// "waiting_for_approval" | "waiting_for_input" | "blocked" — kept loose here so
// the read model does not depend on the contracts enum; the RPC layer narrows.
export type TicketAttentionKind = string;

export interface TicketPrStateRow {
  readonly prNumber: number;
  readonly prUrl: string;
  readonly branch: string;
  readonly remoteName: string;
  readonly repo: string;
  readonly prState: string;
  readonly lastHeadSha: string | null;
  readonly lastCiState: string | null;
  readonly lastReviewDecision: string | null;
  readonly lastCommentCursor: string | null;
}

export interface TicketRow {
  readonly ticketId: string;
  readonly boardId: string;
  readonly title: string;
  readonly description: string | null;
  readonly currentLaneKey: string;
  readonly currentLaneEntryToken: string | null;
  readonly status: string;
  readonly queuedAt: string | null;
  readonly totalTokens: number | null;
  readonly totalDurationMs: number | null;
  // Blocked-by edges; optional so non-dependency readers stay untouched.
  readonly dependsOn?: ReadonlyArray<string>;
  readonly unresolvedDependencyCount?: number;
  readonly tokenBudget?: number | null;
  readonly updatedAt?: string;
  // PR view — present when a workflow_pr_state row exists for this ticket.
  readonly pr?: TicketPrView;
  // Attention fields — projected onto the ticket; null when the ticket is not
  // in a needs-you state.
  readonly attentionKind?: TicketAttentionKind | null;
  readonly attentionReason?: string | null;
  // Current lane detail (key/name/actions) — present on detail reads, resolved
  // from the board definition.
  readonly currentLane?: WorkflowCurrentLaneRow;
}

// A ticket awaiting human attention across the boards in this environment's DB,
// joined with its board name. Mirrors WorkflowNeedsAttentionTicketView (T1).
export interface WorkflowNeedsAttentionTicketRow {
  readonly ticketId: string;
  readonly boardId: string;
  readonly boardName: string;
  readonly title: string;
  readonly status: string;
  readonly currentLaneKey: string;
  readonly attentionKind: TicketAttentionKind | null;
  readonly attentionReason: string | null;
  readonly updatedAt: string;
}

export interface BoardDigestRow {
  readonly windowHours: number;
  readonly createdCount: number;
  readonly shippedCount: number;
  readonly totalTokens: number;
  readonly totalDurationMs: number;
  readonly needsAttention: ReadonlyArray<{
    readonly ticketId: string;
    readonly title: string;
    readonly status: string;
    readonly laneKey: string;
    readonly sinceMs: number;
  }>;
}

// A queued dependent whose last unresolved dependency just resolved — the
// admission sweep should visit its lane.
export interface ReleasableDependentRow {
  readonly ticketId: string;
  readonly boardId: string;
  readonly laneKey: string;
}

export interface TicketMessageRow {
  readonly messageId: MessageId;
  readonly ticketId: TicketId;
  readonly stepRunId: StepRunId | null;
  readonly author: "agent" | "user";
  readonly body: string;
  readonly attachments: ReadonlyArray<TicketAttachment>;
  readonly createdAt: string;
  readonly editedAt: IsoDateTime | null;
}

/**
 * Lightweight discussion row for agent instruction context — deliberately
 * carries only an attachment count so listing a long thread never decodes
 * attachment data URLs.
 */
export interface TicketDiscussionRow {
  readonly author: "agent" | "user";
  readonly body: string;
  readonly createdAt: string;
  readonly attachmentCount: number;
}

export interface RouteDecisionStepSnapshot {
  readonly status: string;
  readonly exitCode: number | null;
  // Bounded highlight only — raw captured output stays on the step run.
  readonly verdict: string | null;
}

/**
 * Why a ticket arrived in a lane, derived from the event log:
 * TicketRouteDecided events (automatic routing, with snapshot highlights)
 * plus manual TicketMovedToLane events. Snapshot fields are null when the
 * stored snapshot is missing or malformed.
 */
export interface TicketRouteDecisionRow {
  readonly occurredAt: string;
  readonly fromLane: string | null;
  readonly toLane: string;
  readonly source:
    | "step_on"
    | "lane_transition"
    | "lane_on"
    | "manual"
    | "external_event"
    | "work_source";
  readonly matchedTransitionIndex: number | null;
  readonly eventName: string | null;
  readonly pipelineResult: "success" | "failure" | "blocked" | null;
  readonly laneRunCount: number | null;
  readonly steps: Readonly<Record<string, RouteDecisionStepSnapshot>> | null;
}

export interface StepRunRow {
  readonly stepRunId: string;
  readonly stepKey: string;
  readonly stepType: string;
  readonly attempt: number | null;
  readonly status: string;
  readonly waitingReason: string | null;
  readonly blockedReason: string | null;
  readonly providerResponseKind: "request" | "user-input" | null;
  readonly scriptThreadId: string | null;
  readonly terminalId: string | null;
  readonly scriptStatus: string | null;
  readonly exitCode: number | null;
  readonly signal: number | null;
  readonly output: unknown | null;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly providerThreadId: string | null;
  readonly inputTokens: number | null;
  readonly cachedInputTokens: number | null;
  readonly outputTokens: number | null;
  readonly totalTokens: number | null;
}

export interface PipelineStepRunRow {
  readonly stepKey: string;
  readonly stepType: string;
  readonly status: string;
  readonly exitCode: number | null;
  readonly output: unknown | null;
}

export interface TicketDetail {
  readonly ticket: TicketRow;
  readonly steps: ReadonlyArray<StepRunRow>;
  readonly messages: ReadonlyArray<TicketMessageRow>;
  readonly syncedSource?: {
    readonly provider: "github" | "asana" | "jira";
    readonly url: string;
    readonly assignees?: ReadonlyArray<string>;
    readonly labels?: ReadonlyArray<string>;
  };
}

export interface WorkflowReadModelShape {
  readonly registerBoard: (board: {
    readonly boardId: BoardId;
    readonly projectId: ProjectId;
    readonly name: string;
    readonly workflowFilePath: string;
    readonly workflowVersionHash: string;
    readonly maxConcurrentTickets: number;
  }) => Effect.Effect<void, WorkflowEventStoreError>;
  readonly getBoard: (boardId: BoardId) => Effect.Effect<BoardRow | null, WorkflowEventStoreError>;
  readonly deleteBoard: (boardId: BoardId) => Effect.Effect<void, WorkflowEventStoreError>;
  readonly deleteBoardTicketState: (
    boardId: BoardId,
  ) => Effect.Effect<void, WorkflowEventStoreError>;
  readonly deleteTicketState: (ticketId: TicketId) => Effect.Effect<void, WorkflowEventStoreError>;
  readonly listBoardsForProject: (
    projectId: ProjectId,
  ) => Effect.Effect<ReadonlyArray<BoardListRow>, WorkflowEventStoreError>;
  readonly listTickets: (
    boardId: BoardId,
  ) => Effect.Effect<ReadonlyArray<TicketRow>, WorkflowEventStoreError>;
  readonly countAdmittedInLane: (
    boardId: BoardId,
    laneKey: LaneKey,
  ) => Effect.Effect<number, WorkflowEventStoreError>;
  readonly oldestQueuedForLane: (
    boardId: BoardId,
    laneKey: LaneKey,
  ) => Effect.Effect<TicketRow | null, WorkflowEventStoreError>;
  readonly getTicketDetail: (
    ticketId: TicketId,
  ) => Effect.Effect<TicketDetail | null, WorkflowEventStoreError>;
  readonly listTicketMessages: (
    ticketId: TicketId,
  ) => Effect.Effect<ReadonlyArray<TicketMessageRow>, WorkflowEventStoreError>;
  // The newest `limit` messages in chronological order, attachment counts
  // only — cheap enough to call on every agent step.
  readonly listTicketDiscussion: (
    ticketId: TicketId,
    limit: number,
  ) => Effect.Effect<ReadonlyArray<TicketDiscussionRow>, WorkflowEventStoreError>;
  readonly listTicketRouteDecisions: (
    ticketId: TicketId,
  ) => Effect.Effect<ReadonlyArray<TicketRouteDecisionRow>, WorkflowEventStoreError>;
  readonly listReleasableDependents: (
    ticketId: TicketId,
  ) => Effect.Effect<ReadonlyArray<ReleasableDependentRow>, WorkflowEventStoreError>;
  // Every ticket that depends on the given one, regardless of state — used to
  // republish their views when the dependency's resolution changes.
  readonly listDependentTicketIds: (
    ticketId: TicketId,
  ) => Effect.Effect<ReadonlyArray<string>, WorkflowEventStoreError>;
  readonly getBoardDigest: (
    boardId: BoardId,
    windowHours: number,
  ) => Effect.Effect<BoardDigestRow, WorkflowEventStoreError>;
  // Read-only board-scoped aggregation for the metrics dashboard. windowDays is
  // clamped to {1,7,30} (defaults to 7). Cycle-time percentiles are computed in
  // TypeScript because SQLite has no PERCENTILE_CONT.
  readonly getBoardMetrics: (
    boardId: BoardId,
    windowDays: number,
  ) => Effect.Effect<WorkflowBoardMetrics, WorkflowEventStoreError>;
  // Every ticket awaiting human attention (waiting_on_user / blocked) across
  // the boards in this DB, joined with board name, oldest-touched first. The WS
  // connection is environment-scoped, so no environment filter is needed.
  readonly listNeedsAttentionTickets: () => Effect.Effect<
    ReadonlyArray<WorkflowNeedsAttentionTicketRow>,
    WorkflowEventStoreError
  >;
  // Pipeline runs (including the given one) this ticket has had in the same
  // lane — feeds the lane.runCount routing variable for bounded loops.
  readonly countLanePipelineRuns: (
    pipelineRunId: PipelineRunId,
  ) => Effect.Effect<number, WorkflowEventStoreError>;
  readonly listStepRunsForPipeline: (
    pipelineRunId: PipelineRunId,
  ) => Effect.Effect<ReadonlyArray<PipelineStepRunRow>, WorkflowEventStoreError>;
  // Full workflow_pr_state row for a ticket, or null when no PR has been opened.
  readonly getTicketPrState: (
    ticketId: TicketId,
  ) => Effect.Effect<TicketPrStateRow | null, WorkflowEventStoreError>;
  // Insert a board-improvement proposal row (self-improve, E4). All JSON
  // columns are pre-encoded strings — the caller owns encode/redact.
  readonly recordBoardProposal: (
    proposal: BoardProposalInsert,
  ) => Effect.Effect<void, WorkflowEventStoreError>;
  // List all proposals for a board, pending-first then by created_at DESC.
  // The `outdated` flag is computed against the board's CURRENT versionHash.
  readonly listBoardProposals: (
    boardId: BoardId,
  ) => Effect.Effect<ReadonlyArray<WorkflowBoardProposalView>, WorkflowEventStoreError>;
  // Get a single proposal by proposalId; returns null when not found.
  // Includes the full proposed + base encoded definitions.
  readonly getBoardProposal: (proposalId: string) => Effect.Effect<
    {
      view: WorkflowBoardProposalView;
      proposedDefinition: WorkflowDefinitionEncoded;
      baseDefinition: WorkflowDefinitionEncoded;
    } | null,
    WorkflowEventStoreError
  >;
  // Lane keys on this board that currently hold live work: either a
  // non-terminal admitted ticket (terminal_at IS NULL AND
  // current_lane_entry_token IS NOT NULL) or a running pipeline. Feeds the
  // resolve-approve live-compatibility gate (modified lane × live work).
  readonly listLiveOccupiedLanes: (
    boardId: BoardId,
  ) => Effect.Effect<ReadonlyArray<string>, WorkflowEventStoreError>;
  // Transition a proposal's status (resolve-approve / reject / supersede),
  // optionally stamping resolved_at + applied_version_hash, under a single DB
  // transaction. Idempotent at the caller: only flips a row when it is still in
  // an expected source status, returning the resulting row count.
  readonly resolveBoardProposalStatus: (input: {
    readonly proposalId: string;
    readonly status: string;
    readonly resolvedAt: string;
    readonly appliedVersionHash?: string | null;
    readonly fromStatus?: string;
  }) => Effect.Effect<number, WorkflowEventStoreError>;
  readonly listWorkSourceMappingsForBoard: (
    boardId: BoardId,
  ) => Effect.Effect<ReadonlyArray<WorkSourceMappingRow>, WorkflowEventStoreError>;
}

export interface WorkSourceMappingRow {
  readonly provider: string;
  readonly sourceId: string;
  readonly externalId: string;
  readonly ticketId: string;
  readonly currentLaneKey: string;
}

export interface BoardProposalInsert {
  readonly proposalId: string;
  readonly boardId: BoardId;
  readonly baseVersionHash: string;
  readonly baseDefJson: string;
  readonly agentJson: string;
  readonly proposedDefJson: string;
  readonly rationale: string;
  readonly validationJson: string;
  readonly status: string;
  readonly createdAt: string;
}

export class WorkflowReadModel extends Context.Service<WorkflowReadModel, WorkflowReadModelShape>()(
  "t3/workflow/Services/WorkflowReadModel",
) {}
