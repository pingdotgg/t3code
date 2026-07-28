import * as Schema from "effect/Schema";

import { HermesGatewayCompatibilityStatus } from "./hermesGateway.ts";

/**
 * Native Hermes skills are read and reloaded directly through the gateway's
 * `skills.manage` / `skills.reload` protocol. Hermes remains the owner of the
 * skill inventory; these values are projections, never local state.
 */
export const HermesGatewaySkillsListResult = Schema.Struct({
  // Hermes returns either a flat entry array or a category -> entries map
  // (`{"skills": {category: [names...]}}`); accept both wire shapes.
  skills: Schema.Union([
    Schema.Array(Schema.Unknown),
    Schema.Record(Schema.String, Schema.Unknown),
  ]),
});
export type HermesGatewaySkillsListResult = typeof HermesGatewaySkillsListResult.Type;

export const HermesGatewaySkillsHubEntry = Schema.Struct({
  name: Schema.String,
  description: Schema.optional(Schema.String),
});
export type HermesGatewaySkillsHubEntry = typeof HermesGatewaySkillsHubEntry.Type;

export const HermesGatewaySkillsSearchResult = Schema.Struct({
  results: Schema.Array(HermesGatewaySkillsHubEntry),
});
export type HermesGatewaySkillsSearchResult = typeof HermesGatewaySkillsSearchResult.Type;

export const HermesGatewaySkillsInspectResult = Schema.Struct({
  info: Schema.Record(Schema.String, Schema.Unknown),
});
export type HermesGatewaySkillsInspectResult = typeof HermesGatewaySkillsInspectResult.Type;

export const HermesGatewaySkillsReloadResult = Schema.Struct({
  output: Schema.optional(Schema.String),
  result: Schema.optional(
    Schema.Struct({
      added: Schema.optional(Schema.Array(Schema.Unknown)),
      removed: Schema.optional(Schema.Array(Schema.Unknown)),
      total: Schema.optional(Schema.Number),
    }),
  ),
});
export type HermesGatewaySkillsReloadResult = typeof HermesGatewaySkillsReloadResult.Type;

export const HermesSkillEntry = Schema.Struct({
  name: Schema.String,
  description: Schema.NullOr(Schema.String),
});
export type HermesSkillEntry = typeof HermesSkillEntry.Type;

export const HermesSkillsCapabilities = Schema.Struct({
  inventory: Schema.Boolean,
  search: Schema.Boolean,
  inspect: Schema.Boolean,
  reload: Schema.Boolean,
});
export type HermesSkillsCapabilities = typeof HermesSkillsCapabilities.Type;

export const HermesSkillsProviderProjection = Schema.Struct({
  providerInstanceId: Schema.String,
  displayName: Schema.String,
  profileKey: Schema.String,
  status: Schema.Literals(["ready", "unavailable", "error"]),
  protocolClassification: Schema.NullOr(HermesGatewayCompatibilityStatus),
  capabilities: HermesSkillsCapabilities,
  skills: Schema.Array(HermesSkillEntry),
  diagnostics: Schema.Array(Schema.String),
});
export type HermesSkillsProviderProjection = typeof HermesSkillsProviderProjection.Type;

export const HermesSkillsListInput = Schema.Struct({});
export type HermesSkillsListInput = typeof HermesSkillsListInput.Type;

export const HermesSkillsListResult = Schema.Struct({
  providers: Schema.Array(HermesSkillsProviderProjection),
});
export type HermesSkillsListResult = typeof HermesSkillsListResult.Type;

export const HermesSkillsSearchInput = Schema.Struct({
  providerInstanceId: Schema.String,
  query: Schema.String,
});
export type HermesSkillsSearchInput = typeof HermesSkillsSearchInput.Type;

export const HermesSkillsSearchResult = Schema.Struct({
  results: Schema.Array(HermesSkillEntry),
});
export type HermesSkillsSearchResult = typeof HermesSkillsSearchResult.Type;

export const HermesSkillsInspectInput = Schema.Struct({
  providerInstanceId: Schema.String,
  name: Schema.String,
});
export type HermesSkillsInspectInput = typeof HermesSkillsInspectInput.Type;

export const HermesSkillsInspectResult = Schema.Struct({
  info: Schema.Record(Schema.String, Schema.Unknown),
});
export type HermesSkillsInspectResult = typeof HermesSkillsInspectResult.Type;

export const HermesSkillsReloadInput = Schema.Struct({
  providerInstanceId: Schema.String,
  operationId: Schema.String,
});
export type HermesSkillsReloadInput = typeof HermesSkillsReloadInput.Type;

export const HermesSkillsReloadResponse = Schema.Struct({
  added: Schema.Array(Schema.String),
  removed: Schema.Array(Schema.String),
  total: Schema.NullOr(Schema.Number),
  output: Schema.NullOr(Schema.String),
});
export type HermesSkillsReloadResponse = typeof HermesSkillsReloadResponse.Type;

export const HermesSkillsOperation = Schema.Literals(["list", "search", "inspect", "reload"]);
export type HermesSkillsOperation = typeof HermesSkillsOperation.Type;

export class HermesSkillsError extends Schema.TaggedErrorClass<HermesSkillsError>()(
  "HermesSkillsError",
  {
    code: Schema.Literals([
      "provider_not_found",
      "provider_unavailable",
      "unsupported_operation",
      "invalid_input",
      "gateway_error",
      "mutations_blocked",
      "indeterminate",
    ]),
    message: Schema.String,
    providerInstanceId: Schema.optional(Schema.String),
    operation: Schema.optional(HermesSkillsOperation),
  },
) {}
