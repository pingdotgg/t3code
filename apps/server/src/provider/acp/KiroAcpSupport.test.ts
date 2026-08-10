import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as EffectAcpErrors from "effect-acp/errors";

import {
  applyKiroAcpModelSelection,
  buildKiroAcpSpawnInput,
  currentKiroModelIdFromSessionSetup,
  resolveKiroAcpBaseModelId,
  resolveKiroAuthMethodId,
} from "./KiroAcpSupport.ts";

describe("buildKiroAcpSpawnInput", () => {
  it("launches the ACP subcommand with the configured binary", () => {
    const spawn = buildKiroAcpSpawnInput(
      { binaryPath: "~/.local/bin/kiro-cli", homePath: "", agent: "" },
      "/tmp/project",
      { PATH: "/usr/bin" },
    );

    expect(spawn).toEqual({
      command: "~/.local/bin/kiro-cli",
      args: ["acp"],
      cwd: "/tmp/project",
      env: { PATH: "/usr/bin" },
    });
  });

  it("falls back to the CLI name when no binary path is configured", () => {
    expect(buildKiroAcpSpawnInput(null, "/tmp/project").command).toBe("kiro-cli");
    expect(
      buildKiroAcpSpawnInput({ binaryPath: "   ", homePath: "", agent: "" }, "/tmp/project")
        .command,
    ).toBe("kiro-cli");
  });

  it("passes --agent only when an instance names one", () => {
    expect(
      buildKiroAcpSpawnInput(
        { binaryPath: "kiro-cli", homePath: "", agent: "kiro_planner" },
        "/tmp/project",
      ).args,
    ).toEqual(["acp", "--agent", "kiro_planner"]);
    expect(
      buildKiroAcpSpawnInput({ binaryPath: "kiro-cli", homePath: "", agent: "  " }, "/tmp/project")
        .args,
    ).toEqual(["acp"]);
  });

  it("isolates the instance home through KIRO_HOME, leaving other env intact", () => {
    const spawn = buildKiroAcpSpawnInput(
      { binaryPath: "kiro-cli", homePath: "~/.kiro-work", agent: "" },
      "/tmp/project",
      { PATH: "/usr/bin", KIRO_HOME: "~/.kiro" },
    );

    expect(spawn.env).toEqual({ PATH: "/usr/bin", KIRO_HOME: "~/.kiro-work" });
  });

  it("leaves an inherited KIRO_HOME untouched when the instance sets no home", () => {
    const spawn = buildKiroAcpSpawnInput(
      { binaryPath: "kiro-cli", homePath: "", agent: "" },
      "/tmp/project",
      { KIRO_HOME: "~/.kiro" },
    );

    expect(spawn.env).toEqual({ KIRO_HOME: "~/.kiro" });
  });
});

describe("resolveKiroAuthMethodId", () => {
  it("skips authenticate when the agent advertises no auth methods", () => {
    // kiro-cli 2.16.2 reports `authMethods: []` and answers `authenticate`
    // with -32601, so the startup sequence must not send it.
    expect(resolveKiroAuthMethodId({ authMethods: [] })).toBeUndefined();
    expect(resolveKiroAuthMethodId(undefined)).toBeUndefined();
    expect(resolveKiroAuthMethodId(null)).toBeUndefined();
  });

  it("uses the first advertised method if a future Kiro release gains one", () => {
    expect(
      resolveKiroAuthMethodId({
        authMethods: [
          { id: "kiro-login", name: "Kiro" },
          { id: "other", name: "Other" },
        ],
      }),
    ).toBe("kiro-login");
  });
});

describe("resolveKiroAcpBaseModelId", () => {
  it("falls back to Kiro's own default model", () => {
    expect(resolveKiroAcpBaseModelId(undefined)).toBe("auto");
    expect(resolveKiroAcpBaseModelId("   ")).toBe("auto");
  });

  it("keeps Kiro's dotted model ids verbatim", () => {
    expect(resolveKiroAcpBaseModelId("claude-haiku-4.5")).toBe("claude-haiku-4.5");
    expect(resolveKiroAcpBaseModelId("  gpt-5.6-sol  ")).toBe("gpt-5.6-sol");
  });

  it("expands short and dashed aliases onto Kiro's ids", () => {
    expect(resolveKiroAcpBaseModelId("opus")).toBe("claude-opus-5");
    expect(resolveKiroAcpBaseModelId("sonnet")).toBe("claude-sonnet-5");
    // Muscle memory from the Claude driver, which spells Haiku with dashes.
    expect(resolveKiroAcpBaseModelId("claude-haiku-4-5")).toBe("claude-haiku-4.5");
    expect(resolveKiroAcpBaseModelId("luna")).toBe("gpt-5.6-luna");
  });

  it("passes an unknown model through so custom ids still reach Kiro", () => {
    expect(resolveKiroAcpBaseModelId("some-future-model")).toBe("some-future-model");
  });
});

describe("currentKiroModelIdFromSessionSetup", () => {
  it("reads the model Kiro started the session with", () => {
    expect(
      currentKiroModelIdFromSessionSetup({
        sessionId: "session-1",
        models: { currentModelId: "claude-opus-5", availableModels: [] },
      }),
    ).toBe("claude-opus-5");
  });

  it("returns undefined when the session reports no model state", () => {
    expect(currentKiroModelIdFromSessionSetup({ sessionId: "session-1" })).toBeUndefined();
  });
});

describe("applyKiroAcpModelSelection", () => {
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

  it.effect("calls session/set_model when the requested model differs", () =>
    Effect.gen(function* () {
      const { runtime, modelCalls } = makeRecordingRuntime();
      const result = yield* applyKiroAcpModelSelection({
        runtime,
        currentModelId: "auto",
        requestedModelId: "claude-haiku-4.5",
        mapError: (cause) => cause.message,
      });
      expect(modelCalls).toEqual(["claude-haiku-4.5"]);
      expect(result).toBe("claude-haiku-4.5");
    }),
  );

  it.effect("skips set_model when the session already runs the requested model", () =>
    Effect.gen(function* () {
      const { runtime, modelCalls } = makeRecordingRuntime();
      const result = yield* applyKiroAcpModelSelection({
        runtime,
        currentModelId: "claude-haiku-4.5",
        requestedModelId: "claude-haiku-4.5",
        mapError: (cause) => cause.message,
      });
      expect(modelCalls).toEqual([]);
      expect(result).toBe("claude-haiku-4.5");
    }),
  );

  it.effect("skips set_model when no model is requested", () =>
    Effect.gen(function* () {
      const { runtime, modelCalls } = makeRecordingRuntime();
      const result = yield* applyKiroAcpModelSelection({
        runtime,
        currentModelId: "auto",
        requestedModelId: undefined,
        mapError: (cause) => cause.message,
      });
      expect(modelCalls).toEqual([]);
      expect(result).toBe("auto");
    }),
  );

  it.effect("propagates session/set_model failures via mapError", () =>
    Effect.gen(function* () {
      const failure = EffectAcpErrors.AcpRequestError.invalidParams("unknown model id");
      const { runtime } = makeRecordingRuntime(failure);
      const error = yield* Effect.flip(
        applyKiroAcpModelSelection({
          runtime,
          currentModelId: "auto",
          requestedModelId: "nope",
          mapError: (cause) => cause.message,
        }),
      );
      expect(error).toBe(failure.message);
    }),
  );
});
