/**
 * Native agent profiles and runs.
 *
 * This module deliberately describes policy, not provider implementation. A
 * profile is an immutable revision once used by a run; providers receive the
 * resolved decisions from the server at their adapter boundary.
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
  TrimmedString,
} from "./baseSchemas.ts";
import { ModelSelection, ProviderInteractionMode, RuntimeMode } from "./orchestration.ts";
import { RuntimeTaskUsage } from "./providerRuntime.ts";
import {
  AgentProfileId,
  AgentProfileLocator,
  AgentProfileRef,
  AgentProfileRevision,
  AgentProfileScope,
  AgentRuleRef,
} from "./agentRefs.ts";

export {
  AgentDocumentRef,
  AgentProfileId,
  AgentProfileLocator,
  AgentProfileRef,
  AgentProfileRevision,
  AgentProfileScope,
  AgentRuleRef,
} from "./agentRefs.ts";

export const AGENT_PROFILE_MAX_NAME_LENGTH = 128;
export const AGENT_PROFILE_MAX_DESCRIPTION_LENGTH = 2_000;
export const AGENT_PROFILE_MAX_INSTRUCTIONS_LENGTH = 32_000;
export const AGENT_PROFILE_MAX_PATH_LENGTH = 512;
export const AGENT_PROFILE_MAX_REFERENCES = 100;
export const AGENT_PROFILE_MAX_HOOKS = 16;
export const AGENT_PROFILE_MAX_TOOLS = 100;
export const AGENT_RUN_MAX_CONCURRENCY = 8;
export const AGENT_RUN_MAX_RUNS = 32;
export const AGENT_RUN_MAX_DELEGATION_DEPTH = 4;
export const AGENT_RUN_MAX_WALL_TIME_MINUTES = 120;
export const AGENT_RUN_MAX_PROMPT_LENGTH = 120_000;
export const AGENT_RUN_MAX_LIST_LIMIT = 32;
export const AGENT_MCP_WAIT_MAX_TIMEOUT_SECONDS = 55;
export const AGENT_HOOK_MAX_TIMEOUT_SECONDS = 300;

const AgentSlug = TrimmedNonEmptyString.check(
  Schema.isMaxLength(64),
  Schema.isPattern(/^[a-zA-Z][a-zA-Z0-9_-]*$/),
);
const AgentRunIdentifier = TrimmedNonEmptyString.check(
  Schema.isMaxLength(64),
  Schema.isPattern(
    /^(?:[a-zA-Z][a-zA-Z0-9_-]*|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/,
  ),
);
const AgentName = TrimmedNonEmptyString.check(Schema.isMaxLength(AGENT_PROFILE_MAX_NAME_LENGTH));
const AgentPath = TrimmedNonEmptyString.check(Schema.isMaxLength(AGENT_PROFILE_MAX_PATH_LENGTH));
const AgentInstructionText = TrimmedString.check(
  Schema.isMaxLength(AGENT_PROFILE_MAX_INSTRUCTIONS_LENGTH),
);
const AgentPrompt = TrimmedNonEmptyString.check(Schema.isMaxLength(AGENT_RUN_MAX_PROMPT_LENGTH));
const AgentRunConcurrency = PositiveInt.check(
  Schema.isLessThanOrEqualTo(AGENT_RUN_MAX_CONCURRENCY),
);
const AgentRunCount = PositiveInt.check(Schema.isLessThanOrEqualTo(AGENT_RUN_MAX_RUNS));
const AgentDelegationDepth = NonNegativeInt.check(
  Schema.isLessThanOrEqualTo(AGENT_RUN_MAX_DELEGATION_DEPTH),
);
const AgentWallTimeMinutes = PositiveInt.check(
  Schema.isLessThanOrEqualTo(AGENT_RUN_MAX_WALL_TIME_MINUTES),
);
const AgentHookTimeoutSeconds = PositiveInt.check(
  Schema.isLessThanOrEqualTo(AGENT_HOOK_MAX_TIMEOUT_SECONDS),
);
const AgentMcpWaitTimeoutSeconds = NonNegativeInt.check(
  Schema.isLessThanOrEqualTo(AGENT_MCP_WAIT_MAX_TIMEOUT_SECONDS),
);

export const AgentRunId = AgentRunIdentifier.pipe(Schema.brand("AgentRunId"));
export type AgentRunId = typeof AgentRunId.Type;

export const AgentHookStage = Schema.Literals([
  "beforeSpawn",
  "promptBuild",
  "afterResult",
  "onError",
  "beforeIntegrate",
  "afterIntegrate",
]);
export type AgentHookStage = typeof AgentHookStage.Type;

export const AgentHookFailurePolicy = Schema.Literals(["block", "warn"]);
export type AgentHookFailurePolicy = typeof AgentHookFailurePolicy.Type;

const AgentHookBase = {
  stage: AgentHookStage,
  timeoutSeconds: AgentHookTimeoutSeconds,
  failurePolicy: AgentHookFailurePolicy,
};

export const AgentHook = Schema.Union([
  Schema.Struct({ ...AgentHookBase, kind: Schema.Literal("context"), path: AgentPath }),
  Schema.Struct({ ...AgentHookBase, kind: Schema.Literal("shell"), command: AgentInstructionText }),
]);
export type AgentHook = typeof AgentHook.Type;

export const AgentProfileRuntime = Schema.Struct({
  mode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
});
export type AgentProfileRuntime = typeof AgentProfileRuntime.Type;

export const AgentWorkspaceMode = Schema.Literals(["shared", "isolated-worktree"]);
export type AgentWorkspaceMode = typeof AgentWorkspaceMode.Type;

export const AgentWorkspaceAccess = Schema.Literals([
  "read-only",
  "workspace-write",
  "full-access",
]);
export type AgentWorkspaceAccess = typeof AgentWorkspaceAccess.Type;

export const AgentProfileWorkspace = Schema.Struct({
  mode: AgentWorkspaceMode,
  access: AgentWorkspaceAccess,
  sharedWriteConcurrency: Schema.optionalKey(AgentRunConcurrency),
});
export type AgentProfileWorkspace = typeof AgentProfileWorkspace.Type;

export const AgentToolPolicy = Schema.Literals(["inherit", "allowlist"]);
export type AgentToolPolicy = typeof AgentToolPolicy.Type;

export const AgentProfileTools = Schema.Struct({
  policy: AgentToolPolicy,
  allowed: Schema.Array(AgentSlug).check(Schema.isMaxLength(AGENT_PROFILE_MAX_TOOLS)),
});
export type AgentProfileTools = typeof AgentProfileTools.Type;

/** A provider-neutral tool identifier usable in profile allowlists. */
export const AgentToolRef = AgentSlug;
export type AgentToolRef = typeof AgentToolRef.Type;

