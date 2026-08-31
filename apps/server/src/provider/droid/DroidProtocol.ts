import * as Schema from "effect/Schema";

// factory-mono: protocol/session/settings/schema.ts
export const DroidTokenUsage = Schema.Struct({
  inputTokens: Schema.Number,
  outputTokens: Schema.Number,
  cacheCreationTokens: Schema.Number,
  cacheReadTokens: Schema.Number,
  thinkingTokens: Schema.Number,
  factoryCredits: Schema.optional(Schema.Number),
});
export type DroidTokenUsage = typeof DroidTokenUsage.Type;

export const DroidLastCallTokenUsage = Schema.Struct({
  inputTokens: Schema.Number,
  cacheReadTokens: Schema.Number,
  outputTokens: Schema.optional(Schema.Number),
});
export type DroidLastCallTokenUsage = typeof DroidLastCallTokenUsage.Type;

// factory-mono: protocol/llm/enums.ts
export const DroidReasoningEffort = Schema.Literals([
  "none",
  "dynamic",
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);
export type DroidReasoningEffort = typeof DroidReasoningEffort.Type;

// factory-mono: protocol/models/schemas.ts
export const DroidModelInfo = Schema.Struct({
  id: Schema.String,
  displayName: Schema.String,
  shortDisplayName: Schema.String,
  modelProvider: Schema.String,
  supportedReasoningEfforts: Schema.Array(DroidReasoningEffort),
  defaultReasoningEffort: DroidReasoningEffort,
  disabled: Schema.optional(Schema.Boolean),
});
export type DroidModelInfo = typeof DroidModelInfo.Type;

// factory-mono: protocol/droid/schemas/client.ts
export const DroidInitializeSessionResult = Schema.Struct({
  sessionId: Schema.String,
});
export type DroidInitializeSessionResult = typeof DroidInitializeSessionResult.Type;

export const DroidLoadSessionResult = Schema.Struct({
  tokenUsage: Schema.optional(DroidTokenUsage),
  inclusiveTokenUsage: Schema.optional(DroidTokenUsage),
  lastCallTokenUsage: Schema.optional(DroidLastCallTokenUsage),
});
export type DroidLoadSessionResult = typeof DroidLoadSessionResult.Type;

export const DroidExecuteRewindResult = Schema.Struct({
  newSessionId: Schema.String,
});
export type DroidExecuteRewindResult = typeof DroidExecuteRewindResult.Type;

export const DroidCommandInfo = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  argumentHint: Schema.optional(Schema.String),
});
export type DroidCommandInfo = typeof DroidCommandInfo.Type;

const DroidSkillLocation = Schema.Literals(["project", "personal", "builtin", "automation"]);

export const DroidSkillInfo = Schema.Struct({
  name: Schema.String,
  description: Schema.optional(Schema.String),
  location: DroidSkillLocation,
  filePath: Schema.String,
  enabled: Schema.optional(Schema.Boolean),
  userInvocable: Schema.optional(Schema.Boolean),
});
export type DroidSkillInfo = typeof DroidSkillInfo.Type;

export const DroidListModelsResult = Schema.Struct({
  models: Schema.Array(DroidModelInfo),
});

export const DroidListCommandsResult = Schema.Struct({
  commands: Schema.Array(DroidCommandInfo),
});

export const DroidListSkillsResult = Schema.Struct({
  skills: Schema.Array(DroidSkillInfo),
});

// factory-mono: protocol/droid/schemas/cli.ts
export const DroidToolUse = Schema.Struct({
  id: Schema.String,
  input: Schema.Record(Schema.String, Schema.Unknown),
  name: Schema.String,
});
export type DroidToolUse = typeof DroidToolUse.Type;

const DroidAskUserQuestion = Schema.Struct({
  index: Schema.Number,
  topic: Schema.String,
  question: Schema.String,
  options: Schema.Array(Schema.String),
  multiSelect: Schema.optional(Schema.Boolean),
});

const DroidEditToolConfirmationDetails = Schema.Struct({
  type: Schema.Literal("edit"),
  filePath: Schema.String,
});

