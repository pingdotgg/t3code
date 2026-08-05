import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as EffectAcpErrors from "effect-acp/errors";

import {
  applyGrokAcpModelSelection,
  buildGrokAcpSpawnInput,
  contextWindowForModelId,
  contextWindowsFromSessionModels,
  enrichGrokTokenUsage,
  resolveGrokAcpBaseModelId,
  resolveInitialGrokContextWindow,
  tokenUsageFromGrokPromptMeta,
  totalContextTokensFromModelMeta,
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

describe("Grok context window helpers", () => {
  it("reads totalContextTokens from model meta and session model state", () => {
    expect(totalContextTokensFromModelMeta({ totalContextTokens: 500_000 })).toBe(500_000);
    expect(totalContextTokensFromModelMeta({ totalContextTokens: 0 })).toBeUndefined();
    expect(totalContextTokensFromModelMeta(null)).toBeUndefined();

    const windows = contextWindowsFromSessionModels({
      currentModelId: "model-a",
      availableModels: [
        {
          modelId: "model-a",
          name: "Model A",
          _meta: { totalContextTokens: 500_000 },
        },
        {
          modelId: "model-b",
          name: "Model B",
          _meta: { totalContextTokens: 128_000 },
        },
        {
          modelId: "model-c",
          name: "Model C",
        },
      ],
    });

    expect(contextWindowForModelId(windows, "model-a")).toBe(500_000);
    expect(contextWindowForModelId(windows, "model-b")).toBe(128_000);
    expect(contextWindowForModelId(windows, "model-c")).toBeUndefined();
  });

  it("maps prompt _meta usage into a ThreadTokenUsageSnapshot with model window", () => {
    expect(
      tokenUsageFromGrokPromptMeta(
        {
          totalTokens: 19_267,
          inputTokens: 19_237,
          outputTokens: 29,
          cachedReadTokens: 2_560,
          reasoningTokens: 18,
          usage: {
            inputTokens: 19_237,
            outputTokens: 29,
            totalTokens: 19_266,
            cachedReadTokens: 2_560,
            reasoningTokens: 18,
          },
        },
        500_000,
      ),
    ).toEqual({
      usedTokens: 19_267,
      maxTokens: 500_000,
      inputTokens: 19_237,
      lastInputTokens: 19_237,
      outputTokens: 29,
      lastOutputTokens: 29,
      cachedInputTokens: 2_560,
      lastCachedInputTokens: 2_560,
      reasoningOutputTokens: 18,
      lastReasoningOutputTokens: 18,
      lastUsedTokens: 19_267,
      compactsAutomatically: true,
    });

    expect(tokenUsageFromGrokPromptMeta({}, 500_000)).toBeUndefined();
    expect(enrichGrokTokenUsage({ usedTokens: 100 }, 200_000)).toEqual({
      usedTokens: 100,
      maxTokens: 200_000,
      compactsAutomatically: true,
    });
    // Always stamps max + auto-compact so the meter can show used/max.
    expect(enrichGrokTokenUsage({ usedTokens: 16_000 }, undefined)).toEqual({
      usedTokens: 16_000,
      compactsAutomatically: true,
    });
  });

  it("resolves an initial window even when the bound model id is missing", () => {
    const windows = contextWindowsFromSessionModels({
      currentModelId: "grok-4.5",
      availableModels: [
        {
          modelId: "grok-4.5",
          name: "Grok 4.5",
          _meta: { totalContextTokens: 500_000 },
        },
        {
          modelId: "gpt-5.6-luna",
          name: "Luna",
          _meta: { totalContextTokens: 200_000 },
        },
      ],
    });

    expect(
      resolveInitialGrokContextWindow({
        windows,
        boundModelId: undefined,
        setupModelId: "grok-4.5",
      }),
    ).toBe(500_000);

    expect(
      resolveInitialGrokContextWindow({
        windows,
        boundModelId: "missing-model",
        setupModelId: "also-missing",
      }),
    ).toBe(500_000);
  });
});