export const AgentDelegationPolicy = Schema.Literals(["disabled", "allowlist"]);
export type AgentDelegationPolicy = typeof AgentDelegationPolicy.Type;

export const AgentProfileDelegation = Schema.Struct({
  policy: AgentDelegationPolicy,
  profiles: Schema.Array(AgentProfileLocator).check(
    Schema.isMaxLength(AGENT_PROFILE_MAX_REFERENCES),
  ),
});
export type AgentProfileDelegation = typeof AgentProfileDelegation.Type;

/** A hard ceiling inherited by every profile-created run and child run. */
export const AgentProfileBudgets = Schema.Struct({
  maxRuns: AgentRunCount,
  maxConcurrency: AgentRunConcurrency,
  maxDepth: AgentDelegationDepth,
  maxWallTimeMinutes: AgentWallTimeMinutes,
  maxTotalTokens: Schema.optionalKey(PositiveInt),
  maxEstimatedCostUsd: Schema.optionalKey(Schema.Number.check(Schema.isGreaterThanOrEqualTo(0))),
});
export type AgentProfileBudgets = typeof AgentProfileBudgets.Type;

export const AgentInstructionPriority = Schema.Literals(["prompt", "system-required"]);
export type AgentInstructionPriority = typeof AgentInstructionPriority.Type;

export const AgentToolRequirement = Schema.Literals(["none", "sandbox", "exact"]);
export type AgentToolRequirement = typeof AgentToolRequirement.Type;

/** T3-owned MCP capabilities required by a profile, kept open for newer hosts. */
export const AgentT3McpCapability = AgentSlug;
export type AgentT3McpCapability = typeof AgentT3McpCapability.Type;

/** Compatibility requirements clients and providers can compare before spawning. */
export const AgentProfileRequirements = Schema.Struct({
  toolRequirement: AgentToolRequirement,
  t3McpCapabilities: Schema.Array(AgentT3McpCapability).check(
    Schema.isMaxLength(AGENT_PROFILE_MAX_TOOLS),
  ),
});
export type AgentProfileRequirements = typeof AgentProfileRequirements.Type;

/** Compact rule row; bodies are loaded only when compiling or editing. */
export const AgentRuleSummary = Schema.Struct({
  id: AgentSlug,
  scope: AgentProfileScope,
  revision: AgentProfileRevision,
  name: AgentName,
  description: Schema.optionalKey(
    TrimmedString.check(Schema.isMaxLength(AGENT_PROFILE_MAX_DESCRIPTION_LENGTH)),
  ),
  globs: Schema.Array(AgentPath).check(Schema.isMaxLength(AGENT_PROFILE_MAX_REFERENCES)),
  alwaysApply: Schema.Boolean,
  priority: Schema.Int.check(Schema.isBetween({ minimum: -100, maximum: 100 })),
  sourcePath: Schema.NullOr(AgentPath),
  updatedAt: IsoDateTime,
  archivedAt: Schema.NullOr(IsoDateTime),
});
export type AgentRuleSummary = typeof AgentRuleSummary.Type;

