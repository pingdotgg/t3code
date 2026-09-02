import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as EffectAcpErrors from "effect-acp/errors";

import { applyHermesAcpModelSelection, buildHermesAcpSpawnInput } from "./HermesAcpSupport.ts";

describe("buildHermesAcpSpawnInput", () => {
  it("spawns the configured binary with the acp subcommand", () => {
    const spawn = buildHermesAcpSpawnInput({ binaryPath: "/opt/hermes" }, "/tmp/project", {
      PATH: "/usr/bin",
    });

    expect(spawn).toEqual({
      command: "/opt/hermes",
      args: ["acp"],
      cwd: "/tmp/project",
      env: {
        PATH: "/usr/bin",
      },
    });
  });

  it("falls back to the default binary name", () => {
    const spawn = buildHermesAcpSpawnInput({ binaryPath: "" }, "/tmp/project");
    expect(spawn.command).toBe("hermes");
  });

  it("falls back when settings are absent", () => {
    const spawn = buildHermesAcpSpawnInput(null, "/tmp/project");
    expect(spawn.command).toBe("hermes");
  });

  it("omits env entirely when no environment is provided", () => {
    const spawn = buildHermesAcpSpawnInput({ binaryPath: "/opt/hermes" }, "/tmp/project");
    expect(spawn).toEqual({
      command: "/opt/hermes",
      args: ["acp"],
      cwd: "/tmp/project",
    });
  });
});

describe("applyHermesAcpModelSelection", () => {
  it.effect("passes the model id to session/set_model verbatim", () =>
    Effect.gen(function* () {
      const modelCalls: Array<string> = [];
      const runtime = {
        setSessionModel: (modelId: string) =>
          Effect.sync(() => {
            modelCalls.push(modelId);
            return {};
          }),
      };

      yield* applyHermesAcpModelSelection({
        runtime,
        currentModelId: "anthropic:claude-opus-5",
        model: "anthropic:claude-fable-5",
        mapError: ({ cause }) => `failed to set model: ${cause.message}`,
      });

      expect(modelCalls).toEqual(["anthropic:claude-fable-5"]);
    }),
  );

  it.effect("skips session/set_model when the session is already on the model", () =>
    Effect.gen(function* () {
      const modelCalls: Array<string> = [];
      const runtime = {
        setSessionModel: (modelId: string) =>
          Effect.sync(() => {
            modelCalls.push(modelId);
            return {};
          }),
      };

      yield* applyHermesAcpModelSelection({
        runtime,
        currentModelId: "anthropic:claude-fable-5",
        model: "anthropic:claude-fable-5",
        mapError: ({ cause }) => `failed to set model: ${cause.message}`,
      });

      expect(modelCalls).toEqual([]);
    }),
  );

  it.effect("maps set_model failures through mapError", () =>
    Effect.gen(function* () {
      const acpFailure = new EffectAcpErrors.AcpTransportError({
        detail: "set_model exploded",
        cause: new Error("set_model exploded"),
      });
      const runtime = {
        setSessionModel: () => Effect.fail(acpFailure),
      };

      const failure = yield* Effect.flip(
        applyHermesAcpModelSelection({
          runtime,
          currentModelId: undefined,
          model: "anthropic:claude-fable-5",
          mapError: ({ cause }) => ({ mapped: true as const, cause }),
        }),
      );

      expect(failure).toEqual({ mapped: true, cause: acpFailure });
    }),
  );
});
