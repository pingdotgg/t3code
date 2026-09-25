/**
 * otelEnvironment: the OpenTelemetry kill switch and endpoint variables,
 * shared by the server and the desktop main process so both agree on what
 * turns export off and where it goes.
 *
 * `T3CODE_OTEL_SDK_DISABLED` is read first, so a machine that sets
 * `OTEL_SDK_DISABLED` for everything else can still opt T3 Code back in.
 *
 * @module otelEnvironment
 */
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";

import { OtlpHeadersFromString, OtlpProtocol, type SignalExport } from "./observability.ts";

/** The signals T3 Code exports, spelled as the variable names spell them. */
type OtlpSignalName = "TRACES" | "METRICS" | "LOGS";

/**
 * What the OTEL variables say about one signal. `Off` is a signal they
 * claimed with an endpoint, protocol, or headers that do not read, so it is
 * exported nowhere rather than to the bootstrap or Settings collector.
 */
export type OtelSignal = Data.TaggedEnum<{
  Unset: {};
  Off: {};
  Export: {
    readonly url: string;
    readonly protocol: OtlpProtocol;
    readonly headers: Readonly<Record<string, string>> | undefined;
  };
}>;
export const OtelSignal = Data.taggedEnum<OtelSignal>();

export interface OtelEnvironment {
  /** Whether OTLP export is off, whatever endpoint is configured. */
  readonly disabled: boolean;
  /** Messages for the caller to log once at startup. */
  readonly warnings: ReadonlyArray<string>;
  /** `OTEL_RESOURCE_ATTRIBUTES`, or nothing when it could not be read. */
  readonly resourceAttributes: Readonly<Record<string, string>>;
  readonly traces: OtelSignal;
  readonly metrics: OtelSignal;
  readonly logs: OtelSignal;
}

/** A set but blank value reads as unset, so the source under it can answer. */
const blankAsUnset = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === "" ? undefined : trimmed;
};

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

interface Setting<A> {
  readonly value: A | undefined;
  readonly warning?: string;
}

/**
 * Reads one variable. Blank reads as unset, and a value `parse` rejects warns
 * without echoing it, since these variables carry credentials.
 */
const readOrWarn = <A>(
  name: string,
  parse: (raw: string) => Option.Option<A>,
  warning: string,
): Config.Config<Setting<A>> =>
  Config.String(name).pipe(
    Config.option,
    Config.map((option): Setting<A> => {
      const raw = blankAsUnset(Option.getOrUndefined(option));
      if (raw === undefined) {
        return { value: undefined };
      }
      return Option.match(parse(raw), {
        onNone: () => ({ value: undefined, warning }),
        onSome: (value) => ({ value }),
      });
    }),
  );

const parseHttpUrl = (raw: string) =>
  Option.liftThrowable((value: string) => new URL(value))(raw).pipe(
    Option.filter((url) => url.protocol === "http:" || url.protocol === "https:"),
  );

const NOT_EXPORTED = "so the signals it configures are not exported";

const endpoint = (name: string) =>
  readOrWarn(name, parseHttpUrl, `${name} is not an http or https URL, ${NOT_EXPORTED}`);

// The specification reads enum values case-insensitively.
const protocol = (name: string) =>
  readOrWarn(
    name,
    (raw) => Schema.decodeUnknownOption(OtlpProtocol)(raw.toLowerCase()),
    `${name} is not http/protobuf or http/json, ${NOT_EXPORTED}`,
  );

const headers = (name: string) =>
  readOrWarn(
    name,
    Schema.decodeUnknownOption(OtlpHeadersFromString),
    `${name} is not a list of key=value pairs with percent-encoded values, ${NOT_EXPORTED}`,
  );

interface Settings {
  readonly endpoint: Setting<URL>;
  readonly protocol: Setting<OtlpProtocol>;
  readonly headers: Setting<Readonly<Record<string, string>>>;
}

const settings = (prefix: string): Config.Config<Settings> =>
  Config.all({
    endpoint: endpoint(`${prefix}ENDPOINT`),
    protocol: protocol(`${prefix}PROTOCOL`),
    headers: headers(`${prefix}HEADERS`),
  });

/** The signal's own variable claims the signal once set, valid or not. */
const isClaimed = (setting: Setting<unknown>) =>
  setting.value !== undefined || setting.warning !== undefined;

const claimed = <A>(own: Setting<A>, generic: Setting<A>) => (isClaimed(own) ? own : generic);

/** Appends the signal's path, keeping the query an intake may take its API key in. */
const withSignalPath = (signal: OtlpSignalName, base: URL) => {
  const url = new URL(base);
  const slash = url.pathname.endsWith("/") ? "" : "/";
  url.pathname += `${slash}v1/${signal.toLowerCase()}`;
  return url;
};