/** Complete persisted instruction rule. */
export const AgentRule = Schema.Struct({
  ...AgentRuleSummary.fields,
  body: AgentInstructionText,
  profiles: Schema.Array(AgentProfileLocator).check(
    Schema.isMaxLength(AGENT_PROFILE_MAX_REFERENCES),
  ),
  createdAt: IsoDateTime,
});
export type AgentRule = typeof AgentRule.Type;

/** Alias emphasizing that this is the complete checked-in rule document. */
export const AgentRuleDocument = AgentRule;
export type AgentRuleDocument = typeof AgentRuleDocument.Type;

/** Compact row used by profile pickers and catalogs. */
export const AgentProfileSummary = Schema.Struct({
  id: AgentProfileId,
  scope: AgentProfileScope,
  revision: AgentProfileRevision,
  name: AgentName,
  description: Schema.optionalKey(
    TrimmedString.check(Schema.isMaxLength(AGENT_PROFILE_MAX_DESCRIPTION_LENGTH)),
  ),
  defaultModelSelection: Schema.NullOr(ModelSelection),
  /** Whether this profile is offered as a top-level chat choice. Delegation ignores this flag. */
  chatSelectable: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  sourcePath: Schema.NullOr(AgentPath),
  requirements: AgentProfileRequirements,
  archivedAt: Schema.NullOr(IsoDateTime),
  updatedAt: IsoDateTime,
});
export type AgentProfileSummary = typeof AgentProfileSummary.Type;

/**
 * Decision-complete profile. All policy dimensions are present so a run can
 * retain this exact revision even after the source document changes.
 */
export const AgentProfile = Schema.Struct({
  ...AgentProfileSummary.fields,
  instructions: AgentInstructionText,
  instructionPriority: AgentInstructionPriority,
  runtime: AgentProfileRuntime,
  workspace: AgentProfileWorkspace,
  tools: AgentProfileTools,
  delegation: AgentProfileDelegation,
  budgets: AgentProfileBudgets,
  hooks: Schema.Array(AgentHook).check(Schema.isMaxLength(AGENT_PROFILE_MAX_HOOKS)),
  rules: Schema.Array(AgentRuleRef).check(Schema.isMaxLength(AGENT_PROFILE_MAX_REFERENCES)),
  createdAt: IsoDateTime,
});
export type AgentProfile = typeof AgentProfile.Type;

/** Alias emphasizing that this is the durable, complete profile document. */
export const AgentProfileDocument = AgentProfile;
export type AgentProfileDocument = typeof AgentProfileDocument.Type;

export const AgentProfileCatalogInput = Schema.Struct({
  projectId: Schema.optionalKey(ProjectId),
  includeArchived: Schema.optionalKey(Schema.Boolean),
});
export type AgentProfileCatalogInput = typeof AgentProfileCatalogInput.Type;

export const AgentCatalogDiagnosticCode = Schema.Literals([
  "duplicate",
  "invalid-document",
  "invalid-reference",
  "missing-frontmatter",
  "outside-root",
  "read-failed",
  "root-unavailable",
  "truncated",
]);
export type AgentCatalogDiagnosticCode = typeof AgentCatalogDiagnosticCode.Type;

export const AgentCatalogEntryKind = Schema.Literals(["profile", "rule"]);
export type AgentCatalogEntryKind = typeof AgentCatalogEntryKind.Type;

/** A recoverable catalog problem surfaced alongside every valid entry. */
export const AgentCatalogDiagnostic = Schema.Struct({
  code: AgentCatalogDiagnosticCode,
  kind: AgentCatalogEntryKind,
  scope: AgentProfileScope,
  id: Schema.optionalKey(Schema.String),
  sourcePath: Schema.optionalKey(Schema.String),
  message: Schema.String,
});
export type AgentCatalogDiagnostic = typeof AgentCatalogDiagnostic.Type;

export const AgentProfileCatalogResult = Schema.Struct({
  profiles: Schema.Array(AgentProfileSummary).check(
    Schema.isMaxLength(AGENT_PROFILE_MAX_REFERENCES),
  ),
  rules: Schema.Array(AgentRuleSummary).check(Schema.isMaxLength(AGENT_PROFILE_MAX_REFERENCES)),
  diagnostics: Schema.Array(AgentCatalogDiagnostic)
    .check(Schema.isMaxLength(AGENT_PROFILE_MAX_REFERENCES))
    .pipe(Schema.withDecodingDefault(Effect.succeed([]))),
});
export type AgentProfileCatalogResult = typeof AgentProfileCatalogResult.Type;

