import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as EffectAcpErrors from "effect-acp/errors";

import {
  applyGrokAcpModelSelection,
  buildGrokAcpSpawnInput,
  currentGrokReasoningEffortFromSessionSetup,
  grokReasoningEffortLevelsFromModelMeta,
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

describe("grokReasoningEffortLevelsFromModelMeta", () => {
  const meta = {
    supportsReasoningEffort: true,
    reasoningEffort: "medium",
    reasoningEfforts: [
      { id: "xhigh", value: "xhigh", label: "Extra High Effort", default: true },
      { id: "high", value: "high", label: "High Effort", default: true },
      { id: "medium", value: "medium", label: "Medium Effort", default: false },
      { id: "low", value: "low", label: "Low Effort", default: false },
    ],
  };

  it("marks the model's applied effort as the default level", () => {
    expect(grokReasoningEffortLevelsFromModelMeta(meta)).toEqual([
      { value: "xhigh", label: "Extra High Effort", isDefault: false },
      { value: "high", label: "High Effort", isDefault: false },
      { value: "medium", label: "Medium Effort", isDefault: true },
      { value: "low", label: "Low Effort", isDefault: false },
    ]);
  });

  it("falls back to the first level flagged default when no effort is applied", () => {
    expect(
      grokReasoningEffortLevelsFromModelMeta({ ...meta, reasoningEffort: undefined }).find(
        (level) => level.isDefault,
      )?.value,
    ).toBe("xhigh");
  });

  it("returns no levels for models without reasoning metadata", () => {
    expect(grokReasoningEffortLevelsFromModelMeta(undefined)).toEqual([]);
    expect(grokReasoningEffortLevelsFromModelMeta({ totalContextTokens: 500_000 })).toEqual([]);
  });
});

describe("currentGrokReasoningEffortFromSessionSetup", () => {
  it("reads the effort applied to the session's current model", () => {
    expect(
      currentGrokReasoningEffortFromSessionSetup({
        sessionId: "session-1",
        models: {
          currentModelId: "grok-4.6",
          availableModels: [
            { modelId: "grok-4.5", name: "Grok 4.5", _meta: { reasoningEffort: "high" } },
            { modelId: "grok-4.6", name: "Grok 4.6", _meta: { reasoningEffort: "medium" } },
          ],
        },
      } as never),
    ).toBe("medium");
  });
});

describe("applyGrokAcpModelSelection", () => {
  const makeRecordingRuntime = (failure?: EffectAcpErrors.AcpError) => {
    const modelCalls: Array<{ modelId: string; meta?: Readonly<Record<string, unknown>> }> = [];
    const runtime = {
      setSessionModel: (
        modelId: string,
        options?: { readonly meta?: Readonly<Record<string, unknown>> },
      ) =>
        Effect.gen(function* () {
          modelCalls.push(options?.meta ? { modelId, meta: options.meta } : { modelId });
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
      expect(result).toEqual({ modelId: "grok-mock-alt", reasoningEffort: undefined });
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
      expect(result).toEqual({ modelId: "grok-build", reasoningEffort: undefined });
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
      expect(result).toEqual({ modelId: "grok-build", reasoningEffort: undefined });
    }),
  );

  it.effect("carries the requested reasoning effort in the set_model metadata", () =>
    Effect.gen(function* () {
      const { runtime, modelCalls } = makeRecordingRuntime();
      const result = yield* applyGrokAcpModelSelection({
        runtime,
        currentModelId: "grok-build",
        requestedModelId: "grok-mock-alt",
        currentReasoningEffort: "medium",
        requestedReasoningEffort: "xhigh",
        mapError: (cause) => cause.message,
      });
      expect(modelCalls).toEqual([
        { modelId: "grok-mock-alt", meta: { reasoningEffort: "xhigh" } },
      ]);
      expect(result).toEqual({ modelId: "grok-mock-alt", reasoningEffort: "xhigh" });
    }),
  );

  it.effect("resends the current model when only the reasoning effort changes", () =>
    Effect.gen(function* () {
      const { runtime, modelCalls } = makeRecordingRuntime();
      const result = yield* applyGrokAcpModelSelection({
        runtime,
        currentModelId: "grok-build",
        requestedModelId: "grok-build",
        currentReasoningEffort: "medium",
        requestedReasoningEffort: "low",
        mapError: (cause) => cause.message,
      });
      expect(modelCalls).toEqual([{ modelId: "grok-build", meta: { reasoningEffort: "low" } }]);
      expect(result).toEqual({ modelId: "grok-build", reasoningEffort: "low" });
    }),
  );

  it.effect("keeps the applied effort when a model switch leaves it unchanged", () =>
    Effect.gen(function* () {
      const { runtime, modelCalls } = makeRecordingRuntime();
      const result = yield* applyGrokAcpModelSelection({
        runtime,
        currentModelId: "grok-build",
        requestedModelId: "grok-mock-alt",
        currentReasoningEffort: "high",
        requestedReasoningEffort: "high",
        mapError: (cause) => cause.message,
      });
      expect(modelCalls).toEqual([{ modelId: "grok-mock-alt", meta: { reasoningEffort: "high" } }]);
      expect(result).toEqual({ modelId: "grok-mock-alt", reasoningEffort: "high" });
    }),
  );

  it.effect("does not carry the previous model's effort onto a different model", () =>
    Effect.gen(function* () {
      const { runtime, modelCalls } = makeRecordingRuntime();
      const result = yield* applyGrokAcpModelSelection({
        runtime,
        currentModelId: "grok-mock-4.6",
        requestedModelId: "grok-mock-4.5",
        // `xhigh` exists on 4.6 but not on 4.5; sending it applies a level that
        // model never advertised, so the switch must leave the effort unset.
        currentReasoningEffort: "xhigh",
        requestedReasoningEffort: undefined,
        mapError: (cause) => cause.message,
      });
      expect(modelCalls).toEqual([{ modelId: "grok-mock-4.5" }]);
      expect(result).toEqual({ modelId: "grok-mock-4.5", reasoningEffort: undefined });
    }),
  );

  it.effect("still sends an explicit effort that matches the previous model's effort", () =>
    Effect.gen(function* () {
      const { runtime, modelCalls } = makeRecordingRuntime();
      const result = yield* applyGrokAcpModelSelection({
        runtime,
        currentModelId: "grok-mock-4.6",
        requestedModelId: "grok-mock-4.5",
        currentReasoningEffort: "medium",
        requestedReasoningEffort: "medium",
        mapError: (cause) => cause.message,
      });
      expect(modelCalls).toEqual([
        { modelId: "grok-mock-4.5", meta: { reasoningEffort: "medium" } },
      ]);
      expect(result).toEqual({ modelId: "grok-mock-4.5", reasoningEffort: "medium" });
    }),
  );

  it.effect("skips set_model when neither the model nor the effort changes", () =>
    Effect.gen(function* () {
      const { runtime, modelCalls } = makeRecordingRuntime();
      const result = yield* applyGrokAcpModelSelection({
        runtime,
        currentModelId: "grok-build",
        requestedModelId: "grok-build",
        currentReasoningEffort: "high",
        requestedReasoningEffort: "high",
        mapError: (cause) => cause.message,
      });
      expect(modelCalls).toEqual([]);
      expect(result).toEqual({ modelId: "grok-build", reasoningEffort: "high" });
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
