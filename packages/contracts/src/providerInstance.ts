import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";

const PROVIDER_SLUG_MAX_CHARS = 64;
const PROVIDER_SLUG_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]*$/;
const ENVIRONMENT_VARIABLE_NAME_MAX_CHARS = 128;
const ENVIRONMENT_VARIABLE_NAME_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

const slugSchema = TrimmedNonEmptyString.check(
  Schema.isMaxLength(PROVIDER_SLUG_MAX_CHARS),
  Schema.isPattern(PROVIDER_SLUG_PATTERN),
);

export const ProviderDriverKind = slugSchema.pipe(Schema.brand("ProviderDriverKind"));
export type ProviderDriverKind = typeof ProviderDriverKind.Type;

const isProviderDriverKindValue = Schema.is(ProviderDriverKind);
export const isProviderDriverKind = (value: unknown): value is ProviderDriverKind =>
  isProviderDriverKindValue(value);

export const ProviderInstanceId = slugSchema.pipe(Schema.brand("ProviderInstanceId"));
export type ProviderInstanceId = typeof ProviderInstanceId.Type;

export const ProviderInstanceRef = Schema.Struct({
  instanceId: ProviderInstanceId,
  driver: ProviderDriverKind,
});
export type ProviderInstanceRef = typeof ProviderInstanceRef.Type;

export const ProviderInstanceEnvironmentVariableName = TrimmedNonEmptyString.check(
  Schema.isMaxLength(ENVIRONMENT_VARIABLE_NAME_MAX_CHARS),
  Schema.isPattern(ENVIRONMENT_VARIABLE_NAME_PATTERN),
);
export type ProviderInstanceEnvironmentVariableName =
  typeof ProviderInstanceEnvironmentVariableName.Type;

export const ProviderInstanceEnvironmentVariable = Schema.Struct({
  name: ProviderInstanceEnvironmentVariableName,
  value: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  sensitive: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  valueRedacted: Schema.optionalKey(Schema.Boolean),
});
export type ProviderInstanceEnvironmentVariable = typeof ProviderInstanceEnvironmentVariable.Type;

export const ProviderInstanceEnvironment = Schema.Array(ProviderInstanceEnvironmentVariable);
export type ProviderInstanceEnvironment = typeof ProviderInstanceEnvironment.Type;

export const ProviderInventoryKind = Schema.Literals([
  "connectors",
  "mcpServers",
  "plugins",
  "skills",
]);
export type ProviderInventoryKind = typeof ProviderInventoryKind.Type;

const ProviderInventoryItemIds = Schema.optionalKey(Schema.Array(TrimmedNonEmptyString));

/**
 * Inventory item ids this instance keeps out of its T3 sessions. The
 * provider's own configuration is never touched, so its other apps still
 * load them.
 */
export const ProviderDisabledInventory = Schema.Struct({
  connectors: ProviderInventoryItemIds,
  mcpServers: ProviderInventoryItemIds,
  plugins: ProviderInventoryItemIds,
  skills: ProviderInventoryItemIds,
});
export type ProviderDisabledInventory = typeof ProviderDisabledInventory.Type;

/**
 * The driver-specific config payload is left as `Schema.Unknown`; each driver
 * registers its own decoder with the runtime registry, and envelopes for
 * unknown drivers are preserved verbatim so they round-trip across version
 * changes without data loss.
 */
export const ProviderInstanceConfig = Schema.Struct({
  driver: ProviderDriverKind,
  displayName: Schema.optional(TrimmedNonEmptyString),
  accentColor: Schema.optional(TrimmedNonEmptyString),
  environment: Schema.optionalKey(ProviderInstanceEnvironment),
  enabled: Schema.optionalKey(Schema.Boolean),
  disabledInventory: Schema.optionalKey(ProviderDisabledInventory),
  config: Schema.optionalKey(Schema.Unknown),
});
export type ProviderInstanceConfig = typeof ProviderInstanceConfig.Type;

export const ProviderInstanceMutation = Schema.Union([
  Schema.Struct({
    operation: Schema.Literal("create"),
    instanceId: ProviderInstanceId,
    instance: ProviderInstanceConfig,
  }),
  Schema.Struct({
    operation: Schema.Literal("upsert"),
    instanceId: ProviderInstanceId,
    instance: ProviderInstanceConfig,
  }),
  Schema.Struct({
    operation: Schema.Literal("remove"),
    instanceId: ProviderInstanceId,
  }),
  Schema.Struct({
    operation: Schema.Literal("set-inventory-item"),
    instanceId: ProviderInstanceId,
    driver: ProviderDriverKind,
    kind: ProviderInventoryKind,
    itemId: TrimmedNonEmptyString,
    enabledInT3: Schema.Boolean,
  }),
]);
export type ProviderInstanceMutation = typeof ProviderInstanceMutation.Type;

export const ProviderInstanceConfigMap = Schema.Record(ProviderInstanceId, ProviderInstanceConfig);
export type ProviderInstanceConfigMap = typeof ProviderInstanceConfigMap.Type;

/**
 * The legacy single-instance-per-driver world used the driver kind itself as
 * the instance id; preserving that mapping keeps existing persisted threads,
 * bindings, and cache files routable across the migration without rewriting
 * their stored selection payloads.
 */
export const defaultInstanceIdForDriver = (driver: ProviderDriverKind): ProviderInstanceId =>
  ProviderInstanceId.make(driver);
