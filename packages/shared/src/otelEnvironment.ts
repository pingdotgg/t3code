import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";

import type { OtlpEndpointSource } from "@t3tools/contracts";

import { OtlpHeadersFromString, OtlpProtocol, type SignalExport } from "./observability.ts";

type OtlpSignalName = "TRACES" | "METRICS" | "LOGS";

export type OtelSignal = Data.TaggedEnum<{
  Unset: {};
  Off: {};
  Export: {
    readonly url: string;
    readonly variable: string;
    readonly protocol: OtlpProtocol;
    readonly headers: Readonly<Record<string, string>> | undefined;
  };
}>;
export const OtelSignal = Data.taggedEnum<OtelSignal>();

export interface OtelEnvironment {
  readonly disabled: boolean;
  readonly warnings: ReadonlyArray<string>;
  readonly resourceAttributes: Readonly<Record<string, string>>;
  readonly traces: OtelSignal;
  readonly metrics: OtelSignal;
  readonly logs: OtelSignal;
}

const blankAsUnset = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === "" ? undefined : trimmed;
};

interface Flag {
  readonly value: boolean | undefined;
  readonly warning?: string;
}

const TrimmedLowercase = Schema.String.pipe(
  Schema.decodeTo(
    Schema.String,
    SchemaTransformation.trim().pipe(
      SchemaTransformation.composeTransformation(SchemaTransformation.toLowerCase()),
    ),
  ),
);

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
const decodeOtlpProtocol = Schema.decodeUnknownOption(OtlpProtocol);

// The specification reads enum values case-insensitively.
const protocol = (name: string) =>
  readOrWarn(
    name,
    (raw) => decodeOtlpProtocol(raw.toLowerCase()),
    `${name} is not http/protobuf or http/json, ${NOT_EXPORTED}`,
  );

const headers = (name: string) =>
  readOrWarn(
    name,
    Schema.decodeUnknownOption(OtlpHeadersFromString),
    `${name} is not a list of key=value pairs with percent-encoded values, ${NOT_EXPORTED}`,
  );

type Exporter = "otlp" | "none";

const EXPORTERS: ReadonlySet<string> = new Set<Exporter>(["otlp", "none"]);

const isExporter = (entry: string): entry is Exporter => EXPORTERS.has(entry);

const exporter = (name: string): Config.Config<Setting<Exporter>> =>
  Config.String(name).pipe(
    Config.option,
    Config.map((option): Setting<Exporter> => {
      const entries = (Option.getOrUndefined(option) ?? "")
        .split(",")
        .map((entry) => entry.trim().toLowerCase())
        .filter((entry) => entry !== "");
      const ignored = [...new Set(entries.filter((entry) => !isExporter(entry)))];
      const known = new Set(entries.filter(isExporter));
      const value = known.has("otlp") ? "otlp" : known.has("none") ? "none" : undefined;
      return ignored.length === 0
        ? { value }
        : {
            value,
            warning: `${name} names ${ignored.join(", ")}, which T3 Code does not export to, so ${ignored.length === 1 ? "it was" : "they were"} ignored`,
          };
    }),
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
  readonly used: ReadonlyArray<Setting<unknown>>;
}

const signal = (
  name: OtlpSignalName,
  exporter: Setting<Exporter>,
  own: Settings,
  generic: Settings,
): ResolvedSignal => {
  if (exporter.value === "none") {
    return { signal: OtelSignal.Off(), used: [exporter] };
  }
  const resolved = endpointSignal(name, own, generic);
  return { signal: resolved.signal, used: [exporter, ...resolved.used] };
};

const endpointSignal = (name: OtlpSignalName, own: Settings, generic: Settings): ResolvedSignal => {
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
      variable: ownEndpoint ? `OTEL_EXPORTER_OTLP_${name}_ENDPOINT` : "OTEL_EXPORTER_OTLP_ENDPOINT",
      protocol: protocol.value ?? "http/protobuf",
      headers: headers.value,
    }),
    used,
  };
};

const sdkFlags = {
  t3: flag(
    "T3CODE_OTEL_SDK_DISABLED",
    T3CODE_TRUE,
    T3CODE_FALSE,
    (value) => `T3CODE_OTEL_SDK_DISABLED=${value} is not a yes or a no and was ignored`,
  ),
  // OTEL booleans are true only for case-insensitive true; warn on unrecognized values.
  spec: flag(
    "OTEL_SDK_DISABLED",
    ["true"],
    ["false"],
    (value) =>
      `OTEL_SDK_DISABLED=${value} was read as false; the OpenTelemetry specification recognizes only the string true, so use OTEL_SDK_DISABLED=true or T3CODE_OTEL_SDK_DISABLED to say it any other way`,
  ),
};

