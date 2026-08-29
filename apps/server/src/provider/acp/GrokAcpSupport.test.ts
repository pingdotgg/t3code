import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as EffectAcpErrors from "effect-acp/errors";

import {
  applyGrokAcpModelSelection,
  buildGrokAcpSpawnInput,
  grokAcpSpawnArgs,
  isValidGrokReasoningEffortToken,
  resolveGrokAcpBaseModelId,
} from "./GrokAcpSupport.ts";

describe("resolveGrokAcpBaseModelId", () => {
  it("normalizes empty and custom Grok model ids", () => {
    expect(resolveGrokAcpBaseModelId(undefined)).toBe("grok-build");
    expect(resolveGrokAcpBaseModelId("   ")).toBe("grok-build");
    expect(resolveGrokAcpBaseModelId("  grok-test-custom-model  ")).toBe("grok-test-custom-model");
  });
});

describe("grokAcpSpawnArgs", () => {
  it("inherits the Grok CLI config when no T3 runtime mode is set", () => {
    expect(grokAcpSpawnArgs()).toEqual(["agent", "stdio"]);
  });

  it("forces Grok to ask when T3 is Supervised", () => {
    expect(grokAcpSpawnArgs("approval-required")).toEqual([
      "--permission-mode",
      "default",
      "agent",
      "stdio",
    ]);
  });

  it("maps Full access to Grok always-approve", () => {
    expect(grokAcpSpawnArgs("full-access")).toEqual(["agent", "--always-approve", "stdio"]);
  });

  it("maps Auto-accept edits and Auto onto Grok permission modes", () => {
    expect(grokAcpSpawnArgs("auto-accept-edits")).toEqual([
      "--permission-mode",
      "acceptEdits",
      "agent",
      "stdio",
    ]);
    expect(grokAcpSpawnArgs("auto")).toEqual(["--permission-mode", "auto", "agent", "stdio"]);
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

  it("puts Supervised on the Grok argv so config always-approve cannot win", () => {
    const spawn = buildGrokAcpSpawnInput(
      { binaryPath: "/usr/local/bin/grok" },
      "/tmp/project",
      undefined,
      "approval-required",
    );
    expect(spawn.args).toEqual(["--permission-mode", "default", "agent", "stdio"]);
  });
});

describe("isValidGrokReasoningEffortToken", () => {
  it("accepts future ACP tokens and rejects malformed metadata values", () => {
    expect(isValidGrokReasoningEffortToken("xhigh")).toBe(true);
    expect(isValidGrokReasoningEffortToken("turbo_v2")).toBe(true);
    expect(isValidGrokReasoningEffortToken("not a token")).toBe(false);
    expect(isValidGrokReasoningEffortToken("-leading-dash")).toBe(false);
    expect(isValidGrokReasoningEffortToken("x".repeat(33))).toBe(false);
  });
});

describe("applyGrokAcpModelSelection", () => {
  const makeRecordingRuntime = (failure?: EffectAcpErrors.AcpError) => {
    const modelCalls: Array<{
      modelId: string;
      meta?: { readonly [key: string]: unknown } | null;
    }> = [];
    const runtime = {
      setSessionModel: (modelId: string, meta?: { readonly [key: string]: unknown } | null) =>
        Effect.gen(function* () {
          modelCalls.push(meta === undefined ? { modelId } : { modelId, meta });
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
      expect(modelCalls).toEqual([{ modelId: "grok-mock-alt" }]);
      expect(result).toBe("grok-mock-alt");
    }),
  );

  it.effect("applies reasoning effort through session/set_model metadata", () =>
    Effect.gen(function* () {
      const { runtime, modelCalls } = makeRecordingRuntime();
      const result = yield* applyGrokAcpModelSelection({
        runtime,
        currentModelId: "grok-4.6",
        currentReasoningEffort: "high",
        requestedModelId: "grok-4.6",
        requestedReasoningEffort: "xhigh",
        mapError: (cause) => cause.message,
      });
      expect(modelCalls).toEqual([{ modelId: "grok-4.6", meta: { reasoningEffort: "xhigh" } }]);
      expect(result).toBe("grok-4.6");
    }),
  );

  it.effect("does not clear reasoning when same-model selection omits effort", () =>
    Effect.gen(function* () {
      const { runtime, modelCalls } = makeRecordingRuntime();
      const result = yield* applyGrokAcpModelSelection({
        runtime,
        currentModelId: "grok-4.6",
        currentReasoningEffort: "high",
        requestedModelId: "grok-4.6",
        requestedReasoningEffort: undefined,
        mapError: (cause) => cause.message,
      });
      expect(modelCalls).toEqual([]);
      expect(result).toBe("grok-4.6");
    }),
  );

  it.effect("drops malformed effort metadata instead of sending it", () =>
    Effect.gen(function* () {
      const { runtime, modelCalls } = makeRecordingRuntime();
      yield* applyGrokAcpModelSelection({
        runtime,
        currentModelId: "grok-4.6",
        currentReasoningEffort: "high",
        requestedModelId: "grok-4.6",
        requestedReasoningEffort: "not a token",
        mapError: (cause) => cause.message,
      });
      expect(modelCalls).toEqual([{ modelId: "grok-4.6" }]);
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
