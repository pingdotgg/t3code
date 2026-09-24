/**
 * otelEnvironment: the OpenTelemetry kill switch, shared by the server and the
 * desktop main process so both agree on what turns export off.
 *
 * `T3CODE_OTEL_SDK_DISABLED` is read first, so a machine that sets
 * `OTEL_SDK_DISABLED` for everything else can still opt T3 Code back in.
 *
 * @module otelEnvironment
 */
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";

export interface OtelEnvironment {
  /** Whether OTLP export is off, whatever endpoint is configured. */
  readonly disabled: boolean;
  /** Messages for the caller to log once at startup. */
  readonly warnings: ReadonlyArray<string>;
  /** `OTEL_RESOURCE_ATTRIBUTES`, or nothing when it could not be read. */
  readonly resourceAttributes: Readonly<Record<string, string>>;
}

interface Flag {
  /** `undefined` when the variable is unset, blank, or unreadable. */
  readonly value: boolean | undefined;
  readonly warning?: string;
}

const TrimmedLowercase = Schema.String.pipe(
  Schema.decodeTo(
    Schema.String,
    SchemaTransformation.trim().compose(SchemaTransformation.toLowerCase()),
  ),
);

/**
 * Reads a boolean that accepts `truthy` and `falsy`, ignoring case and padding.
 * Any other value is ignored with a warning rather than failing startup.
 */
const flag = (
  name: string,
  truthy: ReadonlyArray<string>,
  falsy: ReadonlyArray<string>,
  invalid: (value: string) => string,
) =>
  Config.schema(
    TrimmedLowercase.pipe(Schema.decodeTo(Schema.Literals([...truthy, ...falsy]))),
    name,
  ).pipe(
    Config.map((value): Flag => ({ value: truthy.includes(value) })),
    Config.orElse(() =>
      Config.String(name).pipe(
        Config.map((raw): Flag => {
          const value = raw.trim();
          return value === ""
            ? { value: undefined }
            : { value: undefined, warning: invalid(value) };
        }),
      ),
    ),
    Config.withDefault<Flag>({ value: undefined }),
  );

// `Config.Boolean`'s literals, which effect does not export on their own.
const T3CODE_TRUE = ["true", "yes", "on", "1", "y"];
const T3CODE_FALSE = ["false", "no", "off", "0", "n"];

const RESOURCE_ATTRIBUTES = "OTEL_RESOURCE_ATTRIBUTES";

interface ResourceAttributes {
  readonly value: Readonly<Record<string, string>>;
  readonly warning?: string;
}

// The schema Effect's OTLP exporters read this variable with.
const resourceAttributes = Config.Record(
  Schema.StringFromUriComponent,
  Schema.StringFromUriComponent,
  RESOURCE_ATTRIBUTES,
).pipe(
  Config.map((value): ResourceAttributes => ({ value })),
  Config.orElse(() =>
    Config.String(RESOURCE_ATTRIBUTES).pipe(
      // The value is left out because attributes can carry credentials.
      Config.map((): ResourceAttributes => ({
        value: {},
        warning: `${RESOURCE_ATTRIBUTES} is not a list of percent-encoded key=value pairs and was ignored`,
      })),
    ),
  ),
  Config.withDefault<ResourceAttributes>({ value: {} }),
);

export const load: Effect.Effect<OtelEnvironment> = Config.all({
  t3: flag(
    "T3CODE_OTEL_SDK_DISABLED",
    T3CODE_TRUE,
    T3CODE_FALSE,
    (value) => `T3CODE_OTEL_SDK_DISABLED=${value} is not a yes or a no and was ignored`,
  ),
  // The specification: a boolean it defines is true "only by the
  // case-insensitive string `true`", implementations "MUST NOT" accept other
  // values as true, and should warn about unrecognized ones.
  spec: flag(
    "OTEL_SDK_DISABLED",
    ["true"],
    ["false"],
    (value) =>
      `OTEL_SDK_DISABLED=${value} was read as false; the OpenTelemetry specification recognizes only the string true, so use OTEL_SDK_DISABLED=true or T3CODE_OTEL_SDK_DISABLED to say it any other way`,
  ),
  resource: resourceAttributes,
}).pipe(
  Effect.map(({ t3, spec, resource }) => {
    const disabled = t3.value ?? spec.value ?? false;
    const warnings = [t3.warning, spec.warning, resource.warning].filter(
      (warning) => warning !== undefined,
    );
    if (disabled) {
      warnings.push(
        t3.value
          ? "T3CODE_OTEL_SDK_DISABLED is set, so no telemetry is exported, whatever configured it"
          : "OTEL_SDK_DISABLED is set, so no telemetry is exported, whatever configured it; set T3CODE_OTEL_SDK_DISABLED=false to export anyway",
      );
    }
    return { disabled, warnings, resourceAttributes: resource.value };
  }),
  // Every read above falls back instead of failing, so this cannot happen.
  Effect.orDie,
);

/**
 * Provide this around Effect's OTLP exporters, which read
 * `OTEL_RESOURCE_ATTRIBUTES` for themselves and die when it does not decode,
 * so they see what `load` accepted instead.
 */
export const layerResourceAttributes = (attributes: Readonly<Record<string, string>>) =>
  ConfigProvider.layerAdd(
    ConfigProvider.fromEnv({
      env: {
        [RESOURCE_ATTRIBUTES]: Object.entries(attributes)
          .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
          .join(","),
      },
      // Keeps an emptied list from falling through to the raw value.
      preserveEmptyStrings: true,
    }),
    { asPrimary: true },
  );

/** An environment that asked for nothing, for tests and for the pairing CLI. */
export const none: OtelEnvironment = {
  disabled: false,
  warnings: [],
  resourceAttributes: {},
};
