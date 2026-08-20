import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import {
  advertisedKimiModelIdsFromSessionSetup,
  applyKimiAcpModelSelection,
  buildKimiAcpSpawnInput,
  currentKimiModelIdFromSessionSetup,
  findKimiModelConfigOption,
  isKimiAuthRequiredError,
  kimiModelStateFromSessionSetup,
  kimiSessionHasModelConfigOption,
  resolveKimiAcpBaseModelId,
  resolveKimiAcpWireModelId,
} from "./KimiAcpSupport.ts";

const configOptionSession = {
  sessionId: "session-1",
  configOptions: [
    {
      id: "chosen-model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: "kimi-code/k3",
      options: [
        { value: "kimi-code/k3", name: "K3" },
        { value: "kimi-code/kimi-for-coding", name: "K2.7 Coding" },
        { value: "moonshot-ai/kimi-k3", name: "kimi-k3" },
      ],
    },
  ],
} satisfies EffectAcpSchema.NewSessionResponse;

describe("resolveKimiAcpBaseModelId", () => {
  it("normalizes empty and custom Kimi model ids", () => {
    expect(resolveKimiAcpBaseModelId(undefined)).toBe("k3");
    expect(resolveKimiAcpBaseModelId("   ")).toBe("k3");
    expect(resolveKimiAcpBaseModelId("  kimi-for-coding  ")).toBe("kimi-for-coding");
  });

  it("strips the ,thinking variant suffix to the base model id", () => {
    expect(resolveKimiAcpBaseModelId("k3,thinking")).toBe("k3");
    expect(resolveKimiAcpBaseModelId("kimi-for-coding , thinking")).toBe("kimi-for-coding");
  });

  it("strips the kimi-code/ namespace prefix used by config.toml aliases", () => {
    expect(resolveKimiAcpBaseModelId("kimi-code/k3")).toBe("k3");
    expect(resolveKimiAcpBaseModelId("kimi-code/k3,thinking")).toBe("k3");
    expect(resolveKimiAcpBaseModelId("moonshot-ai/kimi-k3")).toBe("moonshot-ai/kimi-k3");
  });
});

describe("kimiModelStateFromSessionSetup", () => {
  it("discovers exact model wire ids from a category-based select option", () => {
    const modelConfig = findKimiModelConfigOption(configOptionSession.configOptions);
    const modelState = kimiModelStateFromSessionSetup(configOptionSession);

    expect(modelConfig?.id).toBe("chosen-model");
    expect(modelState).toEqual({
      currentModelId: "kimi-code/k3",
      availableModels: [
        { modelId: "kimi-code/k3", name: "K3" },
        { modelId: "kimi-code/kimi-for-coding", name: "K2.7 Coding" },
        { modelId: "moonshot-ai/kimi-k3", name: "kimi-k3" },
      ],
    });
    expect(advertisedKimiModelIdsFromSessionSetup(configOptionSession)).toEqual([
      "kimi-code/k3",
      "kimi-code/kimi-for-coding",
      "moonshot-ai/kimi-k3",
    ]);
    expect(currentKimiModelIdFromSessionSetup(configOptionSession)).toBe("kimi-code/k3");
    expect(kimiSessionHasModelConfigOption(configOptionSession)).toBe(true);
  });

  it("falls back to the legacy model state when no model config option is advertised", () => {
    const legacySession = {
      sessionId: "legacy-session",
      models: {
        currentModelId: "k3",
        availableModels: [
          { modelId: "k3", name: "K3" },
          { modelId: "kimi-for-coding", name: "K2.7 Coding" },
        ],
      },
    } satisfies EffectAcpSchema.NewSessionResponse;

    expect(kimiModelStateFromSessionSetup(legacySession)).toEqual(legacySession.models);
    expect(advertisedKimiModelIdsFromSessionSetup(legacySession)).toEqual([
      "k3",
      "kimi-for-coding",
    ]);
    expect(kimiSessionHasModelConfigOption(legacySession)).toBe(false);
  });
});

