import { describe, expect, it } from "@effect/vitest";

import * as Effect from "effect/Effect";
import * as EffectAcpErrors from "effect-acp/errors";

import { applyGrokAcpModelSelection, grokAcpSpawnArgs } from "./acpSupport.ts";

describe("grokAcpSpawnArgs", () => {
  it("inherits the Grok CLI config when no T3 runtime mode is set", () => {
    expect(grokAcpSpawnArgs()).toEqual(["agent", "stdio"]);
  });

  it("forces Grok to ask when T3 is Supervised", () => {
    expect(grokAcpSpawnArgs("approval-required")).toEqual([
      "--permission-mode",
      "default",
      "agent",
      "stdio",
    ]);
  });
});

describe("applyGrokAcpModelSelection", () => {
  const makeRecordingRuntime = (failure?: EffectAcpErrors.AcpError) => {
    const modelCalls: Array<{
      modelId: string;
      meta?: { readonly [key: string]: unknown } | null;
    }> = [];
    const runtime = {
      setSessionModel: (modelId: string, meta?: { readonly [key: string]: unknown } | null) =>
        Effect.gen(function* () {
          modelCalls.push(meta === undefined ? { modelId } : { modelId, meta });
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

  it.effect("applies reasoning effort through session/set_model metadata", () =>
    Effect.gen(function* () {
      const { runtime, modelCalls } = makeRecordingRuntime();
      const result = yield* applyGrokAcpModelSelection({
        runtime,
        currentModelId: "grok-4.6",
        currentReasoningEffort: "high",
        requestedModelId: "grok-4.6",
        requestedReasoningEffort: "xhigh",
        mapError: (cause) => cause.message,
      });
      expect(modelCalls).toEqual([{ modelId: "grok-4.6", meta: { reasoningEffort: "xhigh" } }]);
      expect(result).toBe("grok-4.6");
    }),
  );

  it.effect("drops malformed effort metadata instead of sending it", () =>
    Effect.gen(function* () {
      const { runtime, modelCalls } = makeRecordingRuntime();
      yield* applyGrokAcpModelSelection({
        runtime,
        currentModelId: "grok-4.6",
        currentReasoningEffort: "high",
        requestedModelId: "grok-4.6",
        requestedReasoningEffort: "not a token",
        mapError: (cause) => cause.message,
      });
      expect(modelCalls).toEqual([{ modelId: "grok-4.6" }]);
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

  it.effect("keeps the session's current model when the product slug is requested", () =>
    Effect.gen(function* () {
      const { runtime, modelCalls } = makeRecordingRuntime();
      const result = yield* applyGrokAcpModelSelection({
        runtime,
        currentModelId: "grok-4.6",
        requestedModelId: "grok-build",
        mapError: (cause) => cause.message,
      });
      expect(modelCalls).toEqual([]);
      expect(result).toBe("grok-4.6");
    }),
  );

  it.effect("applies reasoning to the current model when the product slug is requested", () =>
    Effect.gen(function* () {
      const { runtime, modelCalls } = makeRecordingRuntime();
      const result = yield* applyGrokAcpModelSelection({
        runtime,
        currentModelId: "grok-4.6",
        currentReasoningEffort: "high",
        requestedModelId: "grok-build",
        requestedReasoningEffort: "xhigh",
        mapError: (cause) => cause.message,
      });
      expect(modelCalls).toEqual([{ modelId: "grok-4.6", meta: { reasoningEffort: "xhigh" } }]);
      expect(result).toBe("grok-4.6");
    }),
  );
});
