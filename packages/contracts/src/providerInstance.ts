import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";
import { ForwardCompatibleOptional, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { SecretReference } from "./secretReference.ts";

const PROVIDER_SLUG_MAX_CHARS = 64;
const PROVIDER_SLUG_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]*$/;
const ENVIRONMENT_VARIABLE_NAME_MAX_CHARS = 128;
const ENVIRONMENT_VARIABLE_NAME_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const ICON_VIEW_BOX_MAX_CHARS = 64;
const ICON_VIEW_BOX_PATTERN = /^-?(?:\d+(?:\.\d+)?|\.\d+)(?:[\s,]+-?(?:\d+(?:\.\d+)?|\.\d+)){3}$/;
const ICON_HEX_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;
const ICON_PATH_MAX_CHARS = 4096;
const ICON_PATH_PATTERN = /^[MmZzLlHhVvCcSsQqTtAa0-9eE.,+\-\s]+$/;
const ICON_MAX_PATHS = 8;

const slugSchema = TrimmedNonEmptyString.check(
  Schema.isMaxLength(PROVIDER_SLUG_MAX_CHARS),
  Schema.isPattern(PROVIDER_SLUG_PATTERN),
);

export const ProviderDriverKind = slugSchema.pipe(Schema.brand("ProviderDriverKind"));
export type ProviderDriverKind = typeof ProviderDriverKind.Type;

export const isProviderDriverKind = Schema.is(ProviderDriverKind);

export const ProviderInstanceId = slugSchema.pipe(Schema.brand("ProviderInstanceId"));
export type ProviderInstanceId = typeof ProviderInstanceId.Type;

export const ProviderInstanceEnvironmentVariableName = TrimmedNonEmptyString.check(
  Schema.isMaxLength(ENVIRONMENT_VARIABLE_NAME_MAX_CHARS),
  Schema.isPattern(ENVIRONMENT_VARIABLE_NAME_PATTERN),
);
export type ProviderInstanceEnvironmentVariableName =
  typeof ProviderInstanceEnvironmentVariableName.Type;

const ProviderInstanceEnvironmentVariableValue = Schema.Struct({
  name: ProviderInstanceEnvironmentVariableName,
  value: Schema.Union([Schema.String, SecretReference]),
  sensitive: Schema.Boolean,
  valueRedacted: Schema.optionalKey(Schema.Boolean),
});

// A reference is encoded beside an empty value so older servers and clients still decode it.
const StoredProviderInstanceEnvironmentVariable = Schema.Struct({
  name: ProviderInstanceEnvironmentVariableName,
  value: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  sensitive: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  valueRedacted: Schema.optionalKey(Schema.Boolean),
  secret: Schema.optionalKey(SecretReference),
});

export const ProviderInstanceEnvironmentVariable = StoredProviderInstanceEnvironmentVariable.pipe(
  Schema.decodeTo(
    Schema.toType(ProviderInstanceEnvironmentVariableValue),
    SchemaTransformation.transform<
      typeof ProviderInstanceEnvironmentVariableValue.Type,
      typeof StoredProviderInstanceEnvironmentVariable.Type
    >({
      decode: ({ secret, ...variable }) =>
        secret === undefined ? variable : { ...variable, value: secret, sensitive: true },
      encode: ({ value, ...variable }) =>
        typeof value === "string"
          ? { ...variable, value }
          : { ...variable, value: "", secret: value },
    }),
  ),
);
export type ProviderInstanceEnvironmentVariable = typeof ProviderInstanceEnvironmentVariable.Type;

export const ProviderInstanceEnvironment = Schema.Array(ProviderInstanceEnvironmentVariable);
export type ProviderInstanceEnvironment = typeof ProviderInstanceEnvironment.Type;

/** What drivers receive: every secret reference has been read into a plain value. */
export type ResolvedProviderInstanceEnvironment = ReadonlyArray<
  Omit<ProviderInstanceEnvironmentVariable, "value"> & { readonly value: string }
>;

// Hex-only fills end up in CSS custom properties that drive `fill`, so no url() paint server can load.
const ProviderIconFill = Schema.String.check(Schema.isPattern(ICON_HEX_COLOR_PATTERN));

/** The themed glyph shape provider packages declare, without gradients or per-path fills. */
export const ProviderVectorIcon = Schema.Struct({
  viewBox: Schema.String.check(
    Schema.isMaxLength(ICON_VIEW_BOX_MAX_CHARS),
    Schema.isPattern(ICON_VIEW_BOX_PATTERN),
  ),
  fill: Schema.Struct({ light: ProviderIconFill, dark: ProviderIconFill }),
  paths: Schema.Array(
    Schema.Struct({
      d: Schema.String.check(
        Schema.isMaxLength(ICON_PATH_MAX_CHARS),
        Schema.isPattern(ICON_PATH_PATTERN),
      ),
      fillRule: Schema.optionalKey(Schema.Literals(["evenodd", "nonzero"])),
    }),
  ).check(Schema.isMinLength(1), Schema.isMaxLength(ICON_MAX_PATHS)),
});
export type ProviderVectorIcon = typeof ProviderVectorIcon.Type;

/** Drivers decode their own config; unknown-driver envelopes round-trip verbatim across versions. */
export const ProviderInstanceConfig = Schema.Struct({
  driver: ProviderDriverKind,
  displayName: Schema.optional(TrimmedNonEmptyString),
  accentColor: Schema.optional(TrimmedNonEmptyString),
  icon: ForwardCompatibleOptional(ProviderVectorIcon),
  environment: Schema.optionalKey(ProviderInstanceEnvironment),
  enabled: Schema.optionalKey(Schema.Boolean),
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
]);
export type ProviderInstanceMutation = typeof ProviderInstanceMutation.Type;

export const ProviderInstanceConfigMap = Schema.Record(ProviderInstanceId, ProviderInstanceConfig);
export type ProviderInstanceConfigMap = typeof ProviderInstanceConfigMap.Type;

/** Driver-kind ids keep stored selections routable without migration. */
export const defaultInstanceIdForDriver = (driver: ProviderDriverKind): ProviderInstanceId =>
  ProviderInstanceId.make(driver);
