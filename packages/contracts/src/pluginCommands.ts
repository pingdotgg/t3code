import * as Schema from "effect/Schema";

import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const PluginCommandId = TrimmedNonEmptyString.check(Schema.isMaxLength(200));
export type PluginCommandId = typeof PluginCommandId.Type;

export const PluginCommandSurface = Schema.Literals(["web", "desktop", "mobile"]);
export type PluginCommandSurface = typeof PluginCommandSurface.Type;

export const PluginCommand = Schema.Struct({
  id: PluginCommandId,
  label: TrimmedNonEmptyString.check(Schema.isMaxLength(120)),
  description: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(500))),
  surfaces: Schema.Array(PluginCommandSurface).check(Schema.isMinLength(1)),
});
export type PluginCommand = typeof PluginCommand.Type;

export const PluginCommandCatalog = Schema.Struct({
  generation: NonNegativeInt,
  commands: Schema.Array(PluginCommand),
});
export type PluginCommandCatalog = typeof PluginCommandCatalog.Type;

export const PluginCommandInvokeInput = Schema.Struct({
  generation: NonNegativeInt,
  id: PluginCommandId,
});
export type PluginCommandInvokeInput = typeof PluginCommandInvokeInput.Type;

export const PluginCommandInvocationResult = Schema.Struct({
  message: TrimmedNonEmptyString.check(Schema.isMaxLength(500)),
  tone: Schema.Literals(["info", "success"]),
});
export type PluginCommandInvocationResult = typeof PluginCommandInvocationResult.Type;

export class PluginCommandNotFoundError extends Schema.TaggedErrorClass<PluginCommandNotFoundError>()(
  "PluginCommandNotFoundError",
  { id: PluginCommandId },
) {
  override get message(): string {
    return `Plugin command not found: ${this.id}`;
  }
}

export class PluginCommandCatalogChangedError extends Schema.TaggedErrorClass<PluginCommandCatalogChangedError>()(
  "PluginCommandCatalogChangedError",
  {
    actualGeneration: NonNegativeInt,
    expectedGeneration: NonNegativeInt,
  },
) {
  override get message(): string {
    return `Plugin command catalog changed from generation ${this.expectedGeneration} to ${this.actualGeneration}`;
  }
}

export class PluginCommandInvocationError extends Schema.TaggedErrorClass<PluginCommandInvocationError>()(
  "PluginCommandInvocationError",
  {
    cause: Schema.Defect(),
    id: PluginCommandId,
    message: TrimmedNonEmptyString.check(Schema.isMaxLength(500)),
  },
) {}
