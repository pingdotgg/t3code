import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as EffectAcpErrors from "effect-acp/errors";

import {
  applyGrokAcpModelSelection,
  buildGrokAcpSpawnInput,
  currentGrokModelSelectionFromSessionSetup,
  resolveGrokAcpBaseModelId,
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
});

describe("applyGrokAcpModelSelection", () => {
  const makeRecordingRuntime = (failure?: EffectAcpErrors.AcpError) => {
    const modelCalls: Array<{ modelId: string; meta?: Readonly<Record<string, unknown>> }> = [];
    const runtime = {
      setSessionModel: (modelId: string, meta?: Readonly<Record<string, unknown>>) =>
        Effect.gen(function* () {
          modelCalls.push({ modelId, ...(meta ? { meta } : {}) });
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
        currentReasoningEffort: "medium",
        requestedModelId: "grok-mock-alt",
        requestedReasoningEffort: "high",
        mapError: (cause) => cause.message,
      });
      expect(modelCalls).toEqual([{ modelId: "grok-mock-alt", meta: { reasoningEffort: "high" } }]);
      expect(result).toEqual({ modelId: "grok-mock-alt", reasoningEffort: "high" });
    }),
  );

  it.effect("changes reasoning on the current model without a redundant model transition", () =>
    Effect.gen(function* () {
      const { runtime, modelCalls } = makeRecordingRuntime();
      const result = yield* applyGrokAcpModelSelection({
        runtime,
        currentModelId: "grok-4.6",
        currentReasoningEffort: "medium",
        requestedModelId: "grok-4.6",
        requestedReasoningEffort: "low",
        mapError: (cause) => cause.message,
      });
      expect(modelCalls).toEqual([{ modelId: "grok-4.6", meta: { reasoningEffort: "low" } }]);
      expect(result).toEqual({ modelId: "grok-4.6", reasoningEffort: "low" });
    }),
  );

  it.effect("keeps the CLI-selected model for the legacy grok-build sentinel", () =>
    Effect.gen(function* () {
      const { runtime, modelCalls } = makeRecordingRuntime();
      const result = yield* applyGrokAcpModelSelection({
        runtime,
        currentModelId: "grok-4.6",
        currentReasoningEffort: "medium",
        requestedModelId: "grok-build",
        requestedReasoningEffort: "medium",
        mapError: (cause) => cause.message,
      });
      expect(modelCalls).toEqual([]);
      expect(result).toEqual({ modelId: "grok-4.6", reasoningEffort: "medium" });
    }),
  );

  it.effect("clears the tracked effort when changing models without an explicit effort", () =>
    Effect.gen(function* () {
      const { runtime, modelCalls } = makeRecordingRuntime();
      const result = yield* applyGrokAcpModelSelection({
        runtime,
        currentModelId: "grok-4.6",
        currentReasoningEffort: "high",
        requestedModelId: "grok-4.5",
        requestedReasoningEffort: undefined,
        mapError: (cause) => cause.message,
      });
      expect(modelCalls).toEqual([{ modelId: "grok-4.5" }]);
      expect(result).toEqual({ modelId: "grok-4.5", reasoningEffort: undefined });
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
          currentReasoningEffort: "medium",
          requestedModelId: "grok-mock-alt",
          requestedReasoningEffort: "high",
          mapError: (cause) => cause.message,
        }),
      );
      expect(error).toBe(failure.message);
    }),
  );
});

describe("currentGrokModelSelectionFromSessionSetup", () => {
  it("reads the current effort and context window from Grok model metadata", () => {
    expect(
      currentGrokModelSelectionFromSessionSetup({
        sessionId: "session-1",
        models: {
          currentModelId: "grok-4.6",
          availableModels: [
            {
              modelId: "grok-4.6",
              name: "Grok 4.6",
              _meta: {
                reasoningEffort: "high",
                totalContextTokens: 262_144,
              },
            },
          ],
        },
      }),
    ).toEqual({
      modelId: "grok-4.6",
      reasoningEffort: "high",
      totalContextTokens: 262_144,
    });
  });
});