const DroidExecuteToolConfirmationDetails = Schema.Struct({
  type: Schema.Literal("exec"),
  fullCommand: Schema.String,
  command: Schema.String,
});

const DroidCreateToolConfirmationDetails = Schema.Struct({
  type: Schema.Literal("create"),
  filePath: Schema.String,
});

const DroidAskUserConfirmationDetails = Schema.Struct({
  type: Schema.Literal("ask_user"),
  questionnaire: Schema.String,
});

const DroidExitSpecModeConfirmationDetails = Schema.Struct({
  type: Schema.Literal("exit_spec_mode"),
  plan: Schema.String,
  title: Schema.optional(Schema.String),
});

const DroidProposeMissionConfirmationDetails = Schema.Struct({
  type: Schema.Literal("propose_mission"),
  proposal: Schema.String,
  title: Schema.optional(Schema.String),
});

const DroidStartMissionRunConfirmationDetails = Schema.Struct({
  type: Schema.Literal("start_mission_run"),
  runningMissionCount: Schema.Number,
});

const DroidApplyPatchToolConfirmationDetails = Schema.Struct({
  type: Schema.Literal("apply_patch"),
  filePath: Schema.String,
  files: Schema.optional(
    Schema.Array(
      Schema.Struct({
        filePath: Schema.String,
      }),
    ),
  ),
});

const DroidMcpToolConfirmationDetails = Schema.Struct({
  type: Schema.Literal("mcp_tool"),
  toolName: Schema.String,
  serverName: Schema.optional(Schema.String),
  actualToolName: Schema.optional(Schema.String),
});

const DroidSandboxViolationConfirmationDetails = Schema.Struct({
  type: Schema.Literal("sandbox_violation"),
  violatingToolName: Schema.String,
  target: Schema.String,
  operationType: Schema.Literals(["read", "write", "network", "tool"]),
  reason: Schema.String,
});

const DroidShieldViolationConfirmationDetails = Schema.Struct({
  type: Schema.Literal("droid_shield_violation"),
  command: Schema.String,
  reason: Schema.String,
});

export const DroidToolConfirmationDetails = Schema.Union([
  DroidEditToolConfirmationDetails,
  DroidExecuteToolConfirmationDetails,
  DroidCreateToolConfirmationDetails,
  DroidAskUserConfirmationDetails,
  DroidExitSpecModeConfirmationDetails,
  DroidProposeMissionConfirmationDetails,
  DroidStartMissionRunConfirmationDetails,
  DroidApplyPatchToolConfirmationDetails,
  DroidMcpToolConfirmationDetails,
  DroidSandboxViolationConfirmationDetails,
  DroidShieldViolationConfirmationDetails,
]);
export type DroidToolConfirmationDetails = typeof DroidToolConfirmationDetails.Type;

/**
 * Open string, not a literal set: the droid CLI versions its outcome
 * vocabulary independently of this server, and a closed set would fail the
 * whole permission-request decode (hanging the turn) the first time a newer
 * CLI ships a new outcome. Classification happens where outcomes are
 * consumed (selectDroidPermissionOutcome), which ignores unknown values.
 */
export const DroidPermissionOutcome = Schema.String;
export type DroidPermissionOutcome = typeof DroidPermissionOutcome.Type;

export const DroidPermissionOption = Schema.Struct({
  label: Schema.String,
  outcome: DroidPermissionOutcome,
}).pipe(
  Schema.encodeKeys({
    outcome: "value",
  }),
);
export type DroidPermissionOption = typeof DroidPermissionOption.Type;

const DroidPermissionRequestFields = {
  toolUses: Schema.Array(
    Schema.Struct({
      toolUse: DroidToolUse,
      details: DroidToolConfirmationDetails,
    }),
  ).check(Schema.isNonEmpty()),
  options: Schema.Array(DroidPermissionOption),
} as const;

export const DroidPermissionRequest = Schema.Struct(DroidPermissionRequestFields);
export type DroidPermissionRequest = typeof DroidPermissionRequest.Type;

export const DroidAskUserRequest = Schema.Struct({
  toolCallId: Schema.String,
  questions: Schema.Array(DroidAskUserQuestion),
});
export type DroidAskUserRequest = typeof DroidAskUserRequest.Type;

