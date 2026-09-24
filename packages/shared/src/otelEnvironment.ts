/**
 * otelEnvironment: the OpenTelemetry kill switch and resource attributes,
 * shared by the server and the desktop main process so both agree on what
 * turns export off and what it is exported as.
 *
 * `T3CODE_OTEL_SDK_DISABLED` is read first, so a machine that sets
 * `OTEL_SDK_DISABLED` for everything else can still opt T3 Code back in.
 *
 * @module otelEnvironment
 */
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";

export interface OtelEnvironment {
  /** Whether OTLP export is off, whatever endpoint is configured. */
  readonly disabled: boolean;
  /** Messages for the caller to log once at startup. */
  readonly warnings: ReadonlyArray<string>;
  /**
   * Valid entries from `OTEL_RESOURCE_ATTRIBUTES`. A malformed entry is
   * dropped and reported in `warnings` instead of failing startup, which is
   * what the exporters this variable also feeds do today.
   */
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

/** One side of a pair in `OTEL_RESOURCE_ATTRIBUTES`, the exporters' own schema. */
const PairComponent = Schema.String.pipe(
  Schema.decodeTo(Schema.StringFromUriComponent, SchemaTransformation.trim()),
);
const decodePairComponent = Schema.decodeUnknownOption(PairComponent);

interface ResourceAttributes {
  readonly value: Readonly<Record<string, string>>;
  readonly warnings: ReadonlyArray<string>;
}

/**
 * Reads `OTEL_RESOURCE_ATTRIBUTES` the way the specification describes it: a
 * comma-separated list of `key=value` pairs, percent-decoded. Effect's
 * exporters read the same variable with `Config.Record`, which dies on the
 * first pair it cannot decode; here, a pair that has no `=` or fails to
 * percent-decode is dropped with a warning, and every other pair still
 * applies, since one bad attribute should not be why the process would not
 * start.
 */
const parseResourceAttributes = (raw: string): ResourceAttributes => {
  const value: Record<string, string> = {};
  const warnings: string[] = [];
  for (const pair of raw.split(",")) {
    const trimmed = pair.trim();
    if (trimmed === "") {
      continue;
    }
    const separator = trimmed.indexOf("=");
    const key = separator === -1 ? Option.none() : decodePairComponent(trimmed.slice(0, separator));
    const attributeValue =
      separator === -1 ? Option.none() : decodePairComponent(trimmed.slice(separator + 1));
    if (Option.isNone(key) || Option.isNone(attributeValue)) {
      warnings.push(
        `OTEL_RESOURCE_ATTRIBUTES entry "${trimmed}" is not a percent-decoded key=value pair and was ignored`,
      );
      continue;
    }
    value[key.value] = attributeValue.value;
  }
  return { value, warnings };
};

const resourceAttributesConfig = Config.String("OTEL_RESOURCE_ATTRIBUTES").pipe(
  Config.withDefault(""),
  Config.map(parseResourceAttributes),
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
  resourceAttributes: resourceAttributesConfig,
}).pipe(
  Effect.map(({ t3, spec, resourceAttributes }) => {
    const disabled = t3.value ?? spec.value ?? false;
    const warnings = [t3.warning, spec.warning]
      .filter((warning) => warning !== undefined)
      .concat(resourceAttributes.warnings);
    if (disabled) {
      warnings.push(
        t3.value
          ? "T3CODE_OTEL_SDK_DISABLED is set, so no telemetry is exported, whatever configured it"
          : "OTEL_SDK_DISABLED is set, so no telemetry is exported, whatever configured it; set T3CODE_OTEL_SDK_DISABLED=false to export anyway",
      );
    }
    return { disabled, warnings, resourceAttributes: resourceAttributes.value };
  }),
  // Every read above falls back instead of failing, so this cannot happen.
  Effect.orDie,
);

/**
 * Effect's OTLP exporters read `OTEL_RESOURCE_ATTRIBUTES` for themselves and
 * die on an entry they cannot decode. Provide this around them so that read
 * sees only the entries `load` kept; every other variable still comes from the
 * environment. Empty strings are preserved so an emptied list stays empty
 * instead of falling through to the raw value.
 */
export const resourceAttributesLayer = (attributes: Readonly<Record<string, string>>) =>
  ConfigProvider.layerAdd(
    ConfigProvider.fromEnv({
      env: {
        OTEL_RESOURCE_ATTRIBUTES: Object.entries(attributes)
          .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
          .join(","),
      },
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
