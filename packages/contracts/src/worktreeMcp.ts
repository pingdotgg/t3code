import * as Schema from "effect/Schema";

import {
  EnvironmentId,
  NodeId,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ManagedCloudSandboxResourceId } from "./managedCloudSandbox.ts";

export const WorktreeIsolation = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("filesystem") }),
  Schema.Struct({
    kind: Schema.Literal("sandbox").annotate({
      description:
        "Create an owned disk fork. Requires Linked environments enabled on the source before allocation; selecting sandbox authorizes enabling it on the newly created child for its necessary peer link. Existing or attached environments are never enabled automatically.",
    }),
    operationId: ManagedCloudSandboxResourceId,
    size: Schema.optionalKey(TrimmedNonEmptyString),
    autoStopMinutes: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0))),
  }),
]);

/** Uses the managed worktree folder; handoff detaches the provider, ending this turn and resuming there next run. */
export const WorktreeMcpHandoffInput = Schema.Struct({
  branch: TrimmedNonEmptyString,
  isolation: Schema.optionalKey(WorktreeIsolation),
  baseRef: Schema.optional(
    TrimmedNonEmptyString.annotate({
      description: "Default: checked-out branch.",
    }),
  ),
  startFromOrigin: Schema.optional(
    Schema.Boolean.annotate({
      description:
        "True: fetch, start from the remote ref; check `startedFromOrigin`. Default: server setting.",
    }),
  ),
  runSetupScript: Schema.optional(
    Schema.Boolean.annotate({
      description: "Default true.",
    }),
  ),
  continuationPrompt: Schema.optional(
    TrimmedNonEmptyString.check(Schema.isMaxLength(120_000)).annotate({
      description: "Work to resume in the worktree next turn. Omitted: thread waits.",
    }),
  ),
});
export type WorktreeMcpHandoffInput = typeof WorktreeMcpHandoffInput.Type;

export const WorktreeMcpSetupScriptStatus = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("started"),
    scriptName: TrimmedNonEmptyString,
    terminalId: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    status: Schema.Literal("no-script"),
  }),
  Schema.Struct({
    status: Schema.Literal("skipped"),
  }),
  Schema.Struct({
    status: Schema.Literal("failed"),
    detail: Schema.String,
  }),
]);
export type WorktreeMcpSetupScriptStatus = typeof WorktreeMcpSetupScriptStatus.Type;

export const WorktreeMcpContinuationStatus = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("scheduled"),
    delivery: Schema.Literals(["started", "queued", "steered", "restarted"]),
  }),
  Schema.Struct({
    status: Schema.Literal("skipped"),
  }),
  Schema.Struct({
    status: Schema.Literal("failed"),
    detail: Schema.String,
  }),
]);
export type WorktreeMcpContinuationStatus = typeof WorktreeMcpContinuationStatus.Type;

export const FilesystemWorktreeHandoffResult = Schema.Struct({
  kind: Schema.Literal("filesystem"),
  worktreePath: TrimmedNonEmptyString,
  branch: TrimmedNonEmptyString,
  baseRef: TrimmedNonEmptyString,
  startedFromOrigin: Schema.Boolean,
  setupScript: WorktreeMcpSetupScriptStatus,
  continuation: WorktreeMcpContinuationStatus,
  note: Schema.String,
});
export const SandboxWorktreeHandoffResult = Schema.Struct({
  kind: Schema.Literal("sandbox"),
  workspaceId: TrimmedNonEmptyString,
  resourceId: TrimmedNonEmptyString,
  environmentId: EnvironmentId,
  projectId: ProjectId,
  threadId: ThreadId,
  taskId: NodeId,
  workspacePath: TrimmedNonEmptyString,
  branch: TrimmedNonEmptyString,
  note: Schema.String,
});
export type SandboxWorktreeHandoffResult = typeof SandboxWorktreeHandoffResult.Type;
export const WorktreeMcpHandoffResult = Schema.Union([
  FilesystemWorktreeHandoffResult,
  SandboxWorktreeHandoffResult,
]);
export type WorktreeMcpHandoffResult = typeof WorktreeMcpHandoffResult.Type;

export const SandboxWorkspaceDeleteInput = Schema.Struct({ workspaceId: TrimmedNonEmptyString });
export const SandboxWorkspaceDeleteResult = Schema.Struct({
  workspaceId: TrimmedNonEmptyString,
  deleted: Schema.Boolean,
});

export const WorktreeMcpStatusResult = Schema.Struct({
  attached: Schema.Boolean,
  worktreePath: Schema.NullOr(TrimmedNonEmptyString),
  branch: Schema.NullOr(TrimmedNonEmptyString),
  projectWorkspaceRoot: TrimmedNonEmptyString,
  defaultStartFromOrigin: Schema.Boolean.annotate({
    description: "`startFromOrigin` default for `t3_worktree_handoff`.",
  }),
});
export type WorktreeMcpStatusResult = typeof WorktreeMcpStatusResult.Type;

export class WorktreeMcpFailure extends Schema.TaggedError<WorktreeMcpFailure>()(
  "WorktreeMcpFailure",
  {
    code: Schema.Literals([
      "capability_denied",
      "thread_not_found",
      "project_not_found",
      "already_in_worktree",
      "handoff_in_progress",
      "invalid_request",
      "operation_failed",
      "thread_credential_required",
    ]),
    message: Schema.String,
  },
) {}
