import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { NonNegativeInt, PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

const TrimmedNonEmptyStringSchema = TrimmedNonEmptyString;

const RuntimeTurnState = Schema.Literals(["completed", "failed", "interrupted", "cancelled"]);
export type RuntimeTurnState = typeof RuntimeTurnState.Type;

const RuntimeItemStatus = Schema.Literals(["inProgress", "completed", "failed", "declined"]);
export type RuntimeItemStatus = typeof RuntimeItemStatus.Type;

const TOOL_LIFECYCLE_ITEM_TYPES = [
  "command_execution",
  "file_change",
  "mcp_tool_call",
  "dynamic_tool_call",
  "collab_agent_tool_call",
  "web_search",
  "image_view",
] as const;

export const ToolLifecycleItemType = Schema.Literals(TOOL_LIFECYCLE_ITEM_TYPES);
export type ToolLifecycleItemType = typeof ToolLifecycleItemType.Type;

export function isToolLifecycleItemType(value: string): value is ToolLifecycleItemType {
  return TOOL_LIFECYCLE_ITEM_TYPES.includes(value as ToolLifecycleItemType);
}

export const ThreadTokenUsageSnapshot = Schema.Struct({
  usedTokens: NonNegativeInt,
  totalProcessedTokens: Schema.optional(NonNegativeInt),
  maxTokens: Schema.optional(PositiveInt),
  inputTokens: Schema.optional(NonNegativeInt),
  cachedInputTokens: Schema.optional(NonNegativeInt),
  outputTokens: Schema.optional(NonNegativeInt),
  reasoningOutputTokens: Schema.optional(NonNegativeInt),
  lastUsedTokens: Schema.optional(NonNegativeInt),
  lastInputTokens: Schema.optional(NonNegativeInt),
  lastCachedInputTokens: Schema.optional(NonNegativeInt),
  lastOutputTokens: Schema.optional(NonNegativeInt),
  lastReasoningOutputTokens: Schema.optional(NonNegativeInt),
  toolUses: Schema.optional(NonNegativeInt),
  durationMs: Schema.optional(NonNegativeInt),
  compactsAutomatically: Schema.optional(Schema.Boolean),
  autoCompactThreshold: Schema.optional(PositiveInt),
  cost: Schema.optional(
    Schema.Struct({
      amount: Schema.Number.check(Schema.isFinite()),
      currency: TrimmedNonEmptyStringSchema.check(Schema.isMaxLength(32)),
    }),
  ),
});
export type ThreadTokenUsageSnapshot = typeof ThreadTokenUsageSnapshot.Type;

// Input includes cache reads/writes; output includes the optional reasoningTokens subset.
const TurnTokenUsageCommonFields = {
  usageScope: Schema.Literal("main_agent"),
  cachedInputTokens: Schema.optional(NonNegativeInt),
  cacheCreationTokens: Schema.optional(NonNegativeInt),
  reasoningTokens: Schema.optional(NonNegativeInt),
  hasSubagents: Schema.Boolean,
};
export const TurnTokenUsage = Schema.Union([
  Schema.Struct({
    ...TurnTokenUsageCommonFields,
    usageStatus: Schema.Literal("complete"),
    inputTokens: NonNegativeInt,
    outputTokens: NonNegativeInt,
  }),
  Schema.Struct({
    ...TurnTokenUsageCommonFields,
    usageStatus: Schema.Literals(["partial", "unavailable"]),
    inputTokens: Schema.optional(NonNegativeInt),
    outputTokens: Schema.optional(NonNegativeInt),
  }),
]);
export type TurnTokenUsage = typeof TurnTokenUsage.Type;

export const ToolActivitySurface = Schema.Literals(["browser", "computer"]);
export type ToolActivitySurface = typeof ToolActivitySurface.Type;

export const ToolActivityNativeAppReference = Schema.Union([
  Schema.TaggedStruct("app-id", {
    appId: TrimmedNonEmptyStringSchema.check(
      Schema.isMaxLength(512),
      Schema.isPattern(/^[A-Za-z0-9._-]+$/u),
    ),
  }),
  Schema.TaggedStruct("display-name", {
    displayName: TrimmedNonEmptyStringSchema.check(Schema.isMaxLength(160)),
  }),
]);
export type ToolActivityNativeAppReference = typeof ToolActivityNativeAppReference.Type;

export const ToolActivityIcon = Schema.Union([
  Schema.TaggedStruct("website", {
    pageUrl: TrimmedNonEmptyStringSchema.check(Schema.isMaxLength(4096)),
    faviconUrl: Schema.optional(TrimmedNonEmptyStringSchema.check(Schema.isMaxLength(4096))),
    faviconUrlDark: Schema.optional(TrimmedNonEmptyStringSchema.check(Schema.isMaxLength(4096))),
  }),
  Schema.TaggedStruct("native-app", {
    app: ToolActivityNativeAppReference,
  }),
  Schema.TaggedStruct("themed-logo", {
    logoUrl: TrimmedNonEmptyStringSchema.check(Schema.isMaxLength(4096)),
    logoUrlDark: Schema.optional(TrimmedNonEmptyStringSchema.check(Schema.isMaxLength(4096))),
  }),
]);
export type ToolActivityIcon = typeof ToolActivityIcon.Type;

export const ToolActivitySource = Schema.Struct({
  key: TrimmedNonEmptyStringSchema.check(Schema.isMaxLength(512)),
  name: TrimmedNonEmptyStringSchema.check(Schema.isMaxLength(160)),
  kind: Schema.Literals(["browser", "computer", "integration"]),
  icon: Schema.optional(ToolActivityIcon),
});
export type ToolActivitySource = typeof ToolActivitySource.Type;

const UserInputQuestionOption = Schema.Struct({
  label: TrimmedNonEmptyStringSchema,
  description: Schema.String,
  value: Schema.optional(Schema.String),
});

export const UserInputQuestion = Schema.Struct({
  id: TrimmedNonEmptyStringSchema,
  header: TrimmedNonEmptyStringSchema,
  question: TrimmedNonEmptyStringSchema,
  options: Schema.Array(UserInputQuestionOption),
  allowCustomAnswer: Schema.optional(Schema.Boolean),
  initialAnswer: Schema.optional(Schema.String),
  multiSelect: Schema.optional(Schema.Boolean).pipe(
    Schema.withConstructorDefault(Effect.succeed(false)),
  ),
});
export type UserInputQuestion = typeof UserInputQuestion.Type;
