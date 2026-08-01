import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as EffectAcpErrors from "effect-acp/errors";

import { ProviderInstanceId } from "@t3tools/contracts";

import {
  applyGrokAcpModelSelection,
  buildGrokAcpSpawnInput,
  grokAcpRuntimeProcessOwnership,
  grokReasoningEffortConstraintsFromCapabilities,
  isValidGrokReasoningEffortToken,
  resolveGrokAcpBaseModelId,
  resolveGrokReasoningEffortForSpawn,
  resolveGrokSpawnOptionValue,
} from "./GrokAcpSupport.ts";

describe("grokAcpRuntimeProcessOwnership", () => {
  it("opts Grok into detached process-tree ownership on the injected host platform", () => {
    expect(grokAcpRuntimeProcessOwnership("linux")).toEqual({
      ownDescendantProcessGroups: true,
      ownDetachedProcessGroup: true,
      processGroupPlatform: "linux",
    });
  });

  it("uses the prior provider-group path on Darwin and Windows", () => {
    expect(grokAcpRuntimeProcessOwnership("darwin")).toEqual({
      ownDescendantProcessGroups: false,
      ownDetachedProcessGroup: true,
      processGroupPlatform: "darwin",
    });
    expect(grokAcpRuntimeProcessOwnership("win32")).toEqual({
      ownDescendantProcessGroups: false,
      ownDetachedProcessGroup: true,
      processGroupPlatform: "win32",
    });
  });
});

