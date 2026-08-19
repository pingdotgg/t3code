import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as EffectAcpErrors from "effect-acp/errors";

import {
  applyKimiAcpModelSelection,
  buildKimiAcpSpawnInput,
  isKimiAuthRequiredError,
  resolveKimiAcpBaseModelId,
  resolveKimiAcpWireModelId,
} from "./KimiAcpSupport.ts";

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
        currentModelId: "k3",
        requestedModelId: "kimi-for-coding",
        mapError: (cause) => cause.message,
      });
      expect(modelCalls).toEqual(["kimi-code/kimi-for-coding"]);
      expect(result).toBe("kimi-for-coding");
    }),
  );

  it.effect("uses the advertised wire id when the session advertised models", () =>
    Effect.gen(function* () {
      const { runtime, modelCalls } = makeRecordingRuntime();
      const result = yield* applyKimiAcpModelSelection({
        runtime,
        currentModelId: "k3",
        requestedModelId: "kimi-for-coding",
        advertisedModelIds: ["k3", "k3,thinking", "kimi-for-coding"],
        mapError: (cause) => cause.message,
      });
      expect(modelCalls).toEqual(["kimi-for-coding"]);
      expect(result).toBe("kimi-for-coding");
    }),
  );

  it.effect("skips set_model when requested matches current", () =>
    Effect.gen(function* () {
      const { runtime, modelCalls } = makeRecordingRuntime();
      const result = yield* applyKimiAcpModelSelection({
        runtime,
        currentModelId: "k3",
        requestedModelId: "k3",
        mapError: (cause) => cause.message,
      });
      expect(modelCalls).toEqual([]);
      expect(result).toBe("k3");
    }),
  );

  it.effect("treats a thinking-variant current model as its base id", () =>
    Effect.gen(function* () {
      const { runtime, modelCalls } = makeRecordingRuntime();
      const result = yield* applyKimiAcpModelSelection({
        runtime,
        currentModelId: "k3,thinking",
        requestedModelId: "k3",
        mapError: (cause) => cause.message,
      });
      expect(modelCalls).toEqual([]);
      expect(result).toBe("k3,thinking");
    }),
  );

  it.effect("skips set_model when no model is requested", () =>
    Effect.gen(function* () {
      const { runtime, modelCalls } = makeRecordingRuntime();
      const result = yield* applyKimiAcpModelSelection({
        runtime,
        currentModelId: "k3",
        requestedModelId: undefined,
        mapError: (cause) => cause.message,
      });
      expect(modelCalls).toEqual([]);
      expect(result).toBe("k3");
    }),
  );

  it.effect("propagates session/set_model failures via mapError", () =>
    Effect.gen(function* () {
      const failure = EffectAcpErrors.AcpRequestError.invalidParams("session id not known");
      const { runtime } = makeRecordingRuntime(failure);
      const error = yield* Effect.flip(
        applyKimiAcpModelSelection({
          runtime,
          currentModelId: "k3",
          requestedModelId: "kimi-for-coding",
          mapError: (cause) => cause.message,
        }),
      );
      expect(error).toBe(failure.message);
    }),
  );
});
