import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as EffectAcpErrors from "effect-acp/errors";

import {
  applyGrokAcpModelSelection,
  buildGrokAcpSpawnInput,
  GROK_REASONING_EFFORT_OPTION_ID,
  grokReasoningEffortCapabilities,
  isGrokAcpAuthFailure,
  parseGrokAcpModelMeta,
  requestedGrokReasoningEffort,
  resolveGrokAcpBaseModelId,
} from "./GrokAcpSupport.ts";
import { ProviderInstanceId } from "@t3tools/contracts";

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

  it("puts --reasoning-effort before stdio", () => {
    const spawn = buildGrokAcpSpawnInput({ binaryPath: "grok" }, "/tmp/project", undefined, "high");
    expect(spawn.args).toEqual(["agent", "--reasoning-effort", "high", "stdio"]);
  });

  it("ignores spawn effort values the CLI rejects", () => {
    const spawn = buildGrokAcpSpawnInput({ binaryPath: "grok" }, "/tmp/project", undefined, "max");
    expect(spawn.args).toEqual(["agent", "stdio"]);
  });
});

describe("parseGrokAcpModelMeta", () => {
  it("reads the live Grok effort menu", () => {
    const meta = parseGrokAcpModelMeta({
      supportsReasoningEffort: true,
      reasoningEffort: "high",
      totalContextTokens: 500000,
      reasoningEfforts: [
        { id: "xhigh", value: "xhigh", label: "Extra High Effort" },
        { id: "high", value: "high", label: "High Effort", default: true },
        { id: "medium", value: "medium", label: "Medium Effort" },
      ],
    });
    expect(meta.supportsReasoningEffort).toBe(true);
    expect(meta.reasoningEffort).toBe("high");
    expect(meta.totalContextTokens).toBe(500000);
    expect(meta.reasoningEfforts.map((choice) => choice.id)).toEqual(["xhigh", "high", "medium"]);
    expect(grokReasoningEffortCapabilities(meta.reasoningEfforts).optionDescriptors[0]?.id).toBe(
      GROK_REASONING_EFFORT_OPTION_ID,
    );
  });
});

describe("requestedGrokReasoningEffort", () => {
  it("drops effort values the current model does not advertise", () => {
    expect(
      requestedGrokReasoningEffort(
        {
          instanceId: ProviderInstanceId.make("grok"),
          model: "grok-4.5",
          options: [{ id: GROK_REASONING_EFFORT_OPTION_ID, value: "xhigh" }],
        },
        ["high", "medium", "low"],
      ),
    ).toBeUndefined();
  });
});

describe("isGrokAcpAuthFailure", () => {
  it("recognizes authenticate failures", () => {
    expect(isGrokAcpAuthFailure(new Error("authenticate failed: cached_token"))).toBe(true);
    expect(isGrokAcpAuthFailure(new Error("session/new timed out"))).toBe(false);
  });
});

describe("applyGrokAcpModelSelection", () => {
  const makeRecordingRuntime = (failure?: EffectAcpErrors.AcpError) => {
    const modelCalls: Array<{ modelId: string; effort?: string }> = [];
    const runtime = {
      setSessionModel: (
        modelId: string,
        options?: { readonly _meta?: { readonly [x: string]: unknown } },
      ) =>
        Effect.gen(function* () {
          const effort = options?._meta?.reasoningEffort;
          modelCalls.push({
            modelId,
            ...(typeof effort === "string" ? { effort } : {}),
          });
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

  it.effect("calls session/set_model when only effort changes", () =>
    Effect.gen(function* () {
      const { runtime, modelCalls } = makeRecordingRuntime();
      const result = yield* applyGrokAcpModelSelection({
        runtime,
        currentModelId: "grok-4.6",
        requestedModelId: "grok-4.6",
        currentReasoningEffort: "high",
        requestedReasoningEffort: "xhigh",
        mapError: (cause) => cause.message,
      });
      expect(modelCalls).toEqual([{ modelId: "grok-4.6", effort: "xhigh" }]);
      expect(result).toEqual({ modelId: "grok-4.6", reasoningEffort: "xhigh" });
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
