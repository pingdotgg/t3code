import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type * as EffectAcpErrors from "effect-acp/errors";

import {
  applyAuggieAcpModelSelection,
  auggieAcpSpawnArgs,
  buildAuggieAcpSpawnInput,
  resolveAuggieAcpBaseModelId,
} from "./AuggieAcpSupport.ts";

describe("auggieAcpSpawnArgs", () => {
  it("answers the indexing consent prompt at spawn by default", () => {
    expect(auggieAcpSpawnArgs(undefined)).toEqual(["--acp", "--allow-indexing"]);
    expect(auggieAcpSpawnArgs({ binaryPath: "", allowIndexing: true })).toEqual([
      "--acp",
      "--allow-indexing",
    ]);
  });

  it("lets the indexing request reach T3's approval flow when indexing is off", () => {
    expect(auggieAcpSpawnArgs({ binaryPath: "", allowIndexing: false })).toEqual(["--acp"]);
  });
});

describe("buildAuggieAcpSpawnInput", () => {
  it("uses the configured binary and leaves the workspace to session/new", () => {
    const spawn = buildAuggieAcpSpawnInput(
      { binaryPath: "/usr/local/bin/auggie", allowIndexing: true },
      "/tmp/project",
      { AUGMENT_SESSION_AUTH: "secret" },
    );

    expect(spawn).toEqual({
      command: "/usr/local/bin/auggie",
      args: ["--acp", "--allow-indexing"],
      cwd: "/tmp/project",
      env: { AUGMENT_SESSION_AUTH: "secret" },
    });
    expect(spawn.args).not.toContain("--workspace-root");
  });

  it("falls back to the CLI name when no binary path is configured", () => {
    expect(buildAuggieAcpSpawnInput(null, "/tmp/project").command).toBe("auggie");
  });
});

describe("resolveAuggieAcpBaseModelId", () => {
  it("falls back to the product sentinel for empty selections", () => {
    expect(resolveAuggieAcpBaseModelId(undefined)).toBe("auggie-default");
    expect(resolveAuggieAcpBaseModelId("   ")).toBe("auggie-default");
  });

  it("passes real ACP model ids through untouched", () => {
    expect(resolveAuggieAcpBaseModelId("  claude-opus-5  ")).toBe("claude-opus-5");
    expect(resolveAuggieAcpBaseModelId("butler_a")).toBe("butler_a");
  });
});

describe("applyAuggieAcpModelSelection", () => {
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

  it.effect("switches the session when the requested model differs", () =>
    Effect.gen(function* () {
      const { runtime, modelCalls } = makeRecordingRuntime();
      const result = yield* applyAuggieAcpModelSelection({
        runtime,
        currentModelId: "claude-opus-5",
        requestedModelId: "claude-haiku-4-5",
        mapError: (cause) => cause.message,
      });
      expect(modelCalls).toEqual(["claude-haiku-4-5"]);
      expect(result).toBe("claude-haiku-4-5");
    }),
  );

  it.effect("never sends the product sentinel over the wire", () =>
    Effect.gen(function* () {
      const { runtime, modelCalls } = makeRecordingRuntime();
      const result = yield* applyAuggieAcpModelSelection({
        runtime,
        currentModelId: "claude-opus-5",
        requestedModelId: "auggie-default",
        mapError: (cause) => cause.message,
      });
      expect(modelCalls).toEqual([]);
      expect(result).toBe("claude-opus-5");
    }),
  );

  it.effect("skips the round trip when the session already runs the model", () =>
    Effect.gen(function* () {
      const { runtime, modelCalls } = makeRecordingRuntime();
      const result = yield* applyAuggieAcpModelSelection({
        runtime,
        currentModelId: "claude-opus-5",
        requestedModelId: "claude-opus-5",
        mapError: (cause) => cause.message,
      });
      expect(modelCalls).toEqual([]);
      expect(result).toBe("claude-opus-5");
    }),
  );
});
