import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as EffectAcpErrors from "effect-acp/errors";

import {
  applyOmpAcpModelSelection,
  buildOmpAcpSpawnInput,
  isValidOmpReasoningEffortToken,
  normalizeOmpReasoningEffort,
  resolveOmpAcpBaseModelId,
} from "./OmpAcpSupport.ts";

describe("resolveOmpAcpBaseModelId", () => {
  it("treats blank input as no request instead of an empty model id", () => {
    expect(resolveOmpAcpBaseModelId(undefined)).toBeUndefined();
    expect(resolveOmpAcpBaseModelId(null)).toBeUndefined();
    expect(resolveOmpAcpBaseModelId("   ")).toBeUndefined();
  });

  it("keeps OMP's provider-prefixed ids intact", () => {
    expect(resolveOmpAcpBaseModelId("  anthropic/claude-sonnet-5  ")).toBe(
      "anthropic/claude-sonnet-5",
    );
    expect(resolveOmpAcpBaseModelId("zai-coding/glm-5.3")).toBe("zai-coding/glm-5.3");
  });
});

describe("buildOmpAcpSpawnInput", () => {
  it("serves the ACP agent over stdio and falls back to the `omp` binary", () => {
    expect(buildOmpAcpSpawnInput(null, "/tmp/project", { PATH: "/usr/bin" })).toEqual({
      command: "omp",
      args: ["acp"],
      cwd: "/tmp/project",
      env: { PATH: "/usr/bin" },
    });
  });

  it("uses the configured binary path", () => {
    expect(buildOmpAcpSpawnInput({ binaryPath: "/opt/omp" }, "/tmp/project").command).toBe(
      "/opt/omp",
    );
  });
});

describe("normalizeOmpReasoningEffort", () => {
  it("accepts ACP effort tokens and drops malformed metadata values", () => {
    expect(isValidOmpReasoningEffortToken("max")).toBe(true);
    expect(isValidOmpReasoningEffortToken("not a token")).toBe(false);
    expect(normalizeOmpReasoningEffort("  high  ")).toBe("high");
    expect(normalizeOmpReasoningEffort("not a token")).toBeUndefined();
    expect(normalizeOmpReasoningEffort(undefined)).toBeUndefined();
  });
});

describe("applyOmpAcpModelSelection", () => {
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
      const result = yield* applyOmpAcpModelSelection({
        runtime,
        currentModelId: "anthropic/claude-sonnet-5",
        requestedModelId: "zai-coding/glm-5.3",
        mapError: (cause) => cause.message,
      });
      expect(modelCalls).toEqual([{ modelId: "zai-coding/glm-5.3" }]);
      expect(result).toBe("zai-coding/glm-5.3");
    }),
  );

  it.effect("keeps the agent's own model when nothing was requested", () =>
    Effect.gen(function* () {
      const { runtime, modelCalls } = makeRecordingRuntime();
      const result = yield* applyOmpAcpModelSelection({
        runtime,
        currentModelId: "anthropic/claude-sonnet-5",
        requestedModelId: resolveOmpAcpBaseModelId("   "),
        mapError: (cause) => cause.message,
      });
      expect(modelCalls).toEqual([]);
      expect(result).toBe("anthropic/claude-sonnet-5");
    }),
  );

  it.effect("applies reasoning effort through session/set_model metadata", () =>
    Effect.gen(function* () {
      const { runtime, modelCalls } = makeRecordingRuntime();
      yield* applyOmpAcpModelSelection({
        runtime,
        currentModelId: "anthropic/claude-opus-5",
        currentReasoningEffort: "high",
        requestedModelId: "anthropic/claude-opus-5",
        requestedReasoningEffort: "max",
        mapError: (cause) => cause.message,
      });
      expect(modelCalls).toEqual([
        { modelId: "anthropic/claude-opus-5", meta: { reasoningEffort: "max" } },
      ]);
    }),
  );

  it.effect("drops malformed effort metadata instead of sending it", () =>
    Effect.gen(function* () {
      const { runtime, modelCalls } = makeRecordingRuntime();
      yield* applyOmpAcpModelSelection({
        runtime,
        currentModelId: "anthropic/claude-opus-5",
        currentReasoningEffort: "high",
        requestedModelId: "anthropic/claude-opus-5",
        requestedReasoningEffort: "not a token",
        mapError: (cause) => cause.message,
      });
      expect(modelCalls).toEqual([{ modelId: "anthropic/claude-opus-5" }]);
    }),
  );

  it.effect("does not clear reasoning when same-model selection omits effort", () =>
    Effect.gen(function* () {
      const { runtime, modelCalls } = makeRecordingRuntime();
      yield* applyOmpAcpModelSelection({
        runtime,
        currentModelId: "anthropic/claude-opus-5",
        currentReasoningEffort: "high",
        requestedModelId: "anthropic/claude-opus-5",
        requestedReasoningEffort: undefined,
        mapError: (cause) => cause.message,
      });
      expect(modelCalls).toEqual([]);
    }),
  );

  it.effect("propagates session/set_model failures via mapError", () =>
    Effect.gen(function* () {
      const failure = EffectAcpErrors.AcpRequestError.invalidParams("session id not known");
      const { runtime } = makeRecordingRuntime(failure);
      const error = yield* Effect.flip(
        applyOmpAcpModelSelection({
          runtime,
          currentModelId: "anthropic/claude-sonnet-5",
          requestedModelId: "zai-coding/glm-5.3",
          mapError: (cause) => cause.message,
        }),
      );
      expect(error).toBe(failure.message);
    }),
  );
});
