import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

export const PluginPackageId = Schema.String.check(
  Schema.isPattern(/^[a-z0-9][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]*)+$/),
  Schema.isMaxLength(255),
);
export type PluginPackageId = typeof PluginPackageId.Type;

export const PluginPackageCapability = Schema.String.check(
  Schema.isPattern(/^[a-z0-9][a-z0-9.-]*@[1-9]\d*$/),
);
export type PluginPackageCapability = typeof PluginPackageCapability.Type;

export const PluginPackageState = Schema.Literals(["disabled", "active", "error"]);
export type PluginPackageState = typeof PluginPackageState.Type;

export const PluginPackageContributions = Schema.Struct({
  commands: Schema.Array(PluginPackageId),
});
export type PluginPackageContributions = typeof PluginPackageContributions.Type;

export const PluginPackageStatus = Schema.Struct({
  id: PluginPackageId,
  version: TrimmedNonEmptyString,
  apiVersion: Schema.Literal(1),
  enabled: Schema.Boolean,
  state: PluginPackageState,
  capabilities: Schema.Array(PluginPackageCapability),
  contributions: PluginPackageContributions,
  error: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(2_000))),
});
export type PluginPackageStatus = typeof PluginPackageStatus.Type;

export const PluginPackageDiscoveryError = Schema.Struct({
  directory: TrimmedNonEmptyString.check(Schema.isMaxLength(255), Schema.isPattern(/^[^/\\]+$/)),
  error: TrimmedNonEmptyString.check(Schema.isMaxLength(2_000)),
});
export type PluginPackageDiscoveryError = typeof PluginPackageDiscoveryError.Type;

export const PluginPackageStatusSnapshot = Schema.Struct({
  errors: Schema.Array(PluginPackageDiscoveryError),
  packages: Schema.Array(PluginPackageStatus),
});
export type PluginPackageStatusSnapshot = typeof PluginPackageStatusSnapshot.Type;

export const PluginPackageActionInput = Schema.Struct({
  id: PluginPackageId,
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type PluginPackageActionInput = typeof PluginPackageActionInput.Type;

export const PluginPackageOperation = Schema.Literals(["status", "enable", "disable", "reload"]);
export type PluginPackageOperation = typeof PluginPackageOperation.Type;

export class PluginPackageNotFoundError extends Schema.TaggedErrorClass<PluginPackageNotFoundError>()(
  "PluginPackageNotFoundError",
  { id: PluginPackageId },
) {
  override get message(): string {
    return `Plugin package not found: ${this.id}`;
  }
}

export class PluginPackageOperationError extends Schema.TaggedErrorClass<PluginPackageOperationError>()(
  "PluginPackageOperationError",
  {
    id: Schema.optional(PluginPackageId),
    operation: PluginPackageOperation,
    detail: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(2_000))),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    const packageName = this.id === undefined ? "plugin packages" : `plugin package ${this.id}`;
    const detail = this.detail === undefined ? "" : `: ${this.detail}`;
    return `${this.operation} failed for ${packageName}${detail}`;
  }
}