export const load: Effect.Effect<OtelEnvironment> = Config.all({
  ...sdkFlags,
  resource: resourceAttributes,
  generic: settings("OTEL_EXPORTER_OTLP_"),
  traces: settings("OTEL_EXPORTER_OTLP_TRACES_"),
  metrics: settings("OTEL_EXPORTER_OTLP_METRICS_"),
  logs: settings("OTEL_EXPORTER_OTLP_LOGS_"),
  exporters: Config.all({
    traces: exporter("OTEL_TRACES_EXPORTER"),
    metrics: exporter("OTEL_METRICS_EXPORTER"),
    logs: exporter("OTEL_LOGS_EXPORTER"),
  }),
}).pipe(
  Effect.map(({ t3, spec, resource, generic, exporters, ...own }) => {
    const disabled = t3.value ?? spec.value ?? false;
    const signals = disabled
      ? undefined
      : {
          traces: signal("TRACES", exporters.traces, own.traces, generic),
          metrics: signal("METRICS", exporters.metrics, own.metrics, generic),
          logs: signal("LOGS", exporters.logs, own.logs, generic),
        };
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
  Effect.orDie,
);

export const isRelayTracingEnabled = (env: Readonly<Record<string, string | undefined>>) =>
  Config.all({
    ...sdkFlags,
    telemetry: flag("T3CODE_TELEMETRY_ENABLED", T3CODE_TRUE, T3CODE_FALSE, String),
  }).pipe(
    Effect.map(
      ({ telemetry, t3, spec }) => telemetry.value !== false && !(t3.value ?? spec.value ?? false),
    ),
    Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord(env))),
    Effect.orDie,
    Effect.runSync,
  );

export type SignalName = "traces" | "metrics" | "logs";

export interface SignalEndpoint {
  readonly url: string;
  readonly export: SignalExport;
  readonly source: OtlpEndpointSource;
  /** The environment variable that set the endpoint, when `source` is `environment`. */
  readonly variable?: string;
}

export const resolveSignalEndpoint = (
  otel: OtelEnvironment,
  signal: SignalName,
  t3: { readonly url: string | undefined; readonly export: SignalExport },
  fallback: { readonly bootstrapUrl: string | undefined; readonly settingsUrl: string | undefined },
): SignalEndpoint | undefined => {
  if (otel.disabled) {
    return undefined;
  }
  const t3Url = blankAsUnset(t3.url);
  if (t3Url !== undefined) {
    return {
      url: t3Url,
      export: t3.export,
      source: "environment",
      variable: `T3CODE_OTLP_${signal.toUpperCase()}_URL`,
    };
  }
  return OtelSignal.$match(otel[signal], {
    Export: ({ url, variable, protocol, headers }): SignalEndpoint => ({
      url,
      export: { protocol, headers, exportIntervalMs: t3.export.exportIntervalMs },
      source: "environment",
      variable,
    }),
    Off: () => undefined,
    Unset: (): SignalEndpoint | undefined => {
      const settingsUrl = blankAsUnset(fallback.settingsUrl);
      // The desktop forwards the saved setting as its bootstrap URL, so only a differing one is
      // the desktop's own.
      const url = blankAsUnset(fallback.bootstrapUrl) ?? settingsUrl;
      if (url === undefined) return undefined;
      return { url, export: t3.export, source: url === settingsUrl ? "settings" : "bootstrap" };
    },
  });
};

/** Give OTLP exporters the accepted resource attributes so their own decoding cannot fail. */
export const layerResourceAttributes = (attributes: Readonly<Record<string, string>>) =>
  ConfigProvider.layerAdd(
    ConfigProvider.fromEnv({
      env: {
        [RESOURCE_ATTRIBUTES]: Object.entries(attributes)
          .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
          .join(","),
      },
      preserveEmptyStrings: true,
    }),
    { asPrimary: true },
  );

export const none: OtelEnvironment = {
  disabled: false,
  warnings: [],
  resourceAttributes: {},
  traces: OtelSignal.Unset(),
  metrics: OtelSignal.Unset(),
  logs: OtelSignal.Unset(),
};
