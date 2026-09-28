import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import {
  applyDshAcpModelSelection,
  buildDshAcpSpawnInput,
  currentDshModelWireValueFromSessionSetup,
  currentDshReasoningEffortFromSessionSetup,
  dshAcpSpawnArgs,
} from "./DshAcpSupport.ts";

const WIRE_ROUTE = JSON.stringify(["deepseek-official", "deepseek-v4-flash"]);
const OTHER_WIRE_ROUTE = JSON.stringify(["deepseek-official", "deepseek-v4-pro"]);

describe("dshAcpSpawnArgs", () => {
  it("spawns the CLI in the ACP profile", () => {
    expect(dshAcpSpawnArgs()).toEqual(["--profile", "acp"]);
  });
});

describe("buildDshAcpSpawnInput", () => {
  it("falls back to the PATH dsh binary when settings are absent", () => {
    const cwd = "/work/project";
    for (const settings of [undefined, null]) {
      expect(buildDshAcpSpawnInput(settings, cwd)).toEqual({
        command: "dsh",
        args: ["--profile", "acp"],
        cwd,
      });
    }
  });

  it("uses the configured binary path and passes the environment through", () => {
    const environment = { PATH: "/usr/bin", DEEPSEEK_API_KEY: "sk-test" };
    const spawn = buildDshAcpSpawnInput(
      { binaryPath: "/opt/dsh/bin/dsh" },
      "/work/project",
      environment,
    );
    expect(spawn.command).toBe("/opt/dsh/bin/dsh");
    expect(spawn.cwd).toBe("/work/project");
    expect(spawn.env).toEqual(environment);
  });

  it("omits the env key when no environment is provided", () => {
    const spawn = buildDshAcpSpawnInput({ binaryPath: "dsh" }, "/work/project");
    expect("env" in spawn).toBe(false);
  });
});

const modelSelectOption = (
  currentValue: string,
  options: EffectAcpSchema.SessionConfigSelectOption[] = [
    { value: WIRE_ROUTE, name: "DeepSeek V4 Flash" },
  ],
) => ({
  id: "model",
  name: "Model",
  type: "select" as const,
  currentValue,
  options,
});

describe("currentDshModelWireValueFromSessionSetup", () => {
  it("reads the wire route from a flat select option", () => {
    const setup: EffectAcpSchema.NewSessionResponse = {
      sessionId: "s1",
      configOptions: [modelSelectOption(WIRE_ROUTE)],
    };
    expect(currentDshModelWireValueFromSessionSetup(setup)).toBe(WIRE_ROUTE);
  });

  it("reads the wire route from a select option with grouped options", () => {
    const setup: EffectAcpSchema.NewSessionResponse = {
      sessionId: "s1",
      configOptions: [
        {
          id: "model",
          name: "Model",
          type: "select",
          currentValue: OTHER_WIRE_ROUTE,
          options: [
            {
              group: "DeepSeek",
              name: "DeepSeek models",
              options: [
                { value: WIRE_ROUTE, name: "Flash" },
                { value: OTHER_WIRE_ROUTE, name: "Pro" },
              ],
            },
          ],
        },
      ],
    };
    expect(currentDshModelWireValueFromSessionSetup(setup)).toBe(OTHER_WIRE_ROUTE);
  });

  it("returns undefined for a blank currentValue", () => {
    const setup: EffectAcpSchema.NewSessionResponse = {
      sessionId: "s1",
      configOptions: [modelSelectOption("   ")],
    };
    expect(currentDshModelWireValueFromSessionSetup(setup)).toBeUndefined();
  });

  it("returns undefined when the model option is missing or not a select", () => {
    const missing: EffectAcpSchema.NewSessionResponse = { sessionId: "s1" };
    expect(currentDshModelWireValueFromSessionSetup(missing)).toBeUndefined();
    expect(
      currentDshModelWireValueFromSessionSetup({
        sessionId: "s1",
        configOptions: [{ id: "model", name: "Model", type: "boolean", currentValue: true }],
      }),
    ).toBeUndefined();
    const nullOptions: EffectAcpSchema.NewSessionResponse = {
      sessionId: "s1",
      configOptions: null,
    };
    expect(currentDshModelWireValueFromSessionSetup(nullOptions)).toBeUndefined();
  });
});