describe("resolveKimiAcpWireModelId", () => {
  it("namespaces managed ids when nothing was advertised (Kimi Code CLI)", () => {
    expect(resolveKimiAcpWireModelId("k3")).toBe("kimi-code/k3");
    expect(resolveKimiAcpWireModelId("kimi-for-coding")).toBe("kimi-code/kimi-for-coding");
    expect(resolveKimiAcpWireModelId("moonshot-ai/kimi-k3")).toBe("moonshot-ai/kimi-k3");
    expect(resolveKimiAcpWireModelId("k3", [])).toBe("kimi-code/k3");
  });

  it("prefers a matching advertised id (kimi-cli advertises bare ids)", () => {
    expect(resolveKimiAcpWireModelId("k3", ["k3", "k3,thinking", "kimi-for-coding"])).toBe("k3");
    expect(resolveKimiAcpWireModelId("k3", ["k3,thinking", "k3"])).toBe("k3");
    expect(resolveKimiAcpWireModelId("k3", ["k3,thinking"])).toBe("k3,thinking");
    expect(resolveKimiAcpWireModelId("k3", ["kimi-code/k3", "kimi-code/kimi-for-coding"])).toBe(
      "kimi-code/k3",
    );
  });

  it("passes an unadvertised custom id through untouched", () => {
    expect(resolveKimiAcpWireModelId("my-custom-model", ["k3", "kimi-for-coding"])).toBe(
      "my-custom-model",
    );
  });
});

describe("buildKimiAcpSpawnInput", () => {
  it("spawns `kimi acp` with the configured binary", () => {
    const spawn = buildKimiAcpSpawnInput(
      { binaryPath: "/usr/local/bin/kimi", homePath: "" },
      "/tmp/project",
    );

    expect(spawn).toEqual({
      command: "/usr/local/bin/kimi",
      args: ["acp"],
      cwd: "/tmp/project",
    });
  });

  it("injects KIMI_CODE_HOME when a homePath is configured", () => {
    const spawn = buildKimiAcpSpawnInput(
      { binaryPath: "kimi", homePath: "/data/kimi-work" },
      "/tmp/project",
      { PATH: "/bin" },
    );

    expect(spawn).toEqual({
      command: "kimi",
      args: ["acp"],
      cwd: "/tmp/project",
      env: {
        PATH: "/bin",
        KIMI_CODE_HOME: "/data/kimi-work",
      },
    });
  });
});

describe("isKimiAuthRequiredError", () => {
  it("matches the RFC auth-required error code", () => {
    expect(isKimiAuthRequiredError(EffectAcpErrors.AcpRequestError.authRequired())).toBe(true);
  });

  it("matches failures from the authenticate request", () => {
    expect(
      isKimiAuthRequiredError(
        new EffectAcpErrors.AcpRequestError({
          code: -32603,
          errorMessage: "token missing",
          method: "authenticate",
        }),
      ),
    ).toBe(true);
  });

  it("rejects unrelated errors", () => {
    expect(
      isKimiAuthRequiredError(EffectAcpErrors.AcpRequestError.invalidParams("bad params")),
    ).toBe(false);
    expect(isKimiAuthRequiredError(new Error("nope"))).toBe(false);
  });
});