export const AgentProfileListInput = Schema.Struct({
  scope: Schema.optionalKey(AgentProfileScope),
  projectId: Schema.optionalKey(ProjectId),
  includeArchived: Schema.optionalKey(Schema.Boolean),
  limit: Schema.optionalKey(
    PositiveInt.check(Schema.isLessThanOrEqualTo(AGENT_PROFILE_MAX_REFERENCES)),
  ),
});
export type AgentProfileListInput = typeof AgentProfileListInput.Type;

export const AgentProfileListResult = Schema.Struct({
  profiles: Schema.Array(AgentProfileSummary).check(
    Schema.isMaxLength(AGENT_PROFILE_MAX_REFERENCES),
  ),
});
export type AgentProfileListResult = typeof AgentProfileListResult.Type;

export const AgentProfileGetInput = Schema.Struct({
  id: AgentProfileId,
  scope: AgentProfileScope,
  revision: Schema.optionalKey(AgentProfileRevision),
  projectId: Schema.optionalKey(ProjectId),
});
export type AgentProfileGetInput = typeof AgentProfileGetInput.Type;

export const AgentProfileGetResult = Schema.Struct({
  profile: AgentProfileDocument,
});
export type AgentProfileGetResult = typeof AgentProfileGetResult.Type;

/**
 * `expectedRevision` provides compare-and-swap semantics. Omit it only when
 * creating a new profile; saving an existing profile must pin the revision it
 * was edited from.
 */
export const AgentProfileSaveInput = Schema.Struct({
  profile: AgentProfileDocument,
  expectedRevision: Schema.optionalKey(AgentProfileRevision),
  projectId: Schema.optionalKey(ProjectId),
});
export type AgentProfileSaveInput = typeof AgentProfileSaveInput.Type;

export const AgentProfileSaveResult = Schema.Struct({
  profile: AgentProfileDocument,
});
export type AgentProfileSaveResult = typeof AgentProfileSaveResult.Type;

export const AgentProfileArchiveInput = Schema.Struct({
  id: AgentProfileId,
  scope: AgentProfileScope,
  expectedRevision: AgentProfileRevision,
  projectId: Schema.optionalKey(ProjectId),
});
export type AgentProfileArchiveInput = typeof AgentProfileArchiveInput.Type;

export const AgentProfileArchiveResult = Schema.Struct({
  profile: AgentProfileDocument,
});
export type AgentProfileArchiveResult = typeof AgentProfileArchiveResult.Type;

export const AgentProfileRestoreInput = AgentProfileArchiveInput;
export type AgentProfileRestoreInput = typeof AgentProfileRestoreInput.Type;

export const AgentProfileRestoreResult = AgentProfileArchiveResult;
export type AgentProfileRestoreResult = typeof AgentProfileRestoreResult.Type;

/** Rule operations mirror profile operations: documents are revision-pinned and
 * archived in place so references remain durable. */
export const AgentRuleGetInput = Schema.Struct({
  id: AgentProfileId,
  scope: AgentProfileScope,
  revision: Schema.optionalKey(AgentProfileRevision),
  projectId: Schema.optionalKey(ProjectId),
});
export type AgentRuleGetInput = typeof AgentRuleGetInput.Type;
export const AgentRuleGetResult = Schema.Struct({ rule: AgentRuleDocument });
export type AgentRuleGetResult = typeof AgentRuleGetResult.Type;

export const AgentRuleSaveInput = Schema.Struct({
  rule: AgentRuleDocument,
  expectedRevision: Schema.optionalKey(AgentProfileRevision),
  projectId: Schema.optionalKey(ProjectId),
});
export type AgentRuleSaveInput = typeof AgentRuleSaveInput.Type;
export const AgentRuleSaveResult = Schema.Struct({ rule: AgentRuleDocument });
export type AgentRuleSaveResult = typeof AgentRuleSaveResult.Type;

export const AgentRuleArchiveInput = Schema.Struct({
  id: AgentProfileId,
  scope: AgentProfileScope,
  expectedRevision: AgentProfileRevision,
  projectId: Schema.optionalKey(ProjectId),
});
export type AgentRuleArchiveInput = typeof AgentRuleArchiveInput.Type;
export const AgentRuleArchiveResult = Schema.Struct({ rule: AgentRuleDocument });
export type AgentRuleArchiveResult = typeof AgentRuleArchiveResult.Type;
export const AgentRuleRestoreInput = AgentRuleArchiveInput;
export type AgentRuleRestoreInput = typeof AgentRuleRestoreInput.Type;
export const AgentRuleRestoreResult = AgentRuleArchiveResult;
export type AgentRuleRestoreResult = typeof AgentRuleRestoreResult.Type;

