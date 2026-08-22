import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as EffectAcpErrors from "effect-acp/errors";

import {
  applyFxAcpModelSelection,
  buildFxAcpSpawnInput,
  resolveFxAcpBaseModelId,
} from "./FxAcpSupport.ts";

describe("resolveFxAcpBaseModelId", () => {
  it("preserves raw fx catalog ids and defaults empty ids", () => {
    expect(resolveFxAcpBaseModelId(undefined)).toBe("default");
    expect(resolveFxAcpBaseModelId("   ")).toBe("default");
    expect(resolveFxAcpBaseModelId("  fx-test-custom-model  ")).toBe("fx-test-custom-model");
  });
});

describe("buildFxAcpSpawnInput", () => {
  it("launches fx acp with the configured environment", () => {
    const spawn = buildFxAcpSpawnInput({ binaryPath: "/usr/local/bin/fx" }, "/tmp/project", {
      XAI_API_KEY: "secret",
      FX_HOME: "/tmp/fx-home",
    });

    expect(spawn).toEqual({
      command: "/usr/local/bin/fx",
      args: ["acp"],
      cwd: "/tmp/project",
      env: {
        XAI_API_KEY: "secret",
        FX_HOME: "/tmp/fx-home",
      },
    });
  });
});

describe("applyFxAcpModelSelection", () => {
  const makeRecordingRuntime = (failure?: EffectAcpErrors.AcpError) => {
    const modelCalls: Array<string> = [];
    const runtime = {
      setModel: (modelId: string) =>
        Effect.gen(function* () {
          modelCalls.push(modelId);
          if (failure) return yield* failure;
          return {};
        }),
    };
    return { runtime, modelCalls };
  };

  it.effect("updates the standard model config when the requested model differs", () =>
    Effect.gen(function* () {
      const { runtime, modelCalls } = makeRecordingRuntime();
      const result = yield* applyFxAcpModelSelection({
        runtime,
        currentModelId: "default",
        requestedModelId: "fx-mock-alt",
        mapError: (cause) => cause.message,
      });
      expect(modelCalls).toEqual(["fx-mock-alt"]);
      expect(result).toBe("fx-mock-alt");
    }),
  );

  it.effect("skips the model update when requested matches current", () =>
    Effect.gen(function* () {
      const { runtime, modelCalls } = makeRecordingRuntime();
      const result = yield* applyFxAcpModelSelection({
        runtime,
        currentModelId: "default",
        requestedModelId: "default",
        mapError: (cause) => cause.message,
      });
      expect(modelCalls).toEqual([]);
      expect(result).toBe("default");
    }),
  );

  it.effect("switches back to the default catalog model", () =>
    Effect.gen(function* () {
      const { runtime, modelCalls } = makeRecordingRuntime();
      const result = yield* applyFxAcpModelSelection({
        runtime,
        currentModelId: "provider-active-model",
        requestedModelId: "default",
        mapError: (cause) => cause.message,
      });
      expect(modelCalls).toEqual(["default"]);
      expect(result).toBe("default");
    }),
  );

  it.effect("skips the model update when no model is requested", () =>
    Effect.gen(function* () {
      const { runtime, modelCalls } = makeRecordingRuntime();
      const result = yield* applyFxAcpModelSelection({
        runtime,
        currentModelId: "default",
        requestedModelId: undefined,
        mapError: (cause) => cause.message,
      });
      expect(modelCalls).toEqual([]);
      expect(result).toBe("default");
    }),
  );

  it.effect("propagates model config failures via mapError", () =>
    Effect.gen(function* () {
      const failure = EffectAcpErrors.AcpRequestError.invalidParams("session id not known");
      const { runtime } = makeRecordingRuntime(failure);
      const error = yield* Effect.flip(
        applyFxAcpModelSelection({
          runtime,
          currentModelId: "default",
          requestedModelId: "fx-mock-alt",
          mapError: (cause) => cause.message,
        }),
      );
      expect(error).toBe(failure.message);
    }),
  );
});