describe("currentDshReasoningEffortFromSessionSetup", () => {
  const reasoningSelectOption = (currentValue: string) => ({
    id: "reasoning_effort",
    name: "Reasoning effort",
    type: "select" as const,
    currentValue,
    options: [
      { value: "", name: "Default" },
      { value: "high", name: "High" },
    ],
  });

  it("returns the provider default marker for an empty currentValue", () => {
    const setup: EffectAcpSchema.NewSessionResponse = {
      sessionId: "s1",
      configOptions: [reasoningSelectOption("")],
    };
    expect(currentDshReasoningEffortFromSessionSetup(setup)).toBe("");
  });

  it("returns the configured effort value", () => {
    const setup: EffectAcpSchema.NewSessionResponse = {
      sessionId: "s1",
      configOptions: [reasoningSelectOption("high")],
    };
    expect(currentDshReasoningEffortFromSessionSetup(setup)).toBe("high");
  });

  it("returns undefined when the option is missing or not a select", () => {
    const missing: EffectAcpSchema.NewSessionResponse = {
      sessionId: "s1",
      configOptions: [modelSelectOption(WIRE_ROUTE)],
    };
    expect(currentDshReasoningEffortFromSessionSetup(missing)).toBeUndefined();
    expect(
      currentDshReasoningEffortFromSessionSetup({
        sessionId: "s1",
        configOptions: [
          { id: "reasoning_effort", name: "Reasoning", type: "boolean", currentValue: false },
        ],
      }),
    ).toBeUndefined();
    expect(currentDshReasoningEffortFromSessionSetup({ sessionId: "s1" })).toBeUndefined();
  });
});

interface ConfigOptionCall {
  readonly id: string;
  readonly value: string | boolean;
}

const makeRecordingRuntime = (
  liveOptions: EffectAcpSchema.SessionConfigOption[],
  failure?: EffectAcpErrors.AcpError,
) => {
  const calls: ConfigOptionCall[] = [];
  let getConfigOptionsCalls = 0;
  const runtime = {
    getConfigOptions: Effect.sync(() => {
      getConfigOptionsCalls += 1;
      return liveOptions;
    }),
    setConfigOption: (id: string, value: string | boolean) =>
      Effect.gen(function* () {
        calls.push({ id, value });
        if (failure !== undefined) return yield* failure;
        return {};
      }),
  };
  return {
    runtime,
    calls,
    getConfigOptionsCalls: () => getConfigOptionsCalls,
  };
};

