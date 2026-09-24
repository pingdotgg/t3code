import { assert, describe, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";

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
});