interface ResolvedSignal {
  readonly signal: OtelSignal;
  /** The settings this signal read, whose warnings are the signal's to report. */
  readonly used: ReadonlyArray<Setting<unknown>>;
}

/**
 * A signal whose endpoint, protocol, or headers do not read is not exported
 * rather than sent somewhere, in a format, or without the credentials its
 * collector expects.
 */
const signal = (name: OtlpSignalName, own: Settings, generic: Settings): ResolvedSignal => {
  const ownEndpoint = isClaimed(own.endpoint);
  const endpoint = ownEndpoint ? own.endpoint : generic.endpoint;
  if (endpoint.value === undefined) {
    const signal = endpoint.warning === undefined ? OtelSignal.Unset() : OtelSignal.Off();
    return { signal, used: [endpoint] };
  }
  const protocol = claimed(own.protocol, generic.protocol);
  const headers = claimed(own.headers, generic.headers);
  const used = [endpoint, protocol, headers];
  if (protocol.warning !== undefined || headers.warning !== undefined) {
    return { signal: OtelSignal.Off(), used };
  }
  const url = ownEndpoint ? endpoint.value : withSignalPath(name, endpoint.value);
  return {
    signal: OtelSignal.Export({
      url: url.toString(),
      protocol: protocol.value ?? "http/protobuf",
      headers: headers.value,
    }),
    used,
  };
};

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
  generic: settings("OTEL_EXPORTER_OTLP_"),
  traces: settings("OTEL_EXPORTER_OTLP_TRACES_"),
  metrics: settings("OTEL_EXPORTER_OTLP_METRICS_"),
  logs: settings("OTEL_EXPORTER_OTLP_LOGS_"),
}).pipe(
  Effect.map(({ t3, spec, resource, generic, ...own }) => {
    const disabled = t3.value ?? spec.value ?? false;
    // The kill switch wins outright, so the signals say nothing once it is set.
    const signals = disabled
      ? undefined
      : {
          traces: signal("TRACES", own.traces, generic),
          metrics: signal("METRICS", own.metrics, generic),
          logs: signal("LOGS", own.logs, generic),
        };
    // A generic variable read by several signals warns once.
    const used = new Set(
      signals === undefined ? [] : Object.values(signals).flatMap((resolved) => resolved.used),
    );
    const warnings = [
      t3.warning,
      spec.warning,
      resource.warning,
      ...Array.from(used, (setting) => setting.warning),
    ].filter((warning) => warning !== undefined);
    if (disabled) {
      warnings.push(
        t3.value
          ? "T3CODE_OTEL_SDK_DISABLED is set, so no telemetry is exported, whatever configured it"
          : "OTEL_SDK_DISABLED is set, so no telemetry is exported, whatever configured it; set T3CODE_OTEL_SDK_DISABLED=false to export anyway",
      );
    }
    return {
      disabled,
      warnings,
      resourceAttributes: resource.value,
      traces: signals?.traces.signal ?? OtelSignal.Unset(),
      metrics: signals?.metrics.signal ?? OtelSignal.Unset(),
      logs: signals?.logs.signal ?? OtelSignal.Unset(),
    };
  }),
  // Every read above falls back instead of failing, so this cannot happen.
  Effect.orDie,
);

export type SignalName = "traces" | "metrics" | "logs";

export interface SignalEndpoint {
  readonly url: string;
  readonly export: SignalExport;
}

/**
 * Where one signal exports and how. `T3CODE_OTLP_*_URL` wins outright with
 * T3 Code's own export, then an OTEL endpoint with its own headers and
 * protocol, since `T3CODE_OTLP_HEADERS` was written for a different
 * collector, then the first of `fallbackUrls` with T3 Code's own export.
 */
export const resolveSignalEndpoint = (
  otel: OtelEnvironment,
  signal: SignalName,
  t3: { readonly url: string | undefined; readonly export: SignalExport },
  ...fallbackUrls: ReadonlyArray<string | undefined>
): SignalEndpoint | undefined => {
  if (otel.disabled) {
    return undefined;
  }
  const t3Url = blankAsUnset(t3.url);
  if (t3Url !== undefined) {
    return { url: t3Url, export: t3.export };
  }
  return OtelSignal.$match(otel[signal], {
    Export: ({ url, protocol, headers }): SignalEndpoint => ({
      url,
      export: { protocol, headers, exportIntervalMs: t3.export.exportIntervalMs },
    }),
    Off: () => undefined,
    Unset: () => {
      const url = fallbackUrls.map(blankAsUnset).find((candidate) => candidate !== undefined);
      return url === undefined ? undefined : { url, export: t3.export };
    },
  });
};

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
  traces: OtelSignal.Unset(),
  metrics: OtelSignal.Unset(),
  logs: OtelSignal.Unset(),
};