describe("applyKimiAcpModelSelection", () => {
  const makeRecordingRuntime = (stableFailure?: EffectAcpErrors.AcpError) => {
    const stableModelCalls: Array<string> = [];
    const fallbackModelCalls: Array<string> = [];
    const runtime = {
      setModel: (modelId: string) =>
        Effect.gen(function* () {
          stableModelCalls.push(modelId);
          if (stableFailure) return yield* stableFailure;
        }),
      setSessionModel: (modelId: string) =>
        Effect.sync(() => {
          fallbackModelCalls.push(modelId);
          return {};
        }),
    };
    return { runtime, stableModelCalls, fallbackModelCalls };
  };

  it.effect("uses setModel and the exact advertised wire id for model config sessions", () =>
    Effect.gen(function* () {
      const { runtime, stableModelCalls, fallbackModelCalls } = makeRecordingRuntime();
      const result = yield* applyKimiAcpModelSelection({
        runtime,
        currentModelId: "kimi-code/k3",
        requestedModelId: "kimi-for-coding",
        advertisedModelIds: ["kimi-code/k3", "kimi-code/kimi-for-coding"],
        hasModelConfigOption: true,
        mapError: (cause) => cause.message,
      });
      expect(stableModelCalls).toEqual(["kimi-code/kimi-for-coding"]);
      expect(fallbackModelCalls).toEqual([]);
      expect(result).toBe("kimi-for-coding");
    }),
  );

  it.effect("switches K3 to K2.7 and back through stable model configuration", () =>
    Effect.gen(function* () {
      const { runtime, stableModelCalls } = makeRecordingRuntime();
      const advertisedModelIds = ["kimi-code/k3", "kimi-code/kimi-for-coding"];
      const k27 = yield* applyKimiAcpModelSelection({
        runtime,
        currentModelId: "kimi-code/k3",
        requestedModelId: "kimi-for-coding",
        advertisedModelIds,
        hasModelConfigOption: true,
        mapError: (cause) => cause.message,
      });
      const k3 = yield* applyKimiAcpModelSelection({
        runtime,
        currentModelId: k27,
        requestedModelId: "k3",
        advertisedModelIds,
        hasModelConfigOption: true,
        mapError: (cause) => cause.message,
      });
      expect(stableModelCalls).toEqual(["kimi-code/kimi-for-coding", "kimi-code/k3"]);
      expect(k3).toBe("k3");
    }),
  );

  it.effect("falls back to session/set_model when stable model configuration is unsupported", () =>
    Effect.gen(function* () {
      const unsupported = EffectAcpErrors.AcpRequestError.methodNotFound(
        "session/set_config_option",
      );
      const { runtime, stableModelCalls, fallbackModelCalls } = makeRecordingRuntime(unsupported);
      const result = yield* applyKimiAcpModelSelection({
        runtime,
        currentModelId: "kimi-code/k3",
        requestedModelId: "kimi-for-coding",
        advertisedModelIds: ["kimi-code/k3", "kimi-code/kimi-for-coding"],
        hasModelConfigOption: true,
        mapError: (cause) => cause.message,
      });
      expect(stableModelCalls).toEqual(["kimi-code/kimi-for-coding"]);
      expect(fallbackModelCalls).toEqual(["kimi-code/kimi-for-coding"]);
      expect(result).toBe("kimi-for-coding");
    }),
  );

  it.effect("falls back to session/set_model for legacy model-state sessions", () =>
    Effect.gen(function* () {
      const { runtime, stableModelCalls, fallbackModelCalls } = makeRecordingRuntime();
      const result = yield* applyKimiAcpModelSelection({
        runtime,
        currentModelId: "k3",
        requestedModelId: "kimi-for-coding",
        advertisedModelIds: ["k3", "k3,thinking", "kimi-for-coding"],
        hasModelConfigOption: false,
        mapError: (cause) => cause.message,
      });
      expect(stableModelCalls).toEqual([]);
      expect(fallbackModelCalls).toEqual(["kimi-for-coding"]);
      expect(result).toBe("kimi-for-coding");
    }),
  );

  it.effect("skips model RPCs when requested matches current", () =>
    Effect.gen(function* () {
      const { runtime, stableModelCalls, fallbackModelCalls } = makeRecordingRuntime();
      const result = yield* applyKimiAcpModelSelection({
        runtime,
        currentModelId: "k3",
        requestedModelId: "k3",
        hasModelConfigOption: true,
        mapError: (cause) => cause.message,
      });
      expect(stableModelCalls).toEqual([]);
      expect(fallbackModelCalls).toEqual([]);
      expect(result).toBe("k3");
    }),
  );

  it.effect("treats a thinking-variant current model as its base id", () =>
    Effect.gen(function* () {
      const { runtime, stableModelCalls, fallbackModelCalls } = makeRecordingRuntime();
      const result = yield* applyKimiAcpModelSelection({
        runtime,
        currentModelId: "k3,thinking",
        requestedModelId: "k3",
        hasModelConfigOption: false,
        mapError: (cause) => cause.message,
      });
      expect(stableModelCalls).toEqual([]);
      expect(fallbackModelCalls).toEqual([]);
      expect(result).toBe("k3,thinking");
    }),
  );

  it.effect("skips model RPCs when no model is requested", () =>
    Effect.gen(function* () {
      const { runtime, stableModelCalls, fallbackModelCalls } = makeRecordingRuntime();
      const result = yield* applyKimiAcpModelSelection({
        runtime,
        currentModelId: "k3",
        requestedModelId: undefined,
        hasModelConfigOption: true,
        mapError: (cause) => cause.message,
      });
      expect(stableModelCalls).toEqual([]);
      expect(fallbackModelCalls).toEqual([]);
      expect(result).toBe("k3");
    }),
  );

  it.effect("does not report a new current model when setModel fails", () =>
    Effect.gen(function* () {
      const failure = EffectAcpErrors.AcpRequestError.invalidParams("model is unavailable");
      const { runtime, fallbackModelCalls } = makeRecordingRuntime(failure);
      const error = yield* Effect.flip(
        applyKimiAcpModelSelection({
          runtime,
          currentModelId: "k3",
          requestedModelId: "kimi-for-coding",
          hasModelConfigOption: true,
          mapError: (cause) => cause.message,
        }),
      );
      expect(error).toBe(failure.message);
      expect(fallbackModelCalls).toEqual([]);
    }),
  );
});
