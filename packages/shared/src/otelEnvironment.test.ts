import { assert, describe, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as OtlpResource from "effect/unstable/observability/OtlpResource";

import * as OtelEnvironment from "./otelEnvironment.ts";

const load = (env: Record<string, string>) =>
  OtelEnvironment.load.pipe(Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env }))));

const SPEC_OFF =
  "OTEL_SDK_DISABLED is set, so no telemetry is exported, whatever configured it; set T3CODE_OTEL_SDK_DISABLED=false to export anyway";
const T3_OFF =
  "T3CODE_OTEL_SDK_DISABLED is set, so no telemetry is exported, whatever configured it";
const specIgnored = (value: string) =>
  `OTEL_SDK_DISABLED=${value} was read as false; the OpenTelemetry specification recognizes only the string true, so use OTEL_SDK_DISABLED=true or T3CODE_OTEL_SDK_DISABLED to say it any other way`;

describe("OtelEnvironment", () => {
  it.effect.each([
    { name: "nothing set", env: {}, disabled: false, warnings: [] },
    // OTEL_SDK_DISABLED follows the specification: only `true`, case-insensitively.
    { name: "spec true", env: { OTEL_SDK_DISABLED: "true" }, disabled: true, warnings: [SPEC_OFF] },
    { name: "spec True", env: { OTEL_SDK_DISABLED: "True" }, disabled: true, warnings: [SPEC_OFF] },
    {
      name: "spec padded",
      env: { OTEL_SDK_DISABLED: " true " },
      disabled: true,
      warnings: [SPEC_OFF],
    },
    { name: "spec false", env: { OTEL_SDK_DISABLED: "false" }, disabled: false, warnings: [] },
    {
      name: "spec 1",
      env: { OTEL_SDK_DISABLED: "1" },
      disabled: false,
      warnings: [specIgnored("1")],
    },
    {
      name: "spec padded yes",
      env: { OTEL_SDK_DISABLED: " yes " },
      disabled: false,
      warnings: [specIgnored("yes")],
    },
    // T3CODE_OTEL_SDK_DISABLED takes Config.Boolean's values, case-insensitively.
    { name: "t3 1", env: { T3CODE_OTEL_SDK_DISABLED: "1" }, disabled: true, warnings: [T3_OFF] },
    {
      name: "t3 TRUE",
      env: { T3CODE_OTEL_SDK_DISABLED: "TRUE" },
      disabled: true,
      warnings: [T3_OFF],
    },
    { name: "t3 n", env: { T3CODE_OTEL_SDK_DISABLED: "n" }, disabled: false, warnings: [] },
    {
      name: "t3 false overrides spec true",
      env: { T3CODE_OTEL_SDK_DISABLED: "false", OTEL_SDK_DISABLED: "true" },
      disabled: false,
      warnings: [],
    },
    {
      name: "blank t3 falls through",
      env: { T3CODE_OTEL_SDK_DISABLED: "  ", OTEL_SDK_DISABLED: "true" },
      disabled: true,
      warnings: [SPEC_OFF],
    },
    {
      name: "unreadable t3 warns and falls through",
      env: { T3CODE_OTEL_SDK_DISABLED: "maybe", OTEL_SDK_DISABLED: "true" },
      disabled: true,
      warnings: ["T3CODE_OTEL_SDK_DISABLED=maybe is not a yes or a no and was ignored", SPEC_OFF],
    },
    {
      name: "bad spec value still warns when t3 answered",
      env: { T3CODE_OTEL_SDK_DISABLED: "false", OTEL_SDK_DISABLED: "yes" },
      disabled: false,
      warnings: [specIgnored("yes")],
    },
  ])("$name", ({ env, disabled, warnings }) =>
    Effect.gen(function* () {
      const resolved = yield* load(env);
      assert.strictEqual(resolved.disabled, disabled);
      assert.deepStrictEqual(resolved.warnings, warnings);
    }),
  );

  it.effect.each([
    { name: "unset", env: {}, resourceAttributes: {}, warnings: [] },
    {
      name: "a percent-encoded list",
      env: { OTEL_RESOURCE_ATTRIBUTES: "team=core,message=hello%20world" },
      resourceAttributes: { team: "core", message: "hello world" },
      warnings: [],
    },
    {
      name: "a list that does not decode",
      env: { OTEL_RESOURCE_ATTRIBUTES: "team=core,broken=%zz" },
      resourceAttributes: {},
      warnings: [
        "OTEL_RESOURCE_ATTRIBUTES is not a list of percent-encoded key=value pairs and was ignored",
      ],
    },
  ])("resource attributes: $name", ({ env, resourceAttributes, warnings }) =>
    Effect.gen(function* () {
      const resolved = yield* load(env);
      assert.deepStrictEqual(resolved.resourceAttributes, resourceAttributes);
      assert.deepStrictEqual(resolved.warnings, warnings);
    }),
  );

  describe("endpoints", () => {
    const urlOf = (signal: OtelEnvironment.OtelSignal) =>
      OtelEnvironment.OtelSignal.$match(signal, {
        Export: ({ url }) => url,
        Off: () => "Off",
        Unset: () => "Unset",
      });
    it.effect.each([
      {
        name: "nothing set",
        env: {},
        traces: "Unset",
        metrics: "Unset",
        logs: "Unset",
        warnings: [],
      },
      {
        name: "generic endpoint appends each signal's path, keeping the query",
        env: { OTEL_EXPORTER_OTLP_ENDPOINT: "https://collector:4318/base?api_key=secret" },
        traces: "https://collector:4318/base/v1/traces?api_key=secret",
        metrics: "https://collector:4318/base/v1/metrics?api_key=secret",
        logs: "https://collector:4318/base/v1/logs?api_key=secret",
        warnings: [],
      },
      {
        name: "a per-signal endpoint is used verbatim",
        env: { OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "https://tempo:4318/custom" },
        traces: "https://tempo:4318/custom",
        metrics: "Unset",
        logs: "Unset",
        warnings: [],
      },
      {
        name: "a per-signal endpoint beats the generic one",
        env: {
          OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "https://tempo:4318/custom",
          OTEL_EXPORTER_OTLP_ENDPOINT: "https://collector:4318/base",
        },
        traces: "https://tempo:4318/custom",
        metrics: "https://collector:4318/base/v1/metrics",
        logs: "https://collector:4318/base/v1/logs",
        warnings: [],
      },
      {
        name: "a blank per-signal endpoint falls through to the generic one",
        env: {
          OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "  ",
          OTEL_EXPORTER_OTLP_ENDPOINT: "https://collector:4318/base",
        },
        traces: "https://collector:4318/base/v1/traces",
        metrics: "https://collector:4318/base/v1/metrics",
        logs: "https://collector:4318/base/v1/logs",
        warnings: [],
      },
      {
        name: "an invalid per-signal endpoint warns and does not fall through",
        env: {
          OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "not-a-url",
          OTEL_EXPORTER_OTLP_ENDPOINT: "https://collector:4318/base",
        },
        traces: "Off",
        metrics: "https://collector:4318/base/v1/metrics",
        logs: "https://collector:4318/base/v1/logs",
        warnings: [
          "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT is not an http or https URL, so the signals it configures are not exported",
        ],
      },
      {
        name: "an invalid generic endpoint warns without leaking its query",
        env: { OTEL_EXPORTER_OTLP_ENDPOINT: "not-a-url?api_key=secret" },
        traces: "Off",
        metrics: "Off",
        logs: "Off",
        warnings: [
          "OTEL_EXPORTER_OTLP_ENDPOINT is not an http or https URL, so the signals it configures are not exported",
        ],
      },
      {
        name: "an endpoint without a scheme is not an http URL",
        env: { OTEL_EXPORTER_OTLP_ENDPOINT: "localhost:4318" },
        traces: "Off",
        metrics: "Off",
        logs: "Off",
        warnings: [
          "OTEL_EXPORTER_OTLP_ENDPOINT is not an http or https URL, so the signals it configures are not exported",
        ],
      },
      {
        name: "the kill switch wins outright over a valid endpoint",
        env: {
          T3CODE_OTEL_SDK_DISABLED: "true",
          OTEL_EXPORTER_OTLP_ENDPOINT: "https://collector:4318/base",
        },
        traces: "Unset",
        metrics: "Unset",
        logs: "Unset",
        warnings: [T3_OFF],
      },
    ])("$name", ({ env, traces, metrics, logs, warnings }) =>
      Effect.gen(function* () {
        const resolved = yield* load(env);
        assert.strictEqual(urlOf(resolved.traces), traces);
        assert.strictEqual(urlOf(resolved.metrics), metrics);
        assert.strictEqual(urlOf(resolved.logs), logs);
        assert.deepStrictEqual(resolved.warnings, warnings);
      }),
    );

    const ENDPOINT = { OTEL_EXPORTER_OTLP_ENDPOINT: "https://collector:4318" };
    const exportOf = (signal: OtelEnvironment.OtelSignal): unknown =>
      OtelEnvironment.OtelSignal.$match(signal, {
        Export: ({ protocol, headers }) => ({ protocol, headers }),
        Off: () => "Off",
        Unset: () => "Unset",
      });
    it.effect.each([
      {
        name: "nothing else set takes the specification's default protocol",
        env: ENDPOINT,
        traces: { protocol: "http/protobuf", headers: undefined },
        logs: { protocol: "http/protobuf", headers: undefined },
        warnings: [],
      },
      {
        name: "headers are comma-separated pairs with percent-encoded values",
        env: { ...ENDPOINT, OTEL_EXPORTER_OTLP_HEADERS: "api-key=a%20b,tenant=t3" },
        traces: { protocol: "http/protobuf", headers: { "api-key": "a b", tenant: "t3" } },
        logs: { protocol: "http/protobuf", headers: { "api-key": "a b", tenant: "t3" } },
        warnings: [],
      },
      {
        name: "a per-signal protocol and headers beat the generic ones",
        env: {
          ...ENDPOINT,
          OTEL_EXPORTER_OTLP_PROTOCOL: "http/json",
          OTEL_EXPORTER_OTLP_HEADERS: "api-key=shared",
          OTEL_EXPORTER_OTLP_TRACES_PROTOCOL: "http/protobuf",
          OTEL_EXPORTER_OTLP_TRACES_HEADERS: "api-key=traces%20only",
        },
        traces: { protocol: "http/protobuf", headers: { "api-key": "traces only" } },
        logs: { protocol: "http/json", headers: { "api-key": "shared" } },
        warnings: [],
      },
      {
        name: "an unsupported protocol turns off the signals it configures",
        env: { ...ENDPOINT, OTEL_EXPORTER_OTLP_LOGS_PROTOCOL: "grpc" },
        traces: { protocol: "http/protobuf", headers: undefined },
        logs: "Off",
        warnings: [
          "OTEL_EXPORTER_OTLP_LOGS_PROTOCOL is not http/protobuf or http/json, so the signals it configures are not exported",
        ],
      },
      {
        name: "a protocol reads case-insensitively",
        env: { ...ENDPOINT, OTEL_EXPORTER_OTLP_PROTOCOL: "HTTP/JSON" },
        traces: { protocol: "http/json", headers: undefined },
        logs: { protocol: "http/json", headers: undefined },
        warnings: [],
      },
      {
        name: "undecodable headers turn off every signal once, without leaking them",
        env: { ...ENDPOINT, OTEL_EXPORTER_OTLP_HEADERS: "api-key=%zz" },
        traces: "Off",
        logs: "Off",
        warnings: [
          "OTEL_EXPORTER_OTLP_HEADERS is not a list of key=value pairs with percent-encoded values, so the signals it configures are not exported",
        ],
      },
      {
        name: "a header without a value separator turns its signal off",
        env: { ...ENDPOINT, OTEL_EXPORTER_OTLP_LOGS_HEADERS: "Authorization" },
        traces: { protocol: "http/protobuf", headers: undefined },
        logs: "Off",
        warnings: [
          "OTEL_EXPORTER_OTLP_LOGS_HEADERS is not a list of key=value pairs with percent-encoded values, so the signals it configures are not exported",
        ],
      },
      {
        name: "blank per-signal headers leave the generic ones in charge",
        env: {
          ...ENDPOINT,
          OTEL_EXPORTER_OTLP_HEADERS: "api-key=shared",
          OTEL_EXPORTER_OTLP_LOGS_HEADERS: "  ",
        },
        traces: { protocol: "http/protobuf", headers: { "api-key": "shared" } },
        logs: { protocol: "http/protobuf", headers: { "api-key": "shared" } },
        warnings: [],
      },
      {
        name: "generic headers every signal overrides say nothing",
        env: {
          OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "https://tempo:4318/v1/traces",
          OTEL_EXPORTER_OTLP_TRACES_HEADERS: "api-key=traces",
          OTEL_EXPORTER_OTLP_HEADERS: "api-key=%zz",
        },
        traces: { protocol: "http/protobuf", headers: { "api-key": "traces" } },
        logs: "Unset",
        warnings: [],
      },
      {
        name: "protocol and headers say nothing for a signal no endpoint names",
        env: { OTEL_EXPORTER_OTLP_PROTOCOL: "grpc", OTEL_EXPORTER_OTLP_HEADERS: "api-key=%zz" },
        traces: "Unset",
        logs: "Unset",
        warnings: [],
      },
    ])("$name", ({ env, traces, logs, warnings }) =>
      Effect.gen(function* () {
        const resolved = yield* load(env);
        assert.deepStrictEqual(exportOf(resolved.traces), traces);
        assert.deepStrictEqual(exportOf(resolved.logs), logs);
        assert.deepStrictEqual(resolved.warnings, warnings);
      }),
    );
  });

  describe("resolveSignalEndpoint", () => {
    const t3Export = {
      protocol: "http/json",
      headers: { "x-key": "t3" },
      exportIntervalMs: 5_000,
    } as const;
    const withLogs = (logs: OtelEnvironment.OtelSignal, disabled = false) => ({
      ...OtelEnvironment.none,
      disabled,
      logs,
    });
    const otelExport = OtelEnvironment.OtelSignal.Export({
      url: "http://otel:4318/v1/logs",
      protocol: "http/protobuf",
      headers: { "x-key": "otel" },
    });
    it.each([
      {
        name: "T3CODE_OTLP_*_URL wins over an OTEL endpoint",
        otel: withLogs(otelExport),
        t3Url: "http://t3:4318/v1/logs",
        expected: { url: "http://t3:4318/v1/logs", export: t3Export },
      },
      {
        name: "T3CODE_OTLP_*_URL wins over a signal the OTEL variables turned off",
        otel: withLogs(OtelEnvironment.OtelSignal.Off()),
        t3Url: "http://t3:4318/v1/logs",
        expected: { url: "http://t3:4318/v1/logs", export: t3Export },
      },
      {
        name: "an OTEL endpoint brings its headers and protocol over the fallback",
        otel: withLogs(otelExport),
        t3Url: " ",
        expected: {
          url: "http://otel:4318/v1/logs",
          export: {
            protocol: "http/protobuf" as const,
            headers: { "x-key": "otel" },
            exportIntervalMs: 5_000,
          },
        },
      },
      {
        name: "a signal the OTEL variables turned off does not fall through",
        otel: withLogs(OtelEnvironment.OtelSignal.Off()),
        t3Url: undefined,
        expected: undefined,
      },
      {
        name: "an unset signal takes the first non-blank fallback",
        otel: withLogs(OtelEnvironment.OtelSignal.Unset()),
        t3Url: undefined,
        expected: { url: "http://settings:4318/v1/logs", export: t3Export },
      },
      {
        name: "the kill switch wins over everything",
        otel: withLogs(otelExport, true),
        t3Url: "http://t3:4318/v1/logs",
        expected: undefined,
      },
    ])("$name", ({ otel, t3Url, expected }) => {
      assert.deepStrictEqual(
        OtelEnvironment.resolveSignalEndpoint(
          otel,
          "logs",
          { url: t3Url, export: t3Export },
          "",
          "http://settings:4318/v1/logs",
        ),
        expected,
      );
    });
  });

  describe("layerResourceAttributes", () => {
    it.effect.each([
      { name: "a list that does not decode", raw: "team=%zz", attributes: [] },
      { name: "encoded separators", raw: "a%2Cb=x%3Dy", attributes: ["a,b"] },
    ])("lets the exporters' own read succeed with $name", ({ raw, attributes }) =>
      Effect.gen(function* () {
        const env = ConfigProvider.layer(
          ConfigProvider.fromEnv({ env: { OTEL_RESOURCE_ATTRIBUTES: raw } }),
        );
        const otel = yield* OtelEnvironment.load.pipe(Effect.provide(env));
        const resource = yield* OtlpResource.fromConfig({ serviceName: "t3" }).pipe(
          Effect.provide(
            Layer.provide(OtelEnvironment.layerResourceAttributes(otel.resourceAttributes), env),
          ),
        );
        assert.deepStrictEqual(
          resource.attributes.map((attribute) => attribute.key),
          [...attributes, "service.name"],
        );
      }),
    );
  });
});