const AssistantTextDelta = Schema.Struct({
  type: Schema.Literal("assistant_text_delta"),
  messageId: Schema.String,
  textDelta: Schema.String,
});

const AssistantTextComplete = Schema.Struct({
  type: Schema.Literal("assistant_text_complete"),
  messageId: Schema.String,
});

const ThinkingTextDelta = Schema.Struct({
  type: Schema.Literal("thinking_text_delta"),
  messageId: Schema.String,
  textDelta: Schema.String,
});

const ThinkingTextComplete = Schema.Struct({
  type: Schema.Literal("thinking_text_complete"),
  messageId: Schema.String,
});

const ToolCall = Schema.Struct({
  type: Schema.Literal("tool_call"),
  toolUse: DroidToolUse,
});

const ToolResult = Schema.Struct({
  type: Schema.Literal("tool_result"),
  toolUseId: Schema.String,
  isError: Schema.optional(Schema.Boolean),
});

const ToolProgressUpdate = Schema.Struct({
  type: Schema.Literal("tool_progress_update"),
  toolUseId: Schema.String,
  toolName: Schema.String,
  update: Schema.Struct({
    status: Schema.optional(Schema.String),
    details: Schema.optional(Schema.String),
    text: Schema.optional(Schema.String),
    error: Schema.optional(Schema.String),
    valueSnippet: Schema.optional(Schema.String),
    subagentSessionId: Schema.optional(Schema.String),
  }),
});

const CreateMessage = Schema.Struct({
  type: Schema.Literal("create_message"),
  message: Schema.Unknown,
});

export const DroidAgentTurnCompleted = Schema.Struct({
  type: Schema.Literal("agent_turn_completed"),
  reason: Schema.String,
  turnId: Schema.optional(Schema.String),
  tokenUsage: DroidTokenUsage,
  cumulativeTokenUsage: Schema.optional(DroidTokenUsage),
});
export type DroidAgentTurnCompleted = typeof DroidAgentTurnCompleted.Type;

const SessionTokenUsageChanged = Schema.Struct({
  type: Schema.Literal("session_token_usage_changed"),
  tokenUsage: DroidTokenUsage,
  inclusiveTokenUsage: Schema.optional(DroidTokenUsage),
  lastCallTokenUsage: Schema.optional(DroidLastCallTokenUsage),
});

const ErrorNotification = Schema.Struct({
  type: Schema.Literal("error"),
  message: Schema.String,
});

const LlmRetry = Schema.Struct({
  type: Schema.Literal("llm_retry"),
  attempt: Schema.Number,
});

const SessionTitleUpdated = Schema.Struct({
  type: Schema.Literal("session_title_updated"),
  title: Schema.String,
});

const ChildSessionAvailable = Schema.Struct({
  type: Schema.Literal("child_session_available"),
  childSessionId: Schema.String,
  toolUseId: Schema.optional(Schema.String),
  subagentType: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
});

const SessionCompacted = Schema.Struct({
  type: Schema.Literal("session_compacted"),
  summaryId: Schema.String,
  removedCount: Schema.Number,
  visibleBoundaryMessageId: Schema.NullOr(Schema.String),
});

const StructuredOutput = Schema.Struct({
  type: Schema.Literal("structured_output"),
  messageId: Schema.String,
  structuredOutput: Schema.NullOr(Schema.Record(Schema.String, Schema.Unknown)),
});

export const DroidSessionNotification = Schema.Union([
  AssistantTextDelta,
  AssistantTextComplete,
  ThinkingTextDelta,
  ThinkingTextComplete,
  ToolCall,
  ToolResult,
  ToolProgressUpdate,
  CreateMessage,
  DroidAgentTurnCompleted,
  SessionTokenUsageChanged,
  ErrorNotification,
  LlmRetry,
  SessionTitleUpdated,
  ChildSessionAvailable,
  SessionCompacted,
  StructuredOutput,
]);
export type DroidSessionNotification = typeof DroidSessionNotification.Type;

export const knownDroidSessionNotificationTypes: ReadonlySet<string> = new Set(
  DroidSessionNotification.members.map((member) => member.fields.type.literal),
);
