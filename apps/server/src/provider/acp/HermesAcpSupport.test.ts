import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as EffectAcpErrors from "effect-acp/errors";

import {
  applyHermesAcpModelSelection,
  buildHermesAcpSpawnInput,
  HERMES_TERMINAL_AUTH_METHOD_ID,
  resolveHermesAcpBaseModelId,
  resolveHermesAcpModeId,
} from "./HermesAcpSupport.ts";

describe("resolveHermesAcpBaseModelId", () => {
  it("normalizes empty and custom Hermes model ids", () => {
    expect(resolveHermesAcpBaseModelId(undefined)).toBe("hermes-agent");
    expect(resolveHermesAcpBaseModelId("   ")).toBe("hermes-agent");
    expect(resolveHermesAcpBaseModelId("  anthropic:claude-opus-4-8  ")).toBe(
      "anthropic:claude-opus-4-8",
    );
  });
});

describe("resolveHermesAcpModeId", () => {
  it("maps Full access to dont_ask", () => {
    expect(resolveHermesAcpModeId("full-access")).toBe("dont_ask");
  });

  it("maps Auto-accept edits to accept_edits", () => {
    expect(resolveHermesAcpModeId("auto-accept-edits")).toBe("accept_edits");
  });

  it("maps every other runtime mode, including undefined, to default", () => {
    expect(resolveHermesAcpModeId("approval-required")).toBe("default");
    expect(resolveHermesAcpModeId("auto")).toBe("default");
    expect(resolveHermesAcpModeId(undefined)).toBe("default");
  });
});

describe("buildHermesAcpSpawnInput", () => {
  it("spawns `<binary> acp` with no runtime-mode-dependent argv", () => {
    const spawn = buildHermesAcpSpawnInput(
      { binaryPath: "/usr/local/bin/hermes", homePath: "" },
      "/tmp/project",
      {
        PATH: "/usr/bin",
      },
    );

    expect(spawn).toEqual({
      command: "/usr/local/bin/hermes",
      args: ["acp"],
      cwd: "/tmp/project",
      env: { PATH: "/usr/bin" },
    });
  });

  it("falls back to the `hermes` binary name when binaryPath is empty", () => {
    const spawn = buildHermesAcpSpawnInput(undefined, "/tmp/project");
    expect(spawn.command).toBe("hermes");
    expect(spawn.args).toEqual(["acp"]);
  });

  it("sets HERMES_HOME only when homePath is non-empty", () => {
    const withHome = buildHermesAcpSpawnInput(
      { binaryPath: "hermes", homePath: "~/.hermes/profiles/phoebe" },
      "/tmp/project",
    );
    expect(withHome.env).toEqual({ HERMES_HOME: "~/.hermes/profiles/phoebe" });

    const withoutHome = buildHermesAcpSpawnInput(
      { binaryPath: "hermes", homePath: "" },
      "/tmp/project",
    );
    expect(withoutHome.env).toEqual({});
  });
});

describe("applyHermesAcpModelSelection", () => {
  const makeRecordingRuntime = (failure?: EffectAcpErrors.AcpError) => {
    const modelCalls: string[] = [];
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
      const result = yield* applyHermesAcpModelSelection({
        runtime,
        currentModelId: "anthropic:claude-opus-4-8",
        requestedModelId: "anthropic:claude-sonnet-5",
        mapError: (cause) => cause.message,
      });
      expect(modelCalls).toEqual(["anthropic:claude-sonnet-5"]);
      expect(result).toBe("anthropic:claude-sonnet-5");
    }),
  );

  it.effect("skips set_model when requested matches current", () =>
    Effect.gen(function* () {
      const { runtime, modelCalls } = makeRecordingRuntime();
      const result = yield* applyHermesAcpModelSelection({
        runtime,
        currentModelId: "anthropic:claude-opus-4-8",
        requestedModelId: "anthropic:claude-opus-4-8",
        mapError: (cause) => cause.message,
      });
      expect(modelCalls).toEqual([]);
      expect(result).toBe("anthropic:claude-opus-4-8");
    }),
  );

  it.effect("keeps the session's current model when the placeholder slug is requested", () =>
    Effect.gen(function* () {
      const { runtime, modelCalls } = makeRecordingRuntime();
      const result = yield* applyHermesAcpModelSelection({
        runtime,
        currentModelId: "anthropic:claude-opus-4-8",
        requestedModelId: "hermes-agent",
        mapError: (cause) => cause.message,
      });
      expect(modelCalls).toEqual([]);
      expect(result).toBe("anthropic:claude-opus-4-8");
    }),
  );

  it.effect("skips set_model when no model is requested", () =>
    Effect.gen(function* () {
      const { runtime, modelCalls } = makeRecordingRuntime();
      const result = yield* applyHermesAcpModelSelection({
        runtime,
        currentModelId: "anthropic:claude-opus-4-8",
        requestedModelId: undefined,
        mapError: (cause) => cause.message,
      });
      expect(modelCalls).toEqual([]);
      expect(result).toBe("anthropic:claude-opus-4-8");
    }),
  );

  it.effect("propagates session/set_model failures via mapError", () =>
    Effect.gen(function* () {
      const failure = EffectAcpErrors.AcpRequestError.invalidParams("session id not known");
      const { runtime } = makeRecordingRuntime(failure);
      const error = yield* Effect.flip(
        applyHermesAcpModelSelection({
          runtime,
          currentModelId: "anthropic:claude-opus-4-8",
          requestedModelId: "anthropic:claude-sonnet-5",
          mapError: (cause) => cause.message,
        }),
      );
      expect(error).toBe(failure.message);
    }),
  );
});

describe("HERMES_TERMINAL_AUTH_METHOD_ID", () => {
  it("is the documented fallback terminal auth method id", () => {
    expect(HERMES_TERMINAL_AUTH_METHOD_ID).toBe("hermes-setup");
  });
});
