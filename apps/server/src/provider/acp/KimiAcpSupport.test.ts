import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as EffectAcpErrors from "effect-acp/errors";

import {
  applyKimiAcpModelSelection,
  buildKimiAcpSpawnInput,
  resolveKimiAcpBaseModelId,
} from "./KimiAcpSupport.ts";

describe("resolveKimiAcpBaseModelId", () => {
  it("normalizes empty, short, and prefixed Kimi model ids", () => {
    expect(resolveKimiAcpBaseModelId(undefined)).toBe("kimi-code/kimi-for-coding");
    expect(resolveKimiAcpBaseModelId("   ")).toBe("kimi-code/kimi-for-coding");
    expect(resolveKimiAcpBaseModelId("k3")).toBe("kimi-code/k3");
    expect(resolveKimiAcpBaseModelId("k3-256k")).toBe("kimi-code/k3-256k");
    expect(resolveKimiAcpBaseModelId("kimi-for-coding")).toBe("kimi-code/kimi-for-coding");
    expect(resolveKimiAcpBaseModelId("kimi-for-coding-highspeed")).toBe(
      "kimi-code/kimi-for-coding-highspeed",
    );
    expect(resolveKimiAcpBaseModelId("kimi-code/k3")).toBe("kimi-code/k3");
    expect(resolveKimiAcpBaseModelId("  custom-provider/my-model  ")).toBe(
      "custom-provider/my-model",
    );
  });
});

describe("buildKimiAcpSpawnInput", () => {
  it("spawns `kimi acp` with optional binary path and environment", () => {
    const spawn = buildKimiAcpSpawnInput({ binaryPath: "/usr/local/bin/kimi" }, "/tmp/project", {
      KIMI_CODE_HOME: "/tmp/kimi-home",
    });

    expect(spawn).toEqual({
      command: "/usr/local/bin/kimi",
      args: ["acp"],
      cwd: "/tmp/project",
      env: {
        KIMI_CODE_HOME: "/tmp/kimi-home",
      },
    });
  });

  it("defaults the command to `kimi` when no binary path is set", () => {
    const spawn = buildKimiAcpSpawnInput(undefined, "/work");
    expect(spawn).toEqual({
      command: "kimi",
      args: ["acp"],
      cwd: "/work",
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
        currentModelId: "kimi-code/kimi-for-coding",
        requestedModelId: "kimi-code/k3",
        mapError: (cause) => cause.message,
      });
      expect(modelCalls).toEqual(["kimi-code/k3"]);
      expect(result).toBe("kimi-code/k3");
    }),
  );

  it.effect("skips set_model when requested matches current", () =>
    Effect.gen(function* () {
      const { runtime, modelCalls } = makeRecordingRuntime();
      const result = yield* applyKimiAcpModelSelection({
        runtime,
        currentModelId: "kimi-code/kimi-for-coding",
        requestedModelId: "kimi-code/kimi-for-coding",
        mapError: (cause) => cause.message,
      });
      expect(modelCalls).toEqual([]);
      expect(result).toBe("kimi-code/kimi-for-coding");
    }),
  );

  it.effect("skips set_model when no model is requested", () =>
    Effect.gen(function* () {
      const { runtime, modelCalls } = makeRecordingRuntime();
      const result = yield* applyKimiAcpModelSelection({
        runtime,
        currentModelId: "kimi-code/kimi-for-coding",
        requestedModelId: undefined,
        mapError: (cause) => cause.message,
      });
      expect(modelCalls).toEqual([]);
      expect(result).toBe("kimi-code/kimi-for-coding");
    }),
  );

  it.effect("propagates session/set_model failures via mapError", () =>
    Effect.gen(function* () {
      const failure = EffectAcpErrors.AcpRequestError.invalidParams("session id not known");
      const { runtime } = makeRecordingRuntime(failure);
      const error = yield* Effect.flip(
        applyKimiAcpModelSelection({
          runtime,
          currentModelId: "kimi-code/kimi-for-coding",
          requestedModelId: "other",
          mapError: (cause) => cause.message,
        }),
      );
      expect(error).toContain("session id not known");
    }),
  );
});
