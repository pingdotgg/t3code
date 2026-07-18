import * as NodeOS from "node:os";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import {
  applyKimiAcpModeSelection,
  applyKimiAcpModelSelection,
  buildKimiAcpSpawnInput,
  currentKimiModelIdFromConfigOptions,
  getKimiAcpModelOptions,
  isKimiModelCatalogEmpty,
  KIMI_AUTH_METHOD_ID,
  KIMI_AUTH_REQUIRED_MESSAGE,
  makeKimiAuthRequiredError,
  resolveKimiAcpBaseModelId,
  resolveKimiAcpModeId,
  resolveKimiBinaryPath,
} from "./KimiAcpSupport.ts";

const configOptions = [
  {
    type: "select",
    id: "model",
    name: "Model",
    category: "model",
    currentValue: "kimi-for-coding",
    options: [
      { value: "kimi-for-coding", name: "Kimi for Coding" },
      { value: "kimi-for-coding-highspeed", name: "Kimi for Coding Highspeed" },
    ],
  },
  {
    type: "select",
    id: "mode",
    name: "Mode",
    category: "mode",
    currentValue: "default",
    options: [
      { value: "default", name: "Default" },
      { value: "plan", name: "Plan" },
      { value: "yolo", name: "YOLO" },
    ],
  },
] satisfies ReadonlyArray<EffectAcpSchema.SessionConfigOption>;

describe("Kimi ACP model configuration", () => {
  it("uses Kimi's terminal login auth method", () => {
    expect(KIMI_AUTH_METHOD_ID).toBe("login");
  });

  it("normalizes empty and custom Kimi model ids", () => {
    expect(resolveKimiAcpBaseModelId(undefined)).toBe("kimi-for-coding");
    expect(resolveKimiAcpBaseModelId("   ")).toBe("kimi-for-coding");
    expect(resolveKimiAcpBaseModelId("  kimi-test-custom-model  ")).toBe("kimi-test-custom-model");
  });

  it("treats an empty model option list as the signed-out state", () => {
    // A logged-out Kimi CLI still creates sessions but reports the model
    // select with no options. The catalog check must distinguish that from
    // a response with no model option at all (older CLI / unknown shape).
    const emptyModelOption = {
      type: "select",
      id: "model",
      name: "Model",
      category: "model",
      currentValue: "",
      options: [],
    } satisfies EffectAcpSchema.SessionConfigOption;
    const modeOnlyOption = {
      type: "select",
      id: "mode",
      name: "Mode",
      category: "mode",
      currentValue: "default",
      options: [{ value: "default", name: "Default" }],
    } satisfies EffectAcpSchema.SessionConfigOption;

    expect(isKimiModelCatalogEmpty([emptyModelOption, modeOnlyOption])).toBe(true);
    expect(isKimiModelCatalogEmpty(configOptions)).toBe(false);
    expect(isKimiModelCatalogEmpty([modeOnlyOption])).toBe(false);
    expect(isKimiModelCatalogEmpty(undefined)).toBe(false);
    expect(makeKimiAuthRequiredError().errorMessage).toBe(KIMI_AUTH_REQUIRED_MESSAGE);
  });

  it("reads the current and available models from the model config option", () => {
    expect(currentKimiModelIdFromConfigOptions(configOptions)).toBe("kimi-for-coding");
    expect(getKimiAcpModelOptions(configOptions)).toEqual([
      { value: "kimi-for-coding", name: "Kimi for Coding" },
      { value: "kimi-for-coding-highspeed", name: "Kimi for Coding Highspeed" },
    ]);
  });

  it.effect("switches models through session/set_config_option", () =>
    Effect.gen(function* () {
      const calls: Array<[string, string | boolean]> = [];
      const selected = yield* applyKimiAcpModelSelection({
        runtime: {
          setConfigOption: (configId, value) =>
            Effect.sync(() => {
              calls.push([configId, value]);
              return { configOptions };
            }),
        },
        currentModelId: "kimi-for-coding",
        requestedModelId: "kimi-for-coding-highspeed",
        mapError: (cause) => cause.message,
      });

      expect(selected).toBe("kimi-for-coding-highspeed");
      expect(calls).toEqual([["model", "kimi-for-coding-highspeed"]]);
    }),
  );

  it.effect("maps config write failures", () =>
    Effect.gen(function* () {
      const failure = EffectAcpErrors.AcpRequestError.invalidParams("unknown model");
      const error = yield* Effect.flip(
        applyKimiAcpModelSelection({
          runtime: { setConfigOption: () => Effect.fail(failure) },
          currentModelId: "kimi-for-coding",
          requestedModelId: "missing",
          mapError: (cause) => cause.message,
        }),
      );
      expect(error).toBe(failure.message);
    }),
  );
});

describe("Kimi ACP mode configuration", () => {
  it("maps T3 runtime and interaction modes to Kimi modes", () => {
    expect(resolveKimiAcpModeId({ runtimeMode: "full-access", interactionMode: undefined })).toBe(
      "yolo",
    );
    expect(
      resolveKimiAcpModeId({ runtimeMode: "approval-required", interactionMode: undefined }),
    ).toBe("default");
    expect(
      resolveKimiAcpModeId({ runtimeMode: "auto-accept-edits", interactionMode: undefined }),
    ).toBe("yolo");
    expect(resolveKimiAcpModeId({ runtimeMode: "full-access", interactionMode: "plan" })).toBe(
      "plan",
    );
  });

  it.effect("writes the resolved mode through the mode config option", () =>
    Effect.gen(function* () {
      const calls: Array<[string, string | boolean]> = [];
      yield* applyKimiAcpModeSelection({
        runtime: {
          setConfigOption: (configId, value) =>
            Effect.sync(() => {
              calls.push([configId, value]);
              return { configOptions };
            }),
        },
        runtimeMode: "full-access",
        interactionMode: "plan",
        mapError: (cause) => cause.message,
      });
      expect(calls).toEqual([["mode", "plan"]]);
    }),
  );
});

it.layer(NodeServices.layer)("Kimi ACP spawn resolution", (it) => {
  it.effect("uses the configured binary and expands KIMI_CODE_HOME", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const spawn = yield* buildKimiAcpSpawnInput(
        { binaryPath: "/opt/kimi", homePath: "~/.kimi-work" },
        "/tmp/project",
        { PATH: "/bin", KEEP_ME: "yes" },
      );

      expect(spawn).toEqual({
        command: "/opt/kimi",
        args: ["acp"],
        cwd: "/tmp/project",
        env: {
          PATH: "/bin",
          KEEP_ME: "yes",
          KIMI_CODE_HOME: path.resolve(NodeOS.homedir(), ".kimi-work"),
        },
      });
    }),
  );

  it.effect("falls back to the well-known Windows install path when kimi is not on PATH", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const expected = path.join(NodeOS.homedir(), ".kimi-code", "bin", "kimi.exe");
      const fakeFileSystem = FileSystem.FileSystem.of({
        ...fileSystem,
        exists: (candidate) => Effect.succeed(candidate === expected),
      });

      const resolved = yield* resolveKimiBinaryPath(
        { binaryPath: "kimi" },
        { PATH: "", PATHEXT: ".EXE" },
      ).pipe(
        Effect.provideService(FileSystem.FileSystem, fakeFileSystem),
        Effect.provideService(HostProcessPlatform, "win32"),
      );

      expect(resolved).toBe(expected);
    }),
  );
});
