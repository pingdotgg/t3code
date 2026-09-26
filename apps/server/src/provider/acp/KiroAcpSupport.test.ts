import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as EffectAcpErrors from "effect-acp/errors";

import {
  applyKiroAcpModelSelection,
  currentKiroModelIdFromSessionSetup,
  kiroCliFailure,
  kiroPromptFailure,
  resolveKiroAcpModelId,
} from "./KiroAcpSupport.ts";

describe("resolveKiroAcpModelId", () => {
  it("treats empty selections as Kiro's auto model", () => {
    expect(resolveKiroAcpModelId(undefined)).toBe("auto");
    expect(resolveKiroAcpModelId("   ")).toBe("auto");
    expect(resolveKiroAcpModelId(" claude-sonnet-4.5 ")).toBe("claude-sonnet-4.5");
  });

  it("reads the session's current model from a v1 session response", () => {
    expect(
      currentKiroModelIdFromSessionSetup({
        sessionId: "session-1",
        models: { currentModelId: "auto", availableModels: [] },
      }),
    ).toBe("auto");
    expect(currentKiroModelIdFromSessionSetup({ sessionId: "session-1" })).toBeUndefined();
  });
});

describe("applyKiroAcpModelSelection", () => {
  const makeRecordingRuntime = (failure?: EffectAcpErrors.AcpError) => {
    const modelIds: Array<string> = [];
    const runtime = {
      setSessionModel: (modelId: string) =>
        Effect.gen(function* () {
          modelIds.push(modelId);
          if (failure) return yield* failure;
          return {};
        }),
    };
    return { runtime, modelIds };
  };

  it.effect("sends session/set_model when the requested model differs", () =>
    Effect.gen(function* () {
      const { runtime, modelIds } = makeRecordingRuntime();
      const applied = yield* applyKiroAcpModelSelection({
        runtime,
        currentModelId: "auto",
        requestedModelId: "claude-haiku-4.5",
        mapError: (cause) => cause.message,
      });
      expect(modelIds).toEqual(["claude-haiku-4.5"]);
      expect(applied).toBe("claude-haiku-4.5");
    }),
  );

  it.effect("skips the request when the session already runs the model", () =>
    Effect.gen(function* () {
      const { runtime, modelIds } = makeRecordingRuntime();
      const applied = yield* applyKiroAcpModelSelection({
        runtime,
        currentModelId: "auto",
        requestedModelId: undefined,
        mapError: (cause) => cause.message,
      });
      expect(modelIds).toEqual([]);
      expect(applied).toBe("auto");
    }),
  );

  it.effect("maps agent rejections through the caller's error", () =>
    Effect.gen(function* () {
      const { runtime } = makeRecordingRuntime(
        new EffectAcpErrors.AcpRequestError({ code: -32602, errorMessage: "Unknown model" }),
      );
      const error = yield* Effect.flip(
        applyKiroAcpModelSelection({
          runtime,
          currentModelId: "auto",
          requestedModelId: "missing-model",
          mapError: (cause) => `mapped: ${cause.message}`,
        }),
      );
      expect(error).toBe("mapped: Unknown model");
    }),
  );
});

describe("kiroCliFailure", () => {
  it("names the setup step for a missing chat component and login", () => {
    expect(
      kiroCliFailure("error: failed to launch /Users/dev/.local/bin/kiro-cli-chat\n"),
    ).toMatchObject({ kind: "chat-missing" });
    expect(
      kiroCliFailure("error: You are not logged in, please log in with kiro-cli login"),
    ).toMatchObject({ kind: "not-logged-in" });
    expect(kiroCliFailure("")).toBeUndefined();
  });
});

describe("kiroPromptFailure", () => {
  it("turns a logged-out or half-installed CLI exit into the setup message", () => {
    const exited = new EffectAcpErrors.AcpProcessExitedError({
      code: 1,
      stderr: "error: You are not logged in, please log in with kiro-cli login",
    });
    expect(kiroPromptFailure(exited).message).toContain("kiro-cli login");
    const wrapped = new EffectAcpErrors.AcpTransportError({
      detail: "ACP process exited",
      cause: new EffectAcpErrors.AcpProcessExitedError({
        code: 1,
        stderr: "error: failed to launch /Users/dev/.local/bin/kiro-cli-chat",
      }),
    });
    expect(kiroPromptFailure(wrapped).message).toContain("kiro-cli setup");
  });

  it("keeps other request errors as provider errors with the agent's message", () => {
    const failure = kiroPromptFailure(
      new EffectAcpErrors.AcpRequestError({ code: -32603, errorMessage: "Internal error" }),
    );
    expect(failure.class).toBe("provider_error");
    expect(failure.message).toBe("Internal error");
    expect(failure.code).toBe("-32603");
  });
});