export class AgentProfileNotFoundError extends Schema.TaggedErrorClass<AgentProfileNotFoundError>()(
  "AgentProfileNotFoundError",
  { id: AgentProfileId, scope: AgentProfileScope },
) {
  override get message(): string {
    return `Agent profile '${this.scope}/${this.id}' was not found.`;
  }
}

export class AgentProfileRevisionConflictError extends Schema.TaggedErrorClass<AgentProfileRevisionConflictError>()(
  "AgentProfileRevisionConflictError",
  {
    id: AgentProfileId,
    scope: AgentProfileScope,
    expectedRevision: Schema.optionalKey(AgentProfileRevision),
    actualRevision: Schema.optionalKey(AgentProfileRevision),
  },
) {
  override get message(): string {
    return `Agent profile '${this.scope}/${this.id}' changed from revision ${this.expectedRevision ?? "a new entry"} to ${this.actualRevision ?? "no entry"}.`;
  }
}

export class AgentProfileInvalidError extends Schema.TaggedErrorClass<AgentProfileInvalidError>()(
  "AgentProfileInvalidError",
  {
    detail: TrimmedNonEmptyString,
    operation: Schema.optional(Schema.String),
    profileId: Schema.optional(AgentProfileId),
    runId: Schema.optional(AgentRunId),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.detail;
  }
}

export const AgentProfileError = Schema.Union([
  AgentProfileNotFoundError,
  AgentProfileRevisionConflictError,
  AgentProfileInvalidError,
]);
export type AgentProfileError = typeof AgentProfileError.Type;

// Every profile operation has the same domain failure surface. Keeping these
// named aliases makes endpoint signatures self-documenting without creating
// transport-specific error shapes before RPC is introduced.
export const AgentProfileCatalogError = AgentProfileError;
export type AgentProfileCatalogError = typeof AgentProfileCatalogError.Type;
export const AgentProfileListError = AgentProfileError;
export type AgentProfileListError = typeof AgentProfileListError.Type;
export const AgentProfileGetError = AgentProfileError;
export type AgentProfileGetError = typeof AgentProfileGetError.Type;
export const AgentProfileSaveError = AgentProfileError;
export type AgentProfileSaveError = typeof AgentProfileSaveError.Type;
export const AgentProfileArchiveError = AgentProfileError;
export type AgentProfileArchiveError = typeof AgentProfileArchiveError.Type;
export const AgentProfileRestoreError = AgentProfileError;
export type AgentProfileRestoreError = typeof AgentProfileRestoreError.Type;

export const AgentRuleGetError = AgentProfileError;
export type AgentRuleGetError = typeof AgentRuleGetError.Type;
export const AgentRuleSaveError = AgentProfileError;
export type AgentRuleSaveError = typeof AgentRuleSaveError.Type;
export const AgentRuleArchiveError = AgentProfileError;
export type AgentRuleArchiveError = typeof AgentRuleArchiveError.Type;
export const AgentRuleRestoreError = AgentProfileError;
export type AgentRuleRestoreError = typeof AgentRuleRestoreError.Type;

export const AgentRunStatus = Schema.Literals([
  "queued",
  "running",
  "waiting-for-input",
  "integrating",
  "integrated",
  "succeeded",
  "failed",
  "cancelled",
]);
export type AgentRunStatus = typeof AgentRunStatus.Type;

/** Monotonic runtime revision used by MCP wait/status cursors. */
export const AgentRunRevision = NonNegativeInt;
export type AgentRunRevision = typeof AgentRunRevision.Type;

export const AgentRunSummary = Schema.Struct({
  id: AgentRunId,
  profile: AgentProfileRef,
  status: AgentRunStatus,
  revision: AgentRunRevision,
  childThreadId: Schema.NullOr(ThreadId),
  parentRunId: Schema.NullOr(AgentRunId),
  startedAt: Schema.NullOr(IsoDateTime),
  finishedAt: Schema.NullOr(IsoDateTime),
  updatedAt: IsoDateTime,
  usage: Schema.optionalKey(RuntimeTaskUsage),
  failure: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(2_000))),
});
export type AgentRunSummary = typeof AgentRunSummary.Type;

/** Input for MCP `agent_spawn`. Profile references are intentionally unpinned. */
export const AgentMcpSpawnInput = Schema.Struct({
  profile: AgentProfileLocator,
  task: AgentPrompt,
  projectId: Schema.optionalKey(ProjectId),
  files: Schema.optionalKey(
    Schema.Array(AgentPath).check(Schema.isMaxLength(AGENT_PROFILE_MAX_REFERENCES)),
  ),
  context: Schema.optionalKey(AgentInstructionText),
  detached: Schema.optionalKey(Schema.Boolean),
  parentRunId: Schema.optionalKey(AgentRunId),
});
export type AgentMcpSpawnInput = typeof AgentMcpSpawnInput.Type;

