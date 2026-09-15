import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as EffectAcpErrors from "effect-acp/errors";

import {
  applyKiroAcpModelSelection,
  buildKiroAcpSpawnInput,
  kiroAcpSpawnArgs,
  resolveKiroAcpBaseModelId,
} from "./KiroAcpSupport.ts";

describe("resolveKiroAcpBaseModelId", () => {
  it("falls back to Kiro's auto routing and trims custom ids", () => {
    expect(resolveKiroAcpBaseModelId(undefined)).toBe("auto");
    expect(resolveKiroAcpBaseModelId("   ")).toBe("auto");
    expect(resolveKiroAcpBaseModelId("  claude-sonnet-5  ")).toBe("claude-sonnet-5");
  });
});

describe("kiroAcpSpawnArgs", () => {
  it("starts the ACP agent with Kiro's own trust settings by default", () => {
    expect(kiroAcpSpawnArgs(undefined)).toEqual(["acp"]);
    expect(kiroAcpSpawnArgs({ binaryPath: "", agent: "" }, "approval-required")).toEqual(["acp"]);
    expect(kiroAcpSpawnArgs(undefined, "auto-accept-edits")).toEqual(["acp"]);
    expect(kiroAcpSpawnArgs(undefined, "auto")).toEqual(["acp"]);
  });

  it("trusts every tool natively for Full access", () => {
    expect(kiroAcpSpawnArgs(undefined, "full-access")).toEqual(["acp", "--trust-all-tools"]);
  });

  it("selects the configured agent", () => {
    expect(kiroAcpSpawnArgs({ binaryPath: "", agent: " kiro_planner " }, "full-access")).toEqual([
      "acp",
      "--agent",
      "kiro_planner",
      "--trust-all-tools",
    ]);
  });

  it("trusts no tools for text generation even in Full access", () => {
    expect(kiroAcpSpawnArgs(undefined, "full-access", { trustNoTools: true })).toEqual([
      "acp",
      "--trust-tools=",
    ]);
  });
});

describe("buildKiroAcpSpawnInput", () => {
  it("uses the configured binary and passes the environment through untouched", () => {
    expect(
      buildKiroAcpSpawnInput({ binaryPath: "/opt/kiro/kiro-cli", agent: "" }, "/tmp/project", {
        HOME: "/Users/dev",
      }),
    ).toEqual({
      command: "/opt/kiro/kiro-cli",
      args: ["acp"],
      cwd: "/tmp/project",
      env: { HOME: "/Users/dev" },
    });
  });

  it("defaults to kiro-cli on PATH", () => {
    expect(buildKiroAcpSpawnInput(undefined, "/tmp/project").command).toBe("kiro-cli");
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

  it.effect("calls session/set_model when the requested model differs from current", () =>
    Effect.gen(function* () {
      const { runtime, modelCalls } = makeRecordingRuntime();
      const result = yield* applyKiroAcpModelSelection({
        runtime,
        currentModelId: "auto",
        requestedModelId: "claude-sonnet-5",
        mapError: (cause) => cause.message,
      });
      expect(modelCalls).toEqual(["claude-sonnet-5"]);
      expect(result).toBe("claude-sonnet-5");
    }),
  );

  it.effect("skips the RPC when the model is unchanged or unspecified", () =>
    Effect.gen(function* () {
      const { runtime, modelCalls } = makeRecordingRuntime();
      expect(
        yield* applyKiroAcpModelSelection({
          runtime,
          currentModelId: "auto",
          requestedModelId: "auto",
          mapError: (cause) => cause.message,
        }),
      ).toBe("auto");
      expect(
        yield* applyKiroAcpModelSelection({
          runtime,
          currentModelId: "auto",
          requestedModelId: undefined,
          mapError: (cause) => cause.message,
        }),
      ).toBe("auto");
      expect(modelCalls).toEqual([]);
    }),
  );

  it.effect("maps set_model failures through mapError", () =>
    Effect.gen(function* () {
      const { runtime } = makeRecordingRuntime(
        new EffectAcpErrors.AcpRequestError({ code: -32602, errorMessage: "unknown model" }),
      );
      const error = yield* applyKiroAcpModelSelection({
        runtime,
        currentModelId: "auto",
        requestedModelId: "nope",
        mapError: (cause) => `mapped: ${cause.message}`,
      }).pipe(Effect.flip);
      expect(error).toContain("mapped:");
    }),
  );
});
