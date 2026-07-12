/**
 * User-configurable custom instructions, agent definitions, and task presets.
 *
 * This module is intentionally schema-only. Resolution and prompt injection
 * happen in later layers; these contracts only describe the persisted shape.
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";

import { ProjectId, TrimmedNonEmptyString, TrimmedString } from "./baseSchemas.ts";
import { ProviderOptionSelections } from "./model.ts";
import { ModelSelection } from "./orchestration.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";

const TASK_TYPE_SLUG_MAX_CHARS = 64;
const TASK_TYPE_SLUG_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]*$/;

/** User-extensible task-type identifier. */
export const TaskTypeId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(TASK_TYPE_SLUG_MAX_CHARS),
  Schema.isPattern(TASK_TYPE_SLUG_PATTERN),
).pipe(Schema.brand("TaskTypeId"));
export type TaskTypeId = typeof TaskTypeId.Type;

/** Seed task types surfaced by the initial settings UI. */
export const WELL_KNOWN_TASK_TYPES = ["plan", "implement", "review", "investigate"] as const;

export const InstructionEntryId = TrimmedNonEmptyString.pipe(Schema.brand("InstructionEntryId"));
export type InstructionEntryId = typeof InstructionEntryId.Type;

const GlobalInstructionScope = Schema.Struct({
  kind: Schema.Literal("global"),
});

const ProviderInstructionScope = Schema.Struct({
  kind: Schema.Literal("provider"),
  driver: ProviderDriverKind,
});

const ModelInstructionScope = Schema.Struct({
  kind: Schema.Literal("model"),
  instanceId: ProviderInstanceId,
  model: TrimmedNonEmptyString,
});

const TaskTypeInstructionScope = Schema.Struct({
  kind: Schema.Literal("taskType"),
  taskType: TaskTypeId,
});

export const InstructionScope = Schema.Union([
  GlobalInstructionScope,
  ProviderInstructionScope,
  ModelInstructionScope,
  TaskTypeInstructionScope,
]);
export type InstructionScope = typeof InstructionScope.Type;

export const InstructionEntry = Schema.Struct({
  id: InstructionEntryId,
  scope: InstructionScope,
  text: TrimmedString,
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
});
export type InstructionEntry = typeof InstructionEntry.Type;

export const AgentDefinitionId = TrimmedNonEmptyString.pipe(Schema.brand("AgentDefinitionId"));
export type AgentDefinitionId = typeof AgentDefinitionId.Type;

/**
 * Kept structurally identical to `SubAgentName` without importing it: the
 * import would create `settings -> customInstructions -> subAgents -> server
 * -> settings` during ESM initialization.
 */
const AgentDefinitionName = Schema.String.pipe(
  Schema.decodeTo(
    Schema.String,
    SchemaTransformation.transformOrFail({
      decode: (value) =>
        Effect.succeed(
          value
            .replace(/[\u0000-\u001F\u007F-\u009F]+/g, " ")
            .replace(/\s+/g, " ")
            .trim(),
        ),
      encode: (value) => Effect.succeed(value),
    }),
  ),
).check(Schema.isNonEmpty());

const InstanceAgentDefinitionTarget = Schema.Struct({
  kind: Schema.Literal("instance"),
  instanceId: ProviderInstanceId,
});

const DriverAgentDefinitionTarget = Schema.Struct({
  kind: Schema.Literal("driver"),
  driver: ProviderDriverKind,
});

export const AgentDefinitionTarget = Schema.Union([
  InstanceAgentDefinitionTarget,
  DriverAgentDefinitionTarget,
]);
export type AgentDefinitionTarget = typeof AgentDefinitionTarget.Type;

export const AgentDefinition = Schema.Struct({
  id: AgentDefinitionId,
  name: AgentDefinitionName,
  description: Schema.optional(TrimmedString),
  taskType: Schema.optional(TaskTypeId),
  target: AgentDefinitionTarget,
  model: Schema.optional(TrimmedNonEmptyString),
  modelOptions: Schema.optional(ProviderOptionSelections),
  prompt: TrimmedString,
});
export type AgentDefinition = typeof AgentDefinition.Type;

export const TaskPresetId = TrimmedNonEmptyString.pipe(Schema.brand("TaskPresetId"));
export type TaskPresetId = typeof TaskPresetId.Type;

export const TaskPreset = Schema.Struct({
  id: TaskPresetId,
  name: TrimmedNonEmptyString,
  taskType: TaskTypeId,
  modelSelection: ModelSelection,
  instructionRefs: Schema.optional(Schema.Array(InstructionEntryId)),
  extraInstructions: Schema.optional(TrimmedString),
});
export type TaskPreset = typeof TaskPreset.Type;

export const CustomInstructionsBundle = Schema.Struct({
  instructions: Schema.Array(InstructionEntry).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  agents: Schema.Array(AgentDefinition).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  presets: Schema.Array(TaskPreset).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
});
export type CustomInstructionsBundle = typeof CustomInstructionsBundle.Type;

export const CustomInstructionsConfig = Schema.Struct({
  global: CustomInstructionsBundle.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  projects: Schema.Record(ProjectId, CustomInstructionsBundle).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
});
export type CustomInstructionsConfig = typeof CustomInstructionsConfig.Type;

export const DEFAULT_CUSTOM_INSTRUCTIONS_CONFIG: CustomInstructionsConfig = Schema.decodeSync(
  CustomInstructionsConfig,
)({});