/** Output for MCP `agent_spawn`; `revision` is the initial run revision. */
export const AgentMcpSpawnOutput = Schema.Struct({
  runId: AgentRunId,
  childThreadId: Schema.NullOr(ThreadId),
  status: AgentRunStatus,
  revision: AgentRunRevision,
});
export type AgentMcpSpawnOutput = typeof AgentMcpSpawnOutput.Type;

export const AgentRunStartInput = AgentMcpSpawnInput;
export type AgentRunStartInput = typeof AgentRunStartInput.Type;
export const AgentRunStartResult = AgentMcpSpawnOutput;
export type AgentRunStartResult = typeof AgentRunStartResult.Type;

export const AgentRunGetInput = Schema.Struct({ id: AgentRunId });
export type AgentRunGetInput = typeof AgentRunGetInput.Type;

export const AgentRunGetResult = Schema.Struct({ run: AgentRunSummary });
export type AgentRunGetResult = typeof AgentRunGetResult.Type;

export const AgentRunListInput = Schema.Struct({
  profileId: Schema.optionalKey(AgentProfileId),
  status: Schema.optionalKey(AgentRunStatus),
  limit: Schema.optionalKey(
    PositiveInt.check(Schema.isLessThanOrEqualTo(AGENT_RUN_MAX_LIST_LIMIT)),
  ),
});
export type AgentRunListInput = typeof AgentRunListInput.Type;

export const AgentRunListResult = Schema.Struct({
  runs: Schema.Array(AgentRunSummary).check(Schema.isMaxLength(AGENT_RUN_MAX_LIST_LIMIT)),
});
export type AgentRunListResult = typeof AgentRunListResult.Type;

export const AgentRunCancelInput = Schema.Struct({
  id: AgentRunId,
  reason: Schema.optionalKey(TrimmedString.check(Schema.isMaxLength(2_000))),
});
export type AgentRunCancelInput = typeof AgentRunCancelInput.Type;

export const AgentRunCancelResult = Schema.Struct({ run: AgentRunSummary });
export type AgentRunCancelResult = typeof AgentRunCancelResult.Type;

export const AgentMcpSendInput = Schema.Struct({
  runId: AgentRunId,
  message: AgentPrompt,
});
export type AgentMcpSendInput = typeof AgentMcpSendInput.Type;

export const AgentMcpSendOutput = Schema.Struct({
  runId: AgentRunId,
  status: AgentRunStatus,
  revision: AgentRunRevision,
});
export type AgentMcpSendOutput = typeof AgentMcpSendOutput.Type;

export const AgentRunSubmitInput = AgentMcpSendInput;
export type AgentRunSubmitInput = typeof AgentRunSubmitInput.Type;
export const AgentRunSubmitResult = AgentMcpSendOutput;
export type AgentRunSubmitResult = typeof AgentRunSubmitResult.Type;

export class AgentRunNotFoundError extends Schema.TaggedErrorClass<AgentRunNotFoundError>()(
  "AgentRunNotFoundError",
  { id: AgentRunId },
) {
  override get message(): string {
    return `Agent run '${this.id}' was not found.`;
  }
}

export class AgentRunInvalidStateError extends Schema.TaggedErrorClass<AgentRunInvalidStateError>()(
  "AgentRunInvalidStateError",
  { id: AgentRunId, status: AgentRunStatus, operation: AgentSlug },
) {
  override get message(): string {
    return `Agent run '${this.id}' cannot perform '${this.operation}' while its status is '${this.status}'.`;
  }
}

export const AgentRunError = Schema.Union([AgentRunNotFoundError, AgentRunInvalidStateError]);
export type AgentRunError = typeof AgentRunError.Type;

/** MCP `agent_list`: profile discovery, not a list of already-running agents. */
export const AgentMcpListInput = AgentProfileListInput;
export type AgentMcpListInput = typeof AgentMcpListInput.Type;
export const AgentMcpListOutput = AgentProfileListResult;
export type AgentMcpListOutput = typeof AgentMcpListOutput.Type;

export const AgentMcpLifecycleOperation = Schema.Literals([
  "agent_list",
  "agent_spawn",
  "agent_status",
  "agent_wait",
  "agent_result",
  "agent_send",
  "agent_cancel",
  "agent_integrate",
]);
export type AgentMcpLifecycleOperation = typeof AgentMcpLifecycleOperation.Type;

