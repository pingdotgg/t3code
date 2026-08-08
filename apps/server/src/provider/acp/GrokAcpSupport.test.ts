import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as EffectAcpErrors from "effect-acp/errors";

import {
  applyGrokAcpConfigSelections,
  applyGrokAcpModelSelection,
  applyGrokPlanModeToPromptText,
  buildGrokAcpSpawnInput,
  isGrokSubagentToolCall,
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
    const modelCalls: Array<{
      modelId: string;
      options?: { readonly _meta?: { readonly [x: string]: unknown } | null };
    }> = [];
    const runtime = {
      setSessionModel: (
        modelId: string,
        options?: { readonly _meta?: { readonly [x: string]: unknown } | null },
      ) =>
        Effect.gen(function* () {
          modelCalls.push({ modelId, ...(options ? { options } : {}) });
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
      expect(modelCalls).toEqual([{ modelId: "grok-mock-alt" }]);
      expect(result).toBe("grok-mock-alt");
    }),
  );

  it.effect("skips set_model when requested matches current and no effort", () =>
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

  it.effect("skips set_model when no model is requested and no effort", () =>
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

  it.effect("calls set_model with reasoningEffort _meta for effort-only change", () =>
    Effect.gen(function* () {
      const { runtime, modelCalls } = makeRecordingRuntime();
      const result = yield* applyGrokAcpModelSelection({
        runtime,
        currentModelId: "grok-build",
        requestedModelId: undefined,
        selections: [{ id: "reasoningEffort", value: "high" }],
        mapError: (cause) => cause.message,
      });
      expect(modelCalls).toEqual([
        {
          modelId: "grok-build",
          options: { _meta: { reasoningEffort: "high" } },
        },
      ]);
      expect(result).toBe("grok-build");
    }),
  );

  it.effect("skips set_model when effort matches currentEffort", () =>
    Effect.gen(function* () {
      const { runtime, modelCalls } = makeRecordingRuntime();
      const result = yield* applyGrokAcpModelSelection({
        runtime,
        currentModelId: "grok-build",
        requestedModelId: undefined,
        selections: [{ id: "reasoningEffort", value: "high" }],
        currentEffort: "high",
        mapError: (cause) => cause.message,
      });
      expect(modelCalls).toEqual([]);
      expect(result).toBe("grok-build");
    }),
  );

  it.effect("applies effort change when currentEffort differs", () =>
    Effect.gen(function* () {
      const { runtime, modelCalls } = makeRecordingRuntime();
      const result = yield* applyGrokAcpModelSelection({
        runtime,
        currentModelId: "grok-build",
        requestedModelId: undefined,
        selections: [{ id: "reasoningEffort", value: "low" }],
        currentEffort: "high",
        mapError: (cause) => cause.message,
      });
      expect(modelCalls).toEqual([
        {
          modelId: "grok-build",
          options: { _meta: { reasoningEffort: "low" } },
        },
      ]);
      expect(result).toBe("grok-build");
    }),
  );

  it.effect("returns undefined without set_model when effort-only and no model id", () =>
    Effect.gen(function* () {
      const { runtime, modelCalls } = makeRecordingRuntime();
      const result = yield* applyGrokAcpModelSelection({
        runtime,
        currentModelId: undefined,
        requestedModelId: undefined,
        selections: [{ id: "reasoningEffort", value: "high" }],
        mapError: (cause) => cause.message,
      });
      expect(modelCalls).toEqual([]);
      expect(result).toBeUndefined();
    }),
  );

  it.effect("calls set_model with model switch and effort _meta together", () =>
    Effect.gen(function* () {
      const { runtime, modelCalls } = makeRecordingRuntime();
      const result = yield* applyGrokAcpModelSelection({
        runtime,
        currentModelId: "grok-build",
        requestedModelId: "grok-mock-alt",
        selections: [{ id: "reasoningEffort", value: "low" }],
        mapError: (cause) => cause.message,
      });
      expect(modelCalls).toEqual([
        {
          modelId: "grok-mock-alt",
          options: { _meta: { reasoningEffort: "low" } },
        },
      ]);
      expect(result).toBe("grok-mock-alt");
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

  it("leaves default mode text unchanged when not in plan mode", () => {
    expect(applyGrokPlanModeToPromptText({ text: "hello", interactionMode: "default" })).toBe(
      "hello",
    );
  });

  it("prefixes /default when leaving plan mode for Build", () => {
    expect(
      applyGrokPlanModeToPromptText({
        text: "implement it",
        interactionMode: "default",
        planModeActive: true,
      }),
    ).toBe("/default implement it");
  });

  it("does not double-prefix /default", () => {
    expect(
      applyGrokPlanModeToPromptText({
        text: "/default already",
        interactionMode: "default",
        planModeActive: true,
      }),
    ).toBe("/default already");
  });

  it("does not prefix plan/default onto other slash commands", () => {
    expect(
      applyGrokPlanModeToPromptText({ text: "/compact keep auth", interactionMode: "plan" }),
    ).toBe("/compact keep auth");
    expect(
      applyGrokPlanModeToPromptText({
        text: "/compact keep auth",
        interactionMode: "default",
        planModeActive: true,
      }),
    ).toBe("/compact keep auth");
    expect(
      applyGrokPlanModeToPromptText({
        text: "/session-info",
        interactionMode: "default",
        planModeActive: true,
      }),
    ).toBe("/session-info");
  });

  it("returns /default for blank Build prompts while plan mode is active", () => {
    expect(
      applyGrokPlanModeToPromptText({
        text: undefined,
        interactionMode: "default",
        planModeActive: true,
      }),
    ).toBe("/default");
  });

  it("returns /plan for blank plan prompts", () => {
    expect(applyGrokPlanModeToPromptText({ text: undefined, interactionMode: "plan" })).toBe(
      "/plan",
    );
    expect(applyGrokPlanModeToPromptText({ text: "   ", interactionMode: "plan" })).toBe("/plan");
  });

  it("returns undefined/empty for blank non-plan prompts", () => {
    expect(applyGrokPlanModeToPromptText({ text: undefined, interactionMode: "default" })).toBe(
      undefined,
    );
    expect(applyGrokPlanModeToPromptText({ text: "   ", interactionMode: "default" })).toBe("");
    expect(applyGrokPlanModeToPromptText({ text: undefined, interactionMode: undefined })).toBe(
      undefined,
    );
  });
});

describe("isGrokSubagentToolCall", () => {
  it("matches spawn_subagent by tool name", () => {
    expect(
      isGrokSubagentToolCall({
        toolCallId: "tc_1",
        data: { name: "spawn_subagent" },
      }),
    ).toBe(true);
  });

  it("matches spawn-style titles after normalize", () => {
    expect(
      isGrokSubagentToolCall({
        toolCallId: "tc_2",
        title: "Spawn subagent: explore",
        data: {},
      }),
    ).toBe(true);
  });

  it("does not match ordinary tools whose detail mentions subagent", () => {
    expect(
      isGrokSubagentToolCall({
        toolCallId: "tc_detail",
        title: "Read file",
        kind: "read",
        detail: "notes about a subagent workflow",
        data: { name: "read_file" },
      }),
    ).toBe(false);
  });

  it("does not match ordinary tools", () => {
    expect(
      isGrokSubagentToolCall({
        toolCallId: "tc_3",
        title: "Read file",
        kind: "read",
        data: { name: "read_file" },
      }),
    ).toBe(false);
  });
});
