import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as EffectAcpErrors from "effect-acp/errors";

import {
  applyGrokAcpModelSelection,
  buildGrokAcpSpawnInput,
  decodeGrokAcpModelReasoningCapabilities,
  findGrokAcpReasoningConfigOption,
  resolveGrokAcpInteractionModeId,
  resolveGrokAcpModeIds,
  resolveGrokAcpReasoningValue,
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

describe("Grok ACP negotiated capabilities", () => {
  const modeState = {
    currentModeId: "code",
    availableModes: [
      { id: "architect", name: "Architect" },
      { id: "code", name: "Code" },
    ],
  } as const;
  const reasoningOption = {
    id: "native-thought-level",
    name: "Reasoning",
    category: "thought_level",
    type: "select" as const,
    currentValue: "balanced",
    options: [
      { value: "quick", name: "Quick" },
      { value: "balanced", name: "Balanced" },
      { value: "deep-native", name: "Deep Native" },
    ],
  };

  it("resolves the advertised plan/default pair without inventing values", () => {
    expect(resolveGrokAcpModeIds(modeState)).toEqual({
      planModeId: "architect",
      defaultModeId: "code",
    });
    expect(resolveGrokAcpInteractionModeId(modeState, "plan")).toBe("architect");
    expect(resolveGrokAcpInteractionModeId(modeState, "default")).toBe("code");
    expect(
      resolveGrokAcpModeIds({
        currentModeId: "chat",
        availableModes: [{ id: "chat", name: "Chat" }],
      }),
    ).toBeUndefined();
  });

  it("resolves the exact native reasoning config id and value", () => {
    expect(findGrokAcpReasoningConfigOption([reasoningOption])).toBe(reasoningOption);
    expect(resolveGrokAcpReasoningValue(reasoningOption, "deep-native")).toBe("deep-native");
    expect(resolveGrokAcpReasoningValue(reasoningOption, "Deep Native")).toBe("deep-native");
    expect(resolveGrokAcpReasoningValue(reasoningOption, "unknown")).toBeUndefined();
  });

  it("decodes the verified Grok model reasoning metadata shape", () => {
    expect(
      decodeGrokAcpModelReasoningCapabilities({
        modelId: "grok-4.5",
        name: "Grok 4.5",
        _meta: {
          supportsReasoningEffort: true,
          reasoningEffort: "high",
          reasoningEfforts: [
            { value: "high", label: "High Effort", default: true },
            { value: "medium", label: "Medium Effort", default: false },
          ],
        },
      }),
    ).toEqual({
      currentValue: "high",
      options: [
        { value: "high", label: "High Effort", isDefault: true },
        { value: "medium", label: "Medium Effort" },
      ],
    });
    expect(
      decodeGrokAcpModelReasoningCapabilities({
        modelId: "grok-legacy",
        name: "Legacy Grok",
        _meta: { supportsReasoningEffort: false },
      }),
    ).toBeUndefined();
  });
});