describe("resolveGrokAcpBaseModelId", () => {
  it("normalizes empty and custom Grok model ids", () => {
    expect(resolveGrokAcpBaseModelId(undefined)).toBe("grok-build");
    expect(resolveGrokAcpBaseModelId("   ")).toBe("grok-build");
    expect(resolveGrokAcpBaseModelId("  grok-test-custom-model  ")).toBe("grok-test-custom-model");
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

  it("passes the reasoning effort as an agent spawn flag when selected", () => {
    const spawn = buildGrokAcpSpawnInput(null, "/tmp/project", {}, "low");

    expect(spawn.command).toBe("grok");
    expect(spawn.args).toEqual(["agent", "--reasoning-effort", "low", "stdio"]);
  });

  it("omits the reasoning effort flag when no effort is selected", () => {
    const spawn = buildGrokAcpSpawnInput(null, "/tmp/project", {}, undefined);

    expect(spawn.args).toEqual(["agent", "stdio"]);
  });
});

describe("isValidGrokReasoningEffortToken", () => {
  it("accepts CLI-safe current and future token shapes", () => {
    for (const token of ["low", "medium", "high", "xhigh", "turbo_v2", "max.2", "A1"]) {
      expect(isValidGrokReasoningEffortToken(token)).toBe(true);
    }
  });

  it("rejects empty, spaced, leading-dash, and overlong tokens", () => {
    for (const token of ["", "not a token", "-leading-dash", "x".repeat(33)]) {
      expect(isValidGrokReasoningEffortToken(token)).toBe(false);
    }
  });
});

describe("resolveGrokReasoningEffortForSpawn", () => {
  const instanceId = ProviderInstanceId.make("grok");

  it("returns the selected effort for canonical levels", () => {
    for (const effort of ["low", "medium", "high"]) {
      expect(
        resolveGrokReasoningEffortForSpawn({
          instanceId,
          model: "grok-4.5",
          options: [{ id: "reasoningEffort", value: effort }],
        }),
      ).toBe(effort);
    }
  });

  it("passes through well-formed menu ids it does not recognize", () => {
    // The agent clamps levels outside the model's menu to the model default
    // itself, and future menus may advertise new ids.
    expect(
      resolveGrokReasoningEffortForSpawn({
        instanceId,
        model: "grok-4.5",
        options: [{ id: "reasoningEffort", value: "xhigh" }],
      }),
    ).toBe("xhigh");
    expect(
      resolveGrokReasoningEffortForSpawn({
        instanceId,
        model: "grok-4.5",
        options: [{ id: "reasoningEffort", value: "turbo_v2" }],
      }),
    ).toBe("turbo_v2");
  });

  it("uses the advertised menu to accept future values and normalize stale ones", () => {
    const constraints = grokReasoningEffortConstraintsFromCapabilities({
      optionDescriptors: [
        {
          id: "reasoningEffort",
          label: "Reasoning",
          type: "select",
          options: [
            { id: "high", label: "High", isDefault: true },
            { id: "turbo_v2", label: "Turbo V2" },
          ],
          currentValue: "high",
        },
      ],
    });
    expect(constraints).toEqual({ values: ["high", "turbo_v2"], defaultValue: "high" });
    expect(
      resolveGrokReasoningEffortForSpawn(
        {
          instanceId,
          model: "grok-4.5",
          options: [{ id: "reasoningEffort", value: "turbo_v2" }],
        },
        constraints,
      ),
    ).toBe("turbo_v2");
    expect(
      resolveGrokReasoningEffortForSpawn(
        {
          instanceId,
          model: "grok-4.5",
          options: [{ id: "reasoningEffort", value: "ultra" }],
        },
        constraints,
      ),
    ).toBe("high");
  });

  it("drops effort when the discovered model advertises no menu", () => {
    expect(
      resolveGrokReasoningEffortForSpawn(
        {
          instanceId,
          model: "grok-4.5",
          options: [{ id: "reasoningEffort", value: "high" }],
        },
        null,
      ),
    ).toBeUndefined();
  });

  it("drops malformed or non-string stored efforts", () => {
    for (const value of ["not a token", "-leading-dash", "x".repeat(33), "", "  "]) {
      expect(
        resolveGrokReasoningEffortForSpawn({
          instanceId,
          model: "grok-4.5",
          options: [{ id: "reasoningEffort", value }],
        }),
      ).toBeUndefined();
    }
    expect(
      resolveGrokReasoningEffortForSpawn({
        instanceId,
        model: "grok-4.5",
        options: [{ id: "reasoningEffort", value: true }],
      }),
    ).toBeUndefined();
  });

  it("returns undefined when the selection has no effort option", () => {
    expect(resolveGrokReasoningEffortForSpawn(undefined)).toBeUndefined();
    expect(resolveGrokReasoningEffortForSpawn({ instanceId, model: "grok-4.5" })).toBeUndefined();
    expect(
      resolveGrokReasoningEffortForSpawn({
        instanceId,
        model: "grok-4.5",
        options: [{ id: "serviceTier", value: "fast" }],
      }),
    ).toBeUndefined();
  });
});

describe("resolveGrokSpawnOptionValue", () => {
  const instanceId = ProviderInstanceId.make("grok");

  it("treats absent Grok 4.5 effort as the verified High default", () => {
    expect(resolveGrokSpawnOptionValue({ instanceId, model: "grok-4.5" }, "reasoningEffort")).toBe(
      "high",
    );
    expect(
      resolveGrokSpawnOptionValue(
        {
          instanceId,
          model: "grok-4.5",
          options: [{ id: "reasoningEffort", value: "low" }],
        },
        "reasoningEffort",
      ),
    ).toBe("low");
  });

  it("does not invent a default for other Grok models", () => {
    expect(
      resolveGrokSpawnOptionValue({ instanceId, model: "grok-build" }, "reasoningEffort"),
    ).toBeUndefined();
  });

  it("uses the advertised default for unsupported stored values", () => {
    expect(
      resolveGrokSpawnOptionValue(
        {
          instanceId,
          model: "grok-4.5",
          options: [{ id: "reasoningEffort", value: "ultra" }],
        },
        "reasoningEffort",
        { values: ["high", "turbo_v2"], defaultValue: "high" },
      ),
    ).toBe("high");
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