export const AgentMcpStatusInput = Schema.Struct({ runId: AgentRunId });
export type AgentMcpStatusInput = typeof AgentMcpStatusInput.Type;
export const AgentMcpStatusOutput = Schema.Struct({ run: AgentRunSummary });
export type AgentMcpStatusOutput = typeof AgentMcpStatusOutput.Type;

/** MCP `agent_wait`: resumes when one of the requested runs advances. */
export const AgentMcpWaitInput = Schema.Struct({
  runIds: Schema.Array(AgentRunId).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(AGENT_RUN_MAX_RUNS),
  ),
  afterRevision: Schema.optionalKey(
    Schema.Union([AgentRunRevision, Schema.Record(AgentRunId, AgentRunRevision)]),
  ),
  timeoutSeconds: AgentMcpWaitTimeoutSeconds,
});
export type AgentMcpWaitInput = typeof AgentMcpWaitInput.Type;
export const AgentMcpWaitOutput = Schema.Struct({
  runs: Schema.Array(AgentRunSummary).check(Schema.isMaxLength(AGENT_RUN_MAX_RUNS)),
});
export type AgentMcpWaitOutput = typeof AgentMcpWaitOutput.Type;

export const AgentMcpResultInput = Schema.Struct({
  runId: AgentRunId,
  cursor: Schema.optionalKey(NonNegativeInt),
  limit: Schema.optionalKey(
    PositiveInt.check(Schema.isLessThanOrEqualTo(AGENT_RUN_MAX_LIST_LIMIT)),
  ),
});
export type AgentMcpResultInput = typeof AgentMcpResultInput.Type;
export const AgentMcpResultEntry = Schema.Struct({
  sequence: NonNegativeInt,
  kind: Schema.Literals(["message", "tool", "status"]),
  text: Schema.String.check(Schema.isMaxLength(32_000)),
  createdAt: IsoDateTime,
});
export type AgentMcpResultEntry = typeof AgentMcpResultEntry.Type;
export const AgentMcpResultOutput = Schema.Struct({
  runId: AgentRunId,
  status: AgentRunStatus,
  revision: AgentRunRevision,
  entries: Schema.Array(AgentMcpResultEntry).check(Schema.isMaxLength(AGENT_RUN_MAX_LIST_LIMIT)),
  nextCursor: Schema.NullOr(NonNegativeInt),
  finalMessage: Schema.NullOr(Schema.String.check(Schema.isMaxLength(32_000))),
  diff: Schema.NullOr(Schema.String.check(Schema.isMaxLength(2_000_000))),
  usage: Schema.optionalKey(RuntimeTaskUsage),
});
export type AgentMcpResultOutput = typeof AgentMcpResultOutput.Type;

export const AgentMcpCancelInput = Schema.Struct({
  runId: AgentRunId,
  reason: Schema.optionalKey(TrimmedString.check(Schema.isMaxLength(2_000))),
});
export type AgentMcpCancelInput = typeof AgentMcpCancelInput.Type;
export const AgentMcpCancelOutput = Schema.Struct({
  runId: AgentRunId,
  status: AgentRunStatus,
  revision: AgentRunRevision,
});
export type AgentMcpCancelOutput = typeof AgentMcpCancelOutput.Type;

export const AgentMcpIntegrateInput = Schema.Struct({
  runId: AgentRunId,
  targetThreadId: Schema.optionalKey(ThreadId),
});
export type AgentMcpIntegrateInput = typeof AgentMcpIntegrateInput.Type;
export const AgentMcpIntegrateOutput = Schema.Struct({
  runId: AgentRunId,
  childThreadId: Schema.NullOr(ThreadId),
  status: AgentRunStatus,
  revision: AgentRunRevision,
  integratedAt: IsoDateTime,
});
export type AgentMcpIntegrateOutput = typeof AgentMcpIntegrateOutput.Type;

// Compatibility aliases for the initial draft names. New code should use the
// MCP tool verbs above: list, spawn, status, wait, result, send, cancel, integrate.
export const AgentMcpStartInput = AgentMcpSpawnInput;
export type AgentMcpStartInput = typeof AgentMcpStartInput.Type;
export const AgentMcpStartOutput = AgentMcpSpawnOutput;
export type AgentMcpStartOutput = typeof AgentMcpStartOutput.Type;
export const AgentMcpGetInput = AgentMcpStatusInput;
export type AgentMcpGetInput = typeof AgentMcpGetInput.Type;
export const AgentMcpGetOutput = AgentMcpStatusOutput;
export type AgentMcpGetOutput = typeof AgentMcpGetOutput.Type;
export const AgentMcpSubmitInput = AgentMcpSendInput;
export type AgentMcpSubmitInput = typeof AgentMcpSubmitInput.Type;
export const AgentMcpSubmitOutput = AgentMcpSendOutput;
export type AgentMcpSubmitOutput = typeof AgentMcpSubmitOutput.Type;

