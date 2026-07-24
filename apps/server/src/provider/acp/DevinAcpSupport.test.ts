import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as EffectAcpErrors from "effect-acp/errors";

import {
  applyDevinAcpModelSelection,
  buildDevinAcpSpawnInput,
  hasDevinCredentials,
  resolveDevinAcpBaseModelId,
} from "./DevinAcpSupport.ts";

describe("resolveDevinAcpBaseModelId", () => {
  it("normalizes empty and custom Devin model ids", () => {
    expect(resolveDevinAcpBaseModelId(undefined)).toBe("adaptive");
    expect(resolveDevinAcpBaseModelId("   ")).toBe("adaptive");
    expect(resolveDevinAcpBaseModelId("  swe-1-6-fast  ")).toBe("swe-1-6-fast");
  });
});

describe("buildDevinAcpSpawnInput", () => {
  it("spawns `devin acp` with the configured binary and environment", () => {
    const spawn = buildDevinAcpSpawnInput(
      { binaryPath: "/usr/local/bin/devin", apiKey: "" },
      "/tmp/project",
      { WINDSURF_API_KEY: "secret" },
    );

    expect(spawn).toEqual({
      command: "/usr/local/bin/devin",
      args: ["acp"],
      cwd: "/tmp/project",
      env: { WINDSURF_API_KEY: "secret" },
    });
  });

  it("falls back to the `devin` binary when no path is configured", () => {
    const spawn = buildDevinAcpSpawnInput(null, "/tmp/project");
    expect(spawn.command).toBe("devin");
    expect(spawn.args).toEqual(["acp"]);
  });
});

describe("hasDevinCredentials", () => {
  it("prefers the settings API key, then the environment variable", () => {
    expect(hasDevinCredentials({ apiKey: "key" }, {})).toBe(true);
    expect(hasDevinCredentials({ apiKey: "" }, { WINDSURF_API_KEY: "key" })).toBe(true);
    expect(hasDevinCredentials({ apiKey: "  " }, { WINDSURF_API_KEY: "  " })).toBe(false);
    expect(hasDevinCredentials(null, undefined)).toBe(false);
  });
});

describe("applyDevinAcpModelSelection", () => {
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

  it.effect("calls session/set_model when the agent reported a differing current model", () =>
    Effect.gen(function* () {
      const { runtime, modelCalls } = makeRecordingRuntime();
      const result = yield* applyDevinAcpModelSelection({
        runtime,
        currentModelId: "adaptive",
        requestedModelId: "swe-1-6-fast",
        mapError: (cause) => cause.message,
      });
      expect(modelCalls).toEqual(["swe-1-6-fast"]);
      expect(result).toBe("swe-1-6-fast");
    }),
  );

  it.effect("skips set_model when the agent reported no model state", () =>
    Effect.gen(function* () {
      // Devin's ACP server routes models server-side (Adaptive) and does not
      // negotiate a session model — never call the unstable method then.
      const { runtime, modelCalls } = makeRecordingRuntime();
      const result = yield* applyDevinAcpModelSelection({
        runtime,
        currentModelId: undefined,
        requestedModelId: "adaptive",
        mapError: (cause) => cause.message,
      });
      expect(modelCalls).toEqual([]);
      expect(result).toBeUndefined();
    }),
  );

  it.effect("skips set_model when requested matches current", () =>
    Effect.gen(function* () {
      const { runtime, modelCalls } = makeRecordingRuntime();
      const result = yield* applyDevinAcpModelSelection({
        runtime,
        currentModelId: "adaptive",
        requestedModelId: "adaptive",
        mapError: (cause) => cause.message,
      });
      expect(modelCalls).toEqual([]);
      expect(result).toBe("adaptive");
    }),
  );

  it.effect("keeps the agent default when set_model is unimplemented", () =>
    Effect.gen(function* () {
      const failure = EffectAcpErrors.AcpRequestError.methodNotFound("session/set_model");
      const { runtime } = makeRecordingRuntime(failure);
      const result = yield* applyDevinAcpModelSelection({
        runtime,
        currentModelId: "adaptive",
        requestedModelId: "swe-1-6-fast",
        mapError: (cause) => cause.message,
      });
      expect(result).toBe("adaptive");
    }),
  );

  it.effect("propagates other session/set_model failures via mapError", () =>
    Effect.gen(function* () {
      const failure = EffectAcpErrors.AcpRequestError.invalidParams("session id not known");
      const { runtime } = makeRecordingRuntime(failure);
      const error = yield* Effect.flip(
        applyDevinAcpModelSelection({
          runtime,
          currentModelId: "adaptive",
          requestedModelId: "swe-1-6-fast",
          mapError: (cause) => cause.message,
        }),
      );
      expect(error).toBe(failure.message);
    }),
  );
});
