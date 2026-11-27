import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString, TrimmedString } from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";

/** A configured model and, in order, the ones that stand in while it cannot run. */
export const CustomOrchestrationModel = Schema.Struct({
  modelSelection: ModelSelection,
  fallbacks: Schema.Array(ModelSelection).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
});
export type CustomOrchestrationModel = typeof CustomOrchestrationModel.Type;

/** A kind of work, and the model the orchestrator delegates it to. */
export const CustomOrchestrationTask = Schema.Struct({
  id: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  /** When the orchestrator should treat work as this kind. */
  description: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  ...CustomOrchestrationModel.fields,
});
export type CustomOrchestrationTask = typeof CustomOrchestrationTask.Type;

/** A composer slash command that has several models check the same work. */
export const CustomOrchestrationCommand = Schema.Struct({
  /** Typed as `/name`. */
  name: TrimmedNonEmptyString,
  instructions: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  reviewers: Schema.Array(CustomOrchestrationModel),
});
export type CustomOrchestrationCommand = typeof CustomOrchestrationCommand.Type;

// Loose on purpose: one rejected value would reset the whole settings file. Writes are
// validated by `CustomOrchestrationSettingsWrite`.
export const CustomOrchestrationSettings = Schema.Struct({
  orchestrator: Schema.NullOr(CustomOrchestrationModel).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  tasks: Schema.Array(CustomOrchestrationTask).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  commands: Schema.Array(CustomOrchestrationCommand).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
});
export type CustomOrchestrationSettings = typeof CustomOrchestrationSettings.Type;

export const CUSTOM_ORCHESTRATION_MAX_ENTRIES = 20;
export const CUSTOM_ORCHESTRATION_MAX_FALLBACKS = 3;
export const CUSTOM_ORCHESTRATION_NAME_MAX_LENGTH = 64;
export const CUSTOM_ORCHESTRATION_DESCRIPTION_MAX_LENGTH = 300;
export const CUSTOM_ORCHESTRATION_INSTRUCTIONS_MAX_LENGTH = 4_000;

export const CUSTOM_ORCHESTRATION_COMMAND_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/u;

/** Slash commands T3 Code or a provider already answers. A plain `/review` stays the harness's. */
const RESERVED_CUSTOM_ORCHESTRATION_COMMAND_NAMES: ReadonlySet<string> = new Set([
  "btw",
  "clear",
  "compact",
  "default",
  "feedback",
  "goal",
  "logout",
  "model",
  "plan",
  "review",
  "side",
]);

export type CustomOrchestrationCommandNameProblem = "format" | "reserved" | "too-long";

export function customOrchestrationCommandNameProblem(
  name: string,
): CustomOrchestrationCommandNameProblem | null {
  if (name.length > CUSTOM_ORCHESTRATION_NAME_MAX_LENGTH) return "too-long";
  if (!CUSTOM_ORCHESTRATION_COMMAND_NAME_PATTERN.test(name)) return "format";
  return RESERVED_CUSTOM_ORCHESTRATION_COMMAND_NAMES.has(name) ? "reserved" : null;
}

const unique = (values: ReadonlyArray<string>) => new Set(values).size === values.length;

export const CustomOrchestrationSettingsWrite = CustomOrchestrationSettings.check(
  Schema.makeFilter(({ orchestrator, tasks, commands }) => {
    const models = [
      ...(orchestrator === null ? [] : [orchestrator]),
      ...tasks,
      ...commands.flatMap((command) => command.reviewers),
    ];
    if (models.some((model) => model.fallbacks.length > CUSTOM_ORCHESTRATION_MAX_FALLBACKS)) {
      return "Too many fallback models.";
    }
    if (
      tasks.length > CUSTOM_ORCHESTRATION_MAX_ENTRIES ||
      commands.length > CUSTOM_ORCHESTRATION_MAX_ENTRIES
    ) {
      return "Too many task kinds or commands.";
    }
    if (!unique(tasks.map((task) => task.id))) return "Task kind ids must be unique.";
    if (
      tasks.some(
        (task) =>
          task.name.length > CUSTOM_ORCHESTRATION_NAME_MAX_LENGTH ||
          task.description.length > CUSTOM_ORCHESTRATION_DESCRIPTION_MAX_LENGTH,
      )
    ) {
      return "A task kind name or description is too long.";
    }
    if (!unique(commands.map((command) => command.name))) return "Command names must be unique.";
    if (commands.some((command) => customOrchestrationCommandNameProblem(command.name) !== null)) {
      return "A command name is reserved or not lowercase letters, digits and hyphens.";
    }
    if (
      commands.some(
        (command) =>
          command.reviewers.length === 0 ||
          command.reviewers.length > CUSTOM_ORCHESTRATION_MAX_ENTRIES ||
          command.instructions.length > CUSTOM_ORCHESTRATION_INSTRUCTIONS_MAX_LENGTH,
      )
    ) {
      return "A command needs at least one reviewer and shorter instructions.";
    }
    return true;
  }),
);