// Explicit aliases mirror the MCP tool names in code while retaining the
// compact names above for ordinary TypeScript callers.
export const AgentMcpAgentListInput = AgentMcpListInput;
export type AgentMcpAgentListInput = typeof AgentMcpAgentListInput.Type;
export const AgentMcpAgentListOutput = AgentMcpListOutput;
export type AgentMcpAgentListOutput = typeof AgentMcpAgentListOutput.Type;
export const AgentMcpAgentSpawnInput = AgentMcpSpawnInput;
export type AgentMcpAgentSpawnInput = typeof AgentMcpAgentSpawnInput.Type;
export const AgentMcpAgentSpawnOutput = AgentMcpSpawnOutput;
export type AgentMcpAgentSpawnOutput = typeof AgentMcpAgentSpawnOutput.Type;
export const AgentMcpAgentStatusInput = AgentMcpStatusInput;
export type AgentMcpAgentStatusInput = typeof AgentMcpAgentStatusInput.Type;
export const AgentMcpAgentStatusOutput = AgentMcpStatusOutput;
export type AgentMcpAgentStatusOutput = typeof AgentMcpAgentStatusOutput.Type;
export const AgentMcpAgentWaitInput = AgentMcpWaitInput;
export type AgentMcpAgentWaitInput = typeof AgentMcpAgentWaitInput.Type;
export const AgentMcpAgentWaitOutput = AgentMcpWaitOutput;
export type AgentMcpAgentWaitOutput = typeof AgentMcpAgentWaitOutput.Type;
export const AgentMcpAgentResultInput = AgentMcpResultInput;
export type AgentMcpAgentResultInput = typeof AgentMcpAgentResultInput.Type;
export const AgentMcpAgentResultOutput = AgentMcpResultOutput;
export type AgentMcpAgentResultOutput = typeof AgentMcpAgentResultOutput.Type;
export const AgentMcpAgentSendInput = AgentMcpSendInput;
export type AgentMcpAgentSendInput = typeof AgentMcpAgentSendInput.Type;
export const AgentMcpAgentSendOutput = AgentMcpSendOutput;
export type AgentMcpAgentSendOutput = typeof AgentMcpAgentSendOutput.Type;
export const AgentMcpAgentCancelInput = AgentMcpCancelInput;
export type AgentMcpAgentCancelInput = typeof AgentMcpAgentCancelInput.Type;
export const AgentMcpAgentCancelOutput = AgentMcpCancelOutput;
export type AgentMcpAgentCancelOutput = typeof AgentMcpAgentCancelOutput.Type;
export const AgentMcpAgentIntegrateInput = AgentMcpIntegrateInput;
export type AgentMcpAgentIntegrateInput = typeof AgentMcpAgentIntegrateInput.Type;
export const AgentMcpAgentIntegrateOutput = AgentMcpIntegrateOutput;
export type AgentMcpAgentIntegrateOutput = typeof AgentMcpAgentIntegrateOutput.Type;

// Read in either direction: server code conventionally starts names with
// `Mcp`, while the product domain convention starts with `Agent`. Both aliases
// intentionally point at one codec, not duplicate lifecycle contracts.
export const McpAgentRunStartInput = AgentMcpStartInput;
export type McpAgentRunStartInput = typeof McpAgentRunStartInput.Type;
export const McpAgentRunStartOutput = AgentMcpStartOutput;
export type McpAgentRunStartOutput = typeof McpAgentRunStartOutput.Type;
export const McpAgentRunGetInput = AgentMcpGetInput;
export type McpAgentRunGetInput = typeof McpAgentRunGetInput.Type;
export const McpAgentRunGetOutput = AgentMcpGetOutput;
export type McpAgentRunGetOutput = typeof McpAgentRunGetOutput.Type;
export const McpAgentRunListInput = AgentMcpListInput;
export type McpAgentRunListInput = typeof McpAgentRunListInput.Type;
export const McpAgentRunListOutput = AgentMcpListOutput;
export type McpAgentRunListOutput = typeof McpAgentRunListOutput.Type;
export const McpAgentRunCancelInput = AgentMcpCancelInput;
export type McpAgentRunCancelInput = typeof McpAgentRunCancelInput.Type;
export const McpAgentRunCancelOutput = AgentMcpCancelOutput;
export type McpAgentRunCancelOutput = typeof McpAgentRunCancelOutput.Type;
export const McpAgentRunSubmitInput = AgentMcpSubmitInput;
export type McpAgentRunSubmitInput = typeof McpAgentRunSubmitInput.Type;
export const McpAgentRunSubmitOutput = AgentMcpSubmitOutput;
export type McpAgentRunSubmitOutput = typeof McpAgentRunSubmitOutput.Type;
