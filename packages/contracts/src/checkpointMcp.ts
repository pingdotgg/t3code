import * as Schema from "effect/Schema";

import {
  CheckpointId,
  CheckpointScopeId,
  IsoDateTime,
  NodeId,
  NonNegativeInt,
  PositiveInt,
  ProviderThreadId,
  RunId,
  ThreadId,
} from "./baseSchemas.ts";
import { OrchestrationV2CheckpointFileSummary } from "./orchestrationV2.ts";

const CheckpointMcpListLimit = PositiveInt.check(Schema.isLessThanOrEqualTo(100));
const CheckpointMcpFileLimit = NonNegativeInt.check(Schema.isLessThanOrEqualTo(100));
const CheckpointMcpDiffLimit = PositiveInt.check(Schema.isLessThanOrEqualTo(100_000));

export const CheckpointMcpListInput = Schema.Struct({
  threadId: Schema.optional(ThreadId).annotate({
    description:
      "Thread to inspect. Defaults to the calling thread and must belong to its project.",
  }),
  cursor: Schema.optional(NonNegativeInt).annotate({
    description: "Zero-based checkpoint cursor. Defaults to 0.",
  }),
  limit: Schema.optional(CheckpointMcpListLimit).annotate({
    description: "Maximum checkpoints to return. Defaults to 25; maximum 100.",
  }),
  fileLimit: Schema.optional(CheckpointMcpFileLimit).annotate({
    description: "Maximum file summaries per checkpoint. Defaults to 20; maximum 100.",
  }),
});
export type CheckpointMcpListInput = typeof CheckpointMcpListInput.Type;

export const CheckpointMcpAvailability = Schema.Literals([
  "available",
  "ref_missing",
  "metadata_incomplete",
  "unreadable",
]);
export type CheckpointMcpAvailability = typeof CheckpointMcpAvailability.Type;

export const CheckpointMcpRestoreBlocker = Schema.Literals([
  "thread_archived",
  "thread_active",
  "checkpoint_not_ready",
  "scope_missing",
  "ref_unavailable",
  "active_provider_thread_missing",
  "provider_thread_mismatch",
  "provider_session_missing",
  "provider_rollback_unsupported",
  "provider_snapshot_unsupported",
  "provider_turn_missing",
]);
export type CheckpointMcpRestoreBlocker = typeof CheckpointMcpRestoreBlocker.Type;

export const CheckpointMcpScopeSummary = Schema.Struct({
  scopeId: CheckpointScopeId,
  runId: Schema.NullOr(RunId),
  nodeId: NodeId,
  parentScopeId: Schema.NullOr(CheckpointScopeId),
  providerThreadId: Schema.NullOr(ProviderThreadId),
  kind: Schema.Literals(["root_run", "subagent", "tool", "provider_thread", "manual"]),
  ordinalWithinParent: NonNegativeInt,
  advancesAppRunCount: Schema.Boolean,
  workspacePath: Schema.String,
  createdAt: IsoDateTime,
});
export type CheckpointMcpScopeSummary = typeof CheckpointMcpScopeSummary.Type;

export const CheckpointMcpSummary = Schema.Struct({
  checkpointId: CheckpointId,
  scopeId: CheckpointScopeId,
  threadId: ThreadId,
  runId: Schema.NullOr(RunId),
  nodeId: NodeId,
  parentCheckpointId: Schema.NullOr(CheckpointId),
  ordinalWithinScope: NonNegativeInt,
  appRunOrdinal: Schema.NullOr(PositiveInt),
  status: Schema.Literals(["ready", "missing", "error", "stale"]),
  capturedAt: IsoDateTime,
  scope: Schema.NullOr(CheckpointMcpScopeSummary),
  files: Schema.Array(OrchestrationV2CheckpointFileSummary),
  fileCount: NonNegativeInt,
  filesTruncated: Schema.Boolean,
  availability: CheckpointMcpAvailability,
  availabilityDetail: Schema.NullOr(Schema.String),
  restoreSupport: Schema.Struct({
    supported: Schema.Boolean,
    blockers: Schema.Array(CheckpointMcpRestoreBlocker),
  }),
});
export type CheckpointMcpSummary = typeof CheckpointMcpSummary.Type;

export const CheckpointMcpListResult = Schema.Struct({
  currentThreadId: ThreadId,
  threadId: ThreadId,
  checkpoints: Schema.Array(CheckpointMcpSummary),
  nextCursor: Schema.NullOr(NonNegativeInt),
  total: NonNegativeInt,
});
export type CheckpointMcpListResult = typeof CheckpointMcpListResult.Type;

export const CheckpointMcpDiffInput = Schema.Struct({
  threadId: Schema.optional(ThreadId).annotate({
    description:
      "Thread to inspect. Defaults to the calling thread and must belong to its project.",
  }),
  scopeId: CheckpointScopeId.annotate({
    description: "Durable checkpoint scope identity returned by t3_checkpoint_list.",
  }),
  checkpointId: CheckpointId.annotate({
    description: "Target checkpoint identity returned by t3_checkpoint_list.",
  }),
  fromCheckpointId: Schema.optional(CheckpointId).annotate({
    description:
      "Baseline checkpoint in the same scope. Defaults to the target checkpoint's parent, or the target itself when it has no parent.",
  }),
  cursor: Schema.optional(NonNegativeInt).annotate({
    description: "UTF-16 code-unit cursor into the computed patch. Defaults to 0.",
  }),
  limit: Schema.optional(CheckpointMcpDiffLimit).annotate({
    description: "Maximum UTF-16 code units to return. Defaults to 20000; maximum 100000.",
  }),
  ignoreWhitespace: Schema.optional(Schema.Boolean).annotate({
    description: "Ignore whitespace-only changes. Defaults to true.",
  }),
});
export type CheckpointMcpDiffInput = typeof CheckpointMcpDiffInput.Type;

export const CheckpointMcpDiffResult = Schema.Struct({
  threadId: ThreadId,
  scopeId: CheckpointScopeId,
  fromCheckpointId: CheckpointId,
  checkpointId: CheckpointId,
  diff: Schema.String,
  cursor: NonNegativeInt,
  nextCursor: Schema.NullOr(NonNegativeInt),
  totalLength: NonNegativeInt,
  truncated: Schema.Boolean,
});
export type CheckpointMcpDiffResult = typeof CheckpointMcpDiffResult.Type;

export class CheckpointMcpFailure extends Schema.TaggedErrorClass<CheckpointMcpFailure>()(
  "CheckpointMcpFailure",
  {
    code: Schema.Literals([
      "capability_denied",
      "thread_not_found",
      "scope_mismatch",
      "checkpoint_not_found",
      "checkpoint_unavailable",
      "invalid_request",
      "unsupported",
      "operation_failed",
    ]),
    message: Schema.String,
  },
) {}
