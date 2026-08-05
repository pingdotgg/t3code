import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as EffectAcpErrors from "effect-acp/errors";

import {
  applyGrokAcpConfigSelections,
  applyGrokAcpModelSelection,
  applyGrokPlanModeToPromptText,
  buildGrokAcpSpawnInput,
  resolveGrokAcpBaseModelId,
  resolveGrokReasoningEffortSelection,
} from "./GrokAcpSupport.ts";

describe("resolveGrokAcpBaseModelId", () => {
  it("normalizes empty and custom Grok model ids", () => {
    expect(resolveGrokAcpBaseModelId(undefined)).toBe("grok-build");
    expect(resolveGrokAcpBaseModelId("   ")).toBe("grok-build");
    expect(resolveGrokAcpBaseModelId("  grok-test-custom-model  ")).toBe("grok-test-custom-model");
  });
});

describe("buildGrokAcpSpawnInput", () => {
  it("passes the T3 Code referrer through Grok OAuth env", () => {
    const spawn = buildGrokAcpSpawnInput({ binaryPath: "/usr/local/bin/grok" }, "/tmp/project", {
      XAI_API_KEY: "secret",
      GROK_OAUTH2_REFERRER: "other-client",
    });

    expect(spawn).toEqual({
      command: "/usr/local/bin/grok",
      args: ["agent", "stdio"],
      cwd: "/tmp/project",
      env: {
        XAI_API_KEY: "secret",
        GROK_OAUTH2_REFERRER: "t3code",
      },
    });
  });

  it("passes model and reasoning effort as CLI flags (live Grok wire contract)", () => {
    const spawn = buildGrokAcpSpawnInput({ binaryPath: "grok" }, "/repo", undefined, {
      model: "grok-4.5",
      reasoningEffort: "low",
      alwaysApprove: true,
    });
    expect(spawn.args).toEqual([
      "agent",
      "--model",
      "grok-4.5",
      "--reasoning-effort",
      "low",
      "--always-approve",
      "stdio",
    ]);
  });
});

describe("resolveGrokReasoningEffortSelection", () => {
  it("reads reasoningEffort, reasoning, or effort option ids", () => {
    expect(resolveGrokReasoningEffortSelection([{ id: "reasoningEffort", value: "low" }])).toBe(
      "low",
    );
    expect(resolveGrokReasoningEffortSelection([{ id: "reasoning", value: "high" }])).toBe("high");
    expect(resolveGrokReasoningEffortSelection([{ id: "effort", value: "medium" }])).toBe("medium");
    expect(resolveGrokReasoningEffortSelection([{ id: "other", value: "x" }])).toBeUndefined();
    expect(resolveGrokReasoningEffortSelection(undefined)).toBeUndefined();
  });
});

describe("applyGrokAcpModelSelection", () => {
  const makeRecordingRuntime = (failure?: EffectAcpErrors.AcpError) => {
    const modelCalls: Array<string> = [];
    const runtime = {
      setSessionModel: (modelId: string) =>
        Effect.gen(function* () {
          modelCalls.push(modelId);
          if (failure) return yield* failure;
          return {};
        }),
    };
    return { runtime, modelCalls };
  };

  it.effect("calls session/set_model when the requested model differs from current", () =>
    Effect.gen(function* () {
      const { runtime, modelCalls } = makeRecordingRuntime();
      const result = yield* applyGrokAcpModelSelection({
        runtime,
        currentModelId: "grok-build",
        requestedModelId: "grok-mock-alt",
        mapError: (cause) => cause.message,
      });
      expect(modelCalls).toEqual(["grok-mock-alt"]);
      expect(result).toBe("grok-mock-alt");
    }),
  );

  it.effect("skips set_model when requested matches current", () =>
    Effect.gen(function* () {
      const { runtime, modelCalls } = makeRecordingRuntime();
      const result = yield* applyGrokAcpModelSelection({
        runtime,
        currentModelId: "grok-build",
        requestedModelId: "grok-build",
        mapError: (cause) => cause.message,
      });
      expect(modelCalls).toEqual([]);
      expect(result).toBe("grok-build");
    }),
  );

  it.effect("skips set_model when no model is requested", () =>
    Effect.gen(function* () {
      const { runtime, modelCalls } = makeRecordingRuntime();
      const result = yield* applyGrokAcpModelSelection({
        runtime,
        currentModelId: "grok-build",
        requestedModelId: undefined,
        mapError: (cause) => cause.message,
      });
      expect(modelCalls).toEqual([]);
      expect(result).toBe("grok-build");
    }),
  );

  it.effect("propagates session/set_model failures via mapError", () =>
    Effect.gen(function* () {
      const failure = EffectAcpErrors.AcpRequestError.invalidParams("session id not known");
      const { runtime } = makeRecordingRuntime(failure);
      const error = yield* Effect.flip(
        applyGrokAcpModelSelection({
          runtime,
          currentModelId: "grok-build",
          requestedModelId: "grok-mock-alt",
          mapError: (cause) => cause.message,
        }),
      );
      expect(error).toBe(failure.message);
    }),
  );
});

