import { describe, expect, it } from "@effect/vitest";
import * as NodeOS from "node:os";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as EffectAcpErrors from "effect-acp/errors";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";

import {
  applyKimiAcpModelSelection,
  buildKimiAcpSpawnInput,
  resolveKimiAcpBaseModelId,
  resolveKimiBinaryPath,
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
  it.effect("spawns `kimi acp` and passes the environment through unchanged", () =>
    Effect.gen(function* () {
      const spawn = yield* buildKimiAcpSpawnInput(
        { binaryPath: "/usr/local/bin/kimi" },
        "/tmp/project",
        { KIMI_API_KEY: "secret" },
      );

      expect(spawn).toEqual({
        command: "/usr/local/bin/kimi",
        args: ["acp"],
        cwd: "/tmp/project",
        env: {
          KIMI_API_KEY: "secret",
        },
      });
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

describe("resolveKimiBinaryPath", () => {
  it.effect("uses an explicit binaryPath verbatim without probing PATH", () =>
    Effect.gen(function* () {
      const resolved = yield* resolveKimiBinaryPath({ binaryPath: "/opt/kimi/bin/kimi" });
      expect(resolved).toBe("/opt/kimi/bin/kimi");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("falls back to the well-known install path when kimi is not on PATH", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const expected = path.join(NodeOS.homedir(), ".kimi-code", "bin", "kimi.exe");
      const fakeFileSystem = FileSystem.FileSystem.of({
        ...fileSystem,
        exists: (candidate) => Effect.succeed(candidate === expected),
      });

      // Empty PATH so the bare `kimi` is not resolvable; win32 so the fallback
      // targets kimi.exe.
      const resolved = yield* resolveKimiBinaryPath(
        { binaryPath: "kimi" },
        { PATH: "", PATHEXT: ".EXE" },
      ).pipe(
        Effect.provideService(FileSystem.FileSystem, fakeFileSystem),
        Effect.provideService(HostProcessPlatform, "win32"),
      );

      expect(resolved).toBe(expected);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("returns the bare command when kimi is neither on PATH nor at the fallback", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const fakeFileSystem = FileSystem.FileSystem.of({
        ...fileSystem,
        exists: () => Effect.succeed(false),
      });

      const resolved = yield* resolveKimiBinaryPath({ binaryPath: "kimi" }, { PATH: "" }).pipe(
        Effect.provideService(FileSystem.FileSystem, fakeFileSystem),
        Effect.provideService(HostProcessPlatform, "win32"),
      );

      expect(resolved).toBe("kimi");
    }).pipe(Effect.provide(NodeServices.layer)),
  );
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
