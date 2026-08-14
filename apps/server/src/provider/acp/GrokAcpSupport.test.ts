import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as EffectAcpErrors from "effect-acp/errors";

import {
  applyGrokAcpModelSelection,
  buildGrokAcpSpawnInput,
  buildGrokTokenUsageSnapshot,
  grokContextWindowFromAvailableModels,
  normalizeGrokReasoningEffortToken,
  parseGrokAcpMetaTokenUsage,
  parseGrokAcpUsageUpdate,
  parseGrokPromptResponseUsage,
  parseGrokReasoningEffortMenu,
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

describe("normalizeGrokReasoningEffortToken", () => {
  it("accepts compact ACP effort tokens and rejects invalid ones", () => {
    expect(normalizeGrokReasoningEffortToken(" high ")).toBe("high");
    expect(normalizeGrokReasoningEffortToken("xhigh")).toBe("xhigh");
    expect(normalizeGrokReasoningEffortToken("extra-high")).toBe("extra-high");
    expect(normalizeGrokReasoningEffortToken("")).toBeUndefined();
    expect(normalizeGrokReasoningEffortToken("has space")).toBeUndefined();
    expect(normalizeGrokReasoningEffortToken("a".repeat(33))).toBeUndefined();
  });
});

describe("parseGrokReasoningEffortMenu", () => {
  it("parses id/value tokens, current effort, and default flags", () => {
    expect(
      parseGrokReasoningEffortMenu({
        reasoningEffort: "high",
        reasoningEfforts: [
          { value: "low", label: "Low" },
          { id: "high", label: "High", description: "Think more", isDefault: true },
          { id: "bad token", label: "Nope" },
        ],
      }),
    ).toEqual({
      currentValue: "high",
      options: [
        { id: "low", label: "Low" },
        { id: "high", label: "High", description: "Think more", isDefault: true },
      ],
    });
  });

  it("skips the menu when reasoning is unsupported or tokens are invalid", () => {
    expect(
      parseGrokReasoningEffortMenu({
        supportsReasoningEffort: false,
        reasoningEfforts: [{ id: "low", label: "Low" }],
      }),
    ).toBeUndefined();
    expect(parseGrokReasoningEffortMenu({ reasoningEfforts: [{ id: "???" }] })).toBeUndefined();
    expect(parseGrokReasoningEffortMenu({})).toBeUndefined();
  });
});

describe("Grok token usage parsers", () => {
  it("reads usage_update, notification _meta, and prompt _meta", () => {
    expect(parseGrokAcpUsageUpdate({ used: 1234, size: 256000 })).toEqual({
      usedTokens: 1234,
      maxTokens: 256000,
    });
    expect(
      parseGrokAcpMetaTokenUsage({
        totalTokens: 80,
        contextWindow: 128000,
      }),
    ).toEqual({ usedTokens: 80, maxTokens: 128000 });
    expect(
      parseGrokPromptResponseUsage({
        _meta: { usage: { totalTokens: 42, size: 64000 } },
      }),
    ).toEqual({ usedTokens: 42, maxTokens: 64000 });
  });

  it("builds a Grok usage snapshot with automatic compaction", () => {
    expect(buildGrokTokenUsageSnapshot({ usedTokens: 10, maxTokens: 100 })).toEqual({
      usedTokens: 10,
      maxTokens: 100,
      compactsAutomatically: true,
    });
    expect(
      grokContextWindowFromAvailableModels(
        [
          { modelId: "grok-build", name: "Grok Build", _meta: { totalContextTokens: 256000 } },
          { modelId: "grok-mock-alt", name: "Alt", _meta: { totalContextTokens: 128000 } },
        ],
        "grok-mock-alt",
      ),
    ).toBe(128000);
  });
});

describe("applyGrokAcpModelSelection", () => {
  const makeRecordingRuntime = (failure?: EffectAcpErrors.AcpError) => {
    const modelCalls: Array<{
      readonly modelId: string;
      readonly meta?: { readonly [x: string]: unknown } | null;
    }> = [];
    const runtime = {
      setSessionModel: (modelId: string, meta?: { readonly [x: string]: unknown } | null) =>
        Effect.gen(function* () {
          modelCalls.push({ modelId, ...(meta !== undefined ? { meta } : {}) });
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

  it.effect("calls set_model with reasoningEffort _meta for same-model effort changes", () =>
    Effect.gen(function* () {
      const { runtime, modelCalls } = makeRecordingRuntime();
      const result = yield* applyGrokAcpModelSelection({
        runtime,
        currentModelId: "grok-build",
        requestedModelId: "grok-build",
        currentReasoningEffort: "low",
        requestedReasoningEffort: "high",
        mapError: (cause) => cause.message,
      });
      expect(modelCalls).toEqual([{ modelId: "grok-build", meta: { reasoningEffort: "high" } }]);
      expect(result).toEqual({ modelId: "grok-build", reasoningEffort: "high" });
    }),
  );

  it.effect("omits _meta when clearing effort on the same model", () =>
    Effect.gen(function* () {
      const { runtime, modelCalls } = makeRecordingRuntime();
      const result = yield* applyGrokAcpModelSelection({
        runtime,
        currentModelId: "grok-build",
        requestedModelId: "grok-build",
        currentReasoningEffort: "high",
        requestedReasoningEffort: undefined,
        mapError: (cause) => cause.message,
      });
      expect(modelCalls).toEqual([{ modelId: "grok-build" }]);
      expect(result).toEqual({ modelId: "grok-build", reasoningEffort: undefined });
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
