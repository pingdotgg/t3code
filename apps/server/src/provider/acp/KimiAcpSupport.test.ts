import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as EffectAcpErrors from "effect-acp/errors";

import {
  applyKimiAcpModelSelection,
  buildKimiAcpSpawnInput,
  resolveKimiAcpBaseModelId,
} from "./KimiAcpSupport.ts";

describe("resolveKimiAcpBaseModelId", () => {
  it("defaults empty ids and passes ACP-discovered ids through verbatim", () => {
    expect(resolveKimiAcpBaseModelId(undefined)).toBe("kimi-k3");
    expect(resolveKimiAcpBaseModelId("   ")).toBe("kimi-k3");
    expect(resolveKimiAcpBaseModelId("k3")).toBe("k3");
    expect(resolveKimiAcpBaseModelId("k2-thinking")).toBe("k2-thinking");
    expect(resolveKimiAcpBaseModelId("  kimi-test-custom-model  ")).toBe("kimi-test-custom-model");
  });
});

describe("buildKimiAcpSpawnInput", () => {
  it("spawns `kimi acp` and passes the environment through unchanged", () => {
    const spawn = buildKimiAcpSpawnInput({ binaryPath: "/usr/local/bin/kimi" }, "/tmp/project", {
      KIMI_API_KEY: "secret",
    });

    expect(spawn).toEqual({
      command: "/usr/local/bin/kimi",
      args: ["acp"],
      cwd: "/tmp/project",
      env: {
        KIMI_API_KEY: "secret",
      },
    });
  });
});

describe("applyKimiAcpModelSelection", () => {
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
      const result = yield* applyKimiAcpModelSelection({
        runtime,
        currentModelId: "kimi-k3",
        requestedModelId: "kimi-k2-thinking",
        mapError: (cause) => cause.message,
      });
      expect(modelCalls).toEqual(["kimi-k2-thinking"]);
      expect(result).toBe("kimi-k2-thinking");
    }),
  );

  it.effect("skips set_model when requested matches current", () =>
    Effect.gen(function* () {
      const { runtime, modelCalls } = makeRecordingRuntime();
      const result = yield* applyKimiAcpModelSelection({
        runtime,
        currentModelId: "kimi-k3",
        requestedModelId: "kimi-k3",
        mapError: (cause) => cause.message,
      });
      expect(modelCalls).toEqual([]);
      expect(result).toBe("kimi-k3");
    }),
  );

  it.effect("skips set_model when no model is requested", () =>
    Effect.gen(function* () {
      const { runtime, modelCalls } = makeRecordingRuntime();
      const result = yield* applyKimiAcpModelSelection({
        runtime,
        currentModelId: "kimi-k3",
        requestedModelId: undefined,
        mapError: (cause) => cause.message,
      });
      expect(modelCalls).toEqual([]);
      expect(result).toBe("kimi-k3");
    }),
  );

  it.effect("propagates session/set_model failures via mapError", () =>
    Effect.gen(function* () {
      const failure = EffectAcpErrors.AcpRequestError.invalidParams("session id not known");
      const { runtime } = makeRecordingRuntime(failure);
      const error = yield* Effect.flip(
        applyKimiAcpModelSelection({
          runtime,
          currentModelId: "kimi-k3",
          requestedModelId: "kimi-k2-thinking",
          mapError: (cause) => cause.message,
        }),
      );
      expect(error).toBe(failure.message);
    }),
  );
});
