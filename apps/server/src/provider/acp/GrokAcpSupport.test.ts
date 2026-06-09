import * as Effect from "effect/Effect";
import * as EffectAcpErrors from "effect-acp/errors";
import { describe, expect, it } from "vite-plus/test";

import {
  applyGrokAcpModelSelection,
  buildGrokAcpSpawnInput,
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

  it("calls session/set_model when the requested model differs from current", async () => {
    const { runtime, modelCalls } = makeRecordingRuntime();
    const result = await Effect.runPromise(
      applyGrokAcpModelSelection({
        runtime,
        currentModelId: "grok-build",
        requestedModelId: "grok-mock-alt",
        mapError: (cause) => cause.message,
      }),
    );
    expect(modelCalls).toEqual(["grok-mock-alt"]);
    expect(result).toBe("grok-mock-alt");
  });

  it("skips set_model when requested matches current", async () => {
    const { runtime, modelCalls } = makeRecordingRuntime();
    const result = await Effect.runPromise(
      applyGrokAcpModelSelection({
        runtime,
        currentModelId: "grok-build",
        requestedModelId: "grok-build",
        mapError: (cause) => cause.message,
      }),
    );
    expect(modelCalls).toEqual([]);
    expect(result).toBe("grok-build");
  });

  it("skips set_model when no model is requested", async () => {
    const { runtime, modelCalls } = makeRecordingRuntime();
    const result = await Effect.runPromise(
      applyGrokAcpModelSelection({
        runtime,
        currentModelId: "grok-build",
        requestedModelId: undefined,
        mapError: (cause) => cause.message,
      }),
    );
    expect(modelCalls).toEqual([]);
    expect(result).toBe("grok-build");
  });

  it("propagates session/set_model failures via mapError", async () => {
    const failure = EffectAcpErrors.AcpRequestError.invalidParams("session id not known");
    const { runtime } = makeRecordingRuntime(failure);
    const error = await Effect.runPromise(
      Effect.flip(
        applyGrokAcpModelSelection({
          runtime,
          currentModelId: "grok-build",
          requestedModelId: "grok-mock-alt",
          mapError: (cause) => cause.message,
        }),
      ),
    );
    expect(error).toBe(failure.message);
  });
});