describe("applyGrokAcpConfigSelections", () => {
  it.effect("sets effort config option when advertised and selected", () =>
    Effect.gen(function* () {
      const calls: Array<{ id: string; value: string | boolean }> = [];
      yield* applyGrokAcpConfigSelections({
        runtime: {
          getConfigOptions: Effect.succeed([
            {
              id: "effort",
              name: "Reasoning",
              category: "thought_level",
              type: "select",
              currentValue: "low",
              options: [
                { value: "low", name: "Low" },
                { value: "high", name: "High" },
              ],
            },
          ]),
          setConfigOption: ((id: string, value: string | boolean) =>
            Effect.sync(() => {
              calls.push({ id, value });
              return {};
            })) as never,
        },
        selections: [{ id: "reasoningEffort", value: "high" }],
        mapError: (cause) => cause.message,
      });
      expect(calls).toEqual([{ id: "effort", value: "high" }]);
    }),
  );

  it.effect("skips when selection already matches current", () =>
    Effect.gen(function* () {
      const calls: Array<{ id: string; value: string | boolean }> = [];
      yield* applyGrokAcpConfigSelections({
        runtime: {
          getConfigOptions: Effect.succeed([
            {
              id: "effort",
              name: "Reasoning",
              type: "select",
              currentValue: "high",
              options: [{ value: "high", name: "High" }],
            },
          ]),
          setConfigOption: ((id: string, value: string | boolean) =>
            Effect.sync(() => {
              calls.push({ id, value });
              return {};
            })) as never,
        },
        selections: [{ id: "reasoningEffort", value: "high" }],
        mapError: (cause) => cause.message,
      });
      expect(calls).toEqual([]);
    }),
  );
});

describe("applyGrokPlanModeToPromptText", () => {
  it("prefixes /plan when interactionMode is plan", () => {
    expect(applyGrokPlanModeToPromptText({ text: "design auth", interactionMode: "plan" })).toBe(
      "/plan design auth",
    );
  });

  it("does not double-prefix /plan", () => {
    expect(applyGrokPlanModeToPromptText({ text: "/plan already", interactionMode: "plan" })).toBe(
      "/plan already",
    );
  });

  it("accepts case-insensitive existing /Plan prefix", () => {
    expect(applyGrokPlanModeToPromptText({ text: "/Plan design", interactionMode: "plan" })).toBe(
      "/Plan design",
    );
  });

  it("leaves default mode text unchanged", () => {
    expect(applyGrokPlanModeToPromptText({ text: "hello", interactionMode: "default" })).toBe(
      "hello",
    );
  });

  it("returns undefined/empty for blank plan prompts", () => {
    expect(applyGrokPlanModeToPromptText({ text: undefined, interactionMode: "plan" })).toBe(
      undefined,
    );
    expect(applyGrokPlanModeToPromptText({ text: "   ", interactionMode: "plan" })).toBe("");
  });
});
