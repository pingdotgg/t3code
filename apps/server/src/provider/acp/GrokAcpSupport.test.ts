import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as EffectAcpErrors from "effect-acp/errors";

import {
  applyGrokAcpModelSelection,
  buildGrokAcpSpawnInput,
  grokAuthJsonHasCredentials,
  GROK_UNAUTHENTICATED_MESSAGE,
  hasGrokApiKeyInEnvironment,
  probeGrokCliCredentials,
  resolveGrokAuthJsonPath,
  resolveGrokAcpBaseModelId,
} from "./GrokAcpSupport.ts";

describe("resolveGrokAcpBaseModelId", () => {
  it("normalizes empty and custom Grok model ids", () => {
    expect(resolveGrokAcpBaseModelId(undefined)).toBe("grok-build");
    expect(resolveGrokAcpBaseModelId("   ")).toBe("grok-build");
    expect(resolveGrokAcpBaseModelId("  grok-test-custom-model  ")).toBe("grok-test-custom-model");
  });
});

describe("grok credential helpers", () => {
  it("detects API key environment variables", () => {
    expect(hasGrokApiKeyInEnvironment({})).toBe(false);
    expect(hasGrokApiKeyInEnvironment({ XAI_API_KEY: "   " })).toBe(false);
    expect(hasGrokApiKeyInEnvironment({ XAI_API_KEY: "xai-test" })).toBe(true);
  });

  it("parses cached Grok auth.json credentials", () => {
    expect(grokAuthJsonHasCredentials("")).toBe(false);
    expect(grokAuthJsonHasCredentials("{}")).toBe(false);
    expect(
      grokAuthJsonHasCredentials(
        '{"https://auth.x.ai::example":{"refresh_token":"refresh-token"}}',
      ),
    ).toBe(true);
    expect(grokAuthJsonHasCredentials('{"https://auth.x.ai::example":{"key":"api-key"}}')).toBe(
      true,
    );
  });

  it("resolves the default Grok auth.json path", () => {
    expect(resolveGrokAuthJsonPath("/home/user")).toBe("/home/user/.grok/auth.json");
  });

  it.effect("probes credentials from env or auth.json", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const homeDirectory = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-grok-auth-" });
      const authPath = path.join(homeDirectory, ".grok", "auth.json");
      yield* fs.makeDirectory(path.join(homeDirectory, ".grok"), { recursive: true });

      expect(yield* probeGrokCliCredentials({}, homeDirectory)).toBe(false);

      yield* fs.writeFileString(
        authPath,
        '{"https://auth.x.ai::example":{"refresh_token":"refresh-token"}}',
      );
      expect(yield* probeGrokCliCredentials({}, homeDirectory)).toBe(true);
      expect(yield* probeGrokCliCredentials({ XAI_API_KEY: "xai-test" }, homeDirectory)).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it("documents the unauthenticated guidance message", () => {
    expect(GROK_UNAUTHENTICATED_MESSAGE).toContain("grok login");
    expect(GROK_UNAUTHENTICATED_MESSAGE).toContain("XAI_API_KEY");
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