describe("applyDshAcpModelSelection", () => {
  it.effect("is a no-op when the requested model already matches", () =>
    Effect.gen(function* () {
      const { runtime, calls, getConfigOptionsCalls } = makeRecordingRuntime([]);
      const result = yield* applyDshAcpModelSelection({
        runtime,
        currentModel: WIRE_ROUTE,
        requestedModel: WIRE_ROUTE,
        mapError: (context) => context.cause.message,
      });
      expect(result).toBe(WIRE_ROUTE);
      expect(calls).toEqual([]);
      expect(getConfigOptionsCalls()).toBe(0);
    }),
  );

  it.effect("writes the model when it changed and reports the target", () =>
    Effect.gen(function* () {
      const { runtime, calls } = makeRecordingRuntime([]);
      const result = yield* applyDshAcpModelSelection({
        runtime,
        currentModel: WIRE_ROUTE,
        requestedModel: OTHER_WIRE_ROUTE,
        mapError: (context) => context.cause.message,
      });
      expect(result).toBe(OTHER_WIRE_ROUTE);
      expect(calls).toEqual([{ id: "model", value: OTHER_WIRE_ROUTE }]);
    }),
  );

  it.effect("returns the current model when nothing is requested", () =>
    Effect.gen(function* () {
      const { runtime, calls } = makeRecordingRuntime([]);
      const result = yield* applyDshAcpModelSelection({
        runtime,
        currentModel: WIRE_ROUTE,
        mapError: (context) => context.cause.message,
      });
      expect(result).toBe(WIRE_ROUTE);
      expect(calls).toEqual([]);
    }),
  );

  it.effect("writes the reasoning effort after the model switch when the model advertises it", () =>
    Effect.gen(function* () {
      const liveOptions: EffectAcpSchema.SessionConfigOption[] = [
        {
          id: "reasoning_effort",
          name: "Reasoning effort",
          type: "select",
          currentValue: "low",
          options: [
            { value: "low", name: "Low" },
            { value: "high", name: "High" },
          ],
        },
      ];
      const { runtime, calls } = makeRecordingRuntime(liveOptions);
      const result = yield* applyDshAcpModelSelection({
        runtime,
        currentModel: WIRE_ROUTE,
        requestedModel: OTHER_WIRE_ROUTE,
        requestedReasoningEffort: "high",
        mapError: (context) => context.cause.message,
      });
      expect(result).toBe(OTHER_WIRE_ROUTE);
      expect(calls).toEqual([
        { id: "model", value: OTHER_WIRE_ROUTE },
        { id: "reasoning_effort", value: "high" },
      ]);
    }),
  );

  it.effect("writes only the effort when the model is unchanged", () =>
    Effect.gen(function* () {
      const liveOptions: EffectAcpSchema.SessionConfigOption[] = [
        {
          id: "reasoning_effort",
          name: "Reasoning effort",
          type: "select",
          currentValue: "low",
          options: [{ value: "low", name: "Low" }],
        },
      ];
      const { runtime, calls } = makeRecordingRuntime(liveOptions);
      const result = yield* applyDshAcpModelSelection({
        runtime,
        currentModel: WIRE_ROUTE,
        requestedReasoningEffort: "high",
        mapError: (context) => context.cause.message,
      });
      expect(result).toBe(WIRE_ROUTE);
      expect(calls).toEqual([{ id: "reasoning_effort", value: "high" }]);
    }),
  );

  it.effect("skips the effort write when the live options have no reasoning_effort select", () =>
    Effect.gen(function* () {
      const { runtime, calls, getConfigOptionsCalls } = makeRecordingRuntime([]);
      yield* applyDshAcpModelSelection({
        runtime,
        currentModel: WIRE_ROUTE,
        requestedModel: OTHER_WIRE_ROUTE,
        requestedReasoningEffort: "high",
        mapError: (context) => context.cause.message,
      });
      expect(calls).toEqual([{ id: "model", value: OTHER_WIRE_ROUTE }]);
      expect(getConfigOptionsCalls()).toBe(1);
    }),
  );

  it.effect("skips the effort write when the live value already matches", () =>
    Effect.gen(function* () {
      const liveOptions: EffectAcpSchema.SessionConfigOption[] = [
        {
          id: "reasoning_effort",
          name: "Reasoning effort",
          type: "select",
          currentValue: "high",
          options: [{ value: "high", name: "High" }],
        },
      ];
      const { runtime, calls } = makeRecordingRuntime(liveOptions);
      yield* applyDshAcpModelSelection({
        runtime,
        currentModel: WIRE_ROUTE,
        requestedReasoningEffort: "high",
        mapError: (context) => context.cause.message,
      });
      expect(calls).toEqual([]);
    }),
  );

  it.effect("maps model write failures through the error context", () =>
    Effect.gen(function* () {
      const failure = EffectAcpErrors.AcpRequestError.invalidParams("boom");
      const { runtime } = makeRecordingRuntime([], failure);
      const error = yield* Effect.flip(
        applyDshAcpModelSelection({
          runtime,
          currentModel: WIRE_ROUTE,
          requestedModel: OTHER_WIRE_ROUTE,
          mapError: (context) => `${context.configId}:${context.cause.message}`,
        }),
      );
      expect(error).toBe("model:boom");
    }),
  );

  it.effect("maps effort write failures through the error context", () =>
    Effect.gen(function* () {
      const failure = EffectAcpErrors.AcpRequestError.invalidParams("boom");
      const liveOptions: EffectAcpSchema.SessionConfigOption[] = [
        {
          id: "reasoning_effort",
          name: "Reasoning effort",
          type: "select",
          currentValue: "low",
          options: [{ value: "low", name: "Low" }],
        },
      ];
      const { runtime } = makeRecordingRuntime(liveOptions, failure);
      const error = yield* Effect.flip(
        applyDshAcpModelSelection({
          runtime,
          currentModel: WIRE_ROUTE,
          requestedReasoningEffort: "high",
          mapError: (context) => `${context.configId}:${context.cause.message}`,
        }),
      );
      expect(error).toBe("reasoning_effort:boom");
    }),
  );
});
