import { describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as EffectAcpErrors from "effect-acp/errors";

import {
  applyGrokAcpModelSelection,
  applyGrokAcpSessionMode,
  buildGrokAcpSpawnInput,
  GROK_REASONING_EFFORT_OPTION_ID,
  grokReasoningEffortCapabilities,
  isGrokAcpAuthFailure,
  parseGrokAcpModelMeta,
  grokDiscoveredModelCapabilities,
  advertisedGrokReasoningEffortsForModel,
  requestedGrokReasoningEffort,
  resolveGrokAcpBaseModelId,
  resolveGrokSessionModeId,
  resolveGrokSessionModelId,
} from "./GrokAcpSupport.ts";
import { ProviderInstanceId } from "@t3tools/contracts";

describe("resolveGrokAcpBaseModelId", () => {
  it("normalizes empty and custom Grok model ids", () => {
    expect(resolveGrokAcpBaseModelId(undefined)).toBe("grok-build");
    expect(resolveGrokAcpBaseModelId("   ")).toBe("grok-build");
    expect(resolveGrokAcpBaseModelId("  grok-test-custom-model  ")).toBe("grok-test-custom-model");
  });
});

describe("resolveGrokSessionModelId", () => {
  it("keeps a live ACP model id", () => {
    expect(
      resolveGrokSessionModelId({
        requested: "grok-4.5",
        current: "grok-4.6",
        availableIds: ["grok-4.6", "grok-4.5"],
      }),
    ).toBe("grok-4.5");
  });

  it("aliases grok-build onto the current live model", () => {
    expect(
      resolveGrokSessionModelId({
        requested: "grok-build",
        current: "grok-4.6",
        availableIds: ["grok-4.6", "grok-4.5"],
      }),
    ).toBe("grok-4.6");
  });

  it("falls back to the first advertised model when current is missing", () => {
    expect(
      resolveGrokSessionModelId({
        requested: "grok-build",
        current: undefined,
        availableIds: ["grok-4.5", "grok-4.6"],
      }),
    ).toBe("grok-4.5");
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

  it("puts --reasoning-effort before stdio", () => {
    const spawn = buildGrokAcpSpawnInput({ binaryPath: "grok" }, "/tmp/project", undefined, "high");
    expect(spawn.args).toEqual(["agent", "--reasoning-effort", "high", "stdio"]);
  });

  it("ignores spawn effort values the CLI rejects", () => {
    const spawn = buildGrokAcpSpawnInput({ binaryPath: "grok" }, "/tmp/project", undefined, "max");
    expect(spawn.args).toEqual(["agent", "stdio"]);
  });
});

describe("parseGrokAcpModelMeta", () => {
  it("reads the live Grok effort menu", () => {
    const meta = parseGrokAcpModelMeta({
      supportsReasoningEffort: true,
      reasoningEffort: "high",
      totalContextTokens: 500000,
      reasoningEfforts: [
        { id: "xhigh", value: "xhigh", label: "Extra High Effort", default: true },
        { id: "high", value: "high", label: "High Effort", default: true },
        { id: "medium", value: "medium", label: "Medium Effort" },
      ],
    });
    expect(meta.supportsReasoningEffort).toBe(true);
    expect(meta.reasoningEffort).toBe("high");
    expect(meta.totalContextTokens).toBe(500000);
    expect(meta.reasoningEfforts.map((choice) => choice.id)).toEqual(["xhigh", "high", "medium"]);
    expect(
      meta.reasoningEfforts.filter((choice) => choice.isDefault).map((choice) => choice.id),
    ).toEqual(["high"]);
    expect(grokReasoningEffortCapabilities(meta.reasoningEfforts).optionDescriptors?.[0]?.id).toBe(
      GROK_REASONING_EFFORT_OPTION_ID,
    );
  });
});

describe("requestedGrokReasoningEffort", () => {
  it("drops effort values the current model does not advertise", () => {
    expect(
      requestedGrokReasoningEffort(
        {
          instanceId: ProviderInstanceId.make("grok"),
          model: "grok-4.5",
          options: [{ id: GROK_REASONING_EFFORT_OPTION_ID, value: "xhigh" }],
        },
        ["high", "medium", "low"],
      ),
    ).toBeUndefined();
  });

  it("keeps spawnable effort before the ACP menu is known", () => {
    expect(
      requestedGrokReasoningEffort(
        {
          instanceId: ProviderInstanceId.make("grok"),
          model: "grok-build",
          options: [{ id: GROK_REASONING_EFFORT_OPTION_ID, value: "xhigh" }],
        },
        [],
      ),
    ).toBe("xhigh");
  });
});

describe("advertisedGrokReasoningEffortsForModel", () => {
  const liveMenu = ["xhigh", "high", "medium"] as const;
  const menus = new Map<string, ReadonlyArray<string>>([
    ["grok-4.6", [...liveMenu]],
    ["grok-4.5", ["high", "medium", "low"]],
  ]);

  it("resolves grok-build onto the live ACP model's effort menu", () => {
    expect(
      advertisedGrokReasoningEffortsForModel({
        menus,
        requestedModelId: "grok-build",
        currentModelId: "grok-4.6",
        availableModelIds: ["grok-4.6", "grok-4.5"],
      }),
    ).toEqual([...liveMenu]);
  });

  it("uses the requested live model menu instead of spawnable fallback", () => {
    const advertised = advertisedGrokReasoningEffortsForModel({
      menus,
      requestedModelId: "grok-4.5",
      currentModelId: "grok-4.6",
      availableModelIds: ["grok-4.6", "grok-4.5"],
    });
    expect(advertised).toEqual(["high", "medium", "low"]);
    expect(
      requestedGrokReasoningEffort(
        {
          instanceId: ProviderInstanceId.make("grok"),
          model: "grok-4.5",
          options: [{ id: GROK_REASONING_EFFORT_OPTION_ID, value: "xhigh" }],
        },
        advertised,
      ),
    ).toBeUndefined();
  });

  it("keeps live-model-only efforts when the composer still says grok-build", () => {
    const advertised = advertisedGrokReasoningEffortsForModel({
      menus: new Map([["grok-4.6", ["max", "high"]]]),
      requestedModelId: "grok-build",
      currentModelId: "grok-4.6",
      availableModelIds: ["grok-4.6"],
    });
    expect(
      requestedGrokReasoningEffort(
        {
          instanceId: ProviderInstanceId.make("grok"),
          model: "grok-build",
          options: [{ id: GROK_REASONING_EFFORT_OPTION_ID, value: "max" }],
        },
        advertised,
      ),
    ).toBe("max");
  });
});

describe("grokDiscoveredModelCapabilities", () => {
  it("hides Reasoning when the model does not support effort", () => {
    expect(
      grokDiscoveredModelCapabilities({
        supportsReasoningEffort: false,
        reasoningEfforts: [],
      }).optionDescriptors,
    ).toEqual([]);
  });

  it("falls back to the default menu when support is advertised without choices", () => {
    expect(
      grokDiscoveredModelCapabilities({
        supportsReasoningEffort: true,
        reasoningEfforts: [],
      }).optionDescriptors?.[0]?.id,
    ).toBe(GROK_REASONING_EFFORT_OPTION_ID);
  });
});

describe("isGrokAcpAuthFailure", () => {
  it("recognizes tagged authenticate and auth-required failures", () => {
    expect(
      isGrokAcpAuthFailure(
        Cause.fail(
          new EffectAcpErrors.AcpRequestError({
            code: -32600,
            errorMessage: "authenticate rejected",
            method: "authenticate",
          }),
        ),
      ),
    ).toBe(true);
    expect(isGrokAcpAuthFailure(Cause.fail(EffectAcpErrors.AcpRequestError.authRequired()))).toBe(
      true,
    );
  });

  it("does not treat payload text or other ACP methods as auth failure", () => {
    expect(isGrokAcpAuthFailure(Cause.fail(new Error("authenticate failed: cached_token")))).toBe(
      false,
    );
    expect(
      isGrokAcpAuthFailure(
        Cause.fail(
          new EffectAcpErrors.AcpRequestError({
            code: -32603,
            errorMessage: "session/new timed out",
            method: "session/new",
          }),
        ),
      ),
    ).toBe(false);
  });
});

describe("applyGrokAcpModelSelection", () => {
  const makeRecordingRuntime = (failure?: EffectAcpErrors.AcpError) => {
    const modelCalls: Array<{ modelId: string; effort?: string }> = [];
    const runtime = {
      setSessionModel: (
        modelId: string,
        options?: { readonly _meta?: { readonly [x: string]: unknown } },
      ) =>
        Effect.gen(function* () {
          const effort = options?._meta?.reasoningEffort;
          modelCalls.push({
            modelId,
            ...(typeof effort === "string" ? { effort } : {}),
          });
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
      expect(result).toEqual({ modelId: "grok-mock-alt", reasoningEffort: undefined });
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
      expect(result).toEqual({ modelId: "grok-build", reasoningEffort: undefined });
    }),
  );

  it.effect("does not send grok-build to session/set_model when the live menu has real ids", () =>
    Effect.gen(function* () {
      const { runtime, modelCalls } = makeRecordingRuntime();
      const result = yield* applyGrokAcpModelSelection({
        runtime,
        currentModelId: "grok-4.6",
        requestedModelId: "grok-build",
        availableModelIds: ["grok-4.6", "grok-4.5"],
        mapError: (cause) => cause.message,
      });
      expect(modelCalls).toEqual([]);
      expect(result).toEqual({ modelId: "grok-4.6", reasoningEffort: undefined });
    }),
  );

  it.effect("does not carry the previous effort across a model switch", () =>
    Effect.gen(function* () {
      const { runtime, modelCalls } = makeRecordingRuntime();
      const result = yield* applyGrokAcpModelSelection({
        runtime,
        currentModelId: "grok-4.6",
        requestedModelId: "grok-4.5",
        currentReasoningEffort: "xhigh",
        mapError: (cause) => cause.message,
      });
      expect(modelCalls).toEqual([{ modelId: "grok-4.5" }]);
      expect(result).toEqual({ modelId: "grok-4.5", reasoningEffort: undefined });
    }),
  );

  it.effect("calls session/set_model when only effort changes", () =>
    Effect.gen(function* () {
      const { runtime, modelCalls } = makeRecordingRuntime();
      const result = yield* applyGrokAcpModelSelection({
        runtime,
        currentModelId: "grok-4.6",
        requestedModelId: "grok-4.6",
        currentReasoningEffort: "high",
        requestedReasoningEffort: "xhigh",
        mapError: (cause) => cause.message,
      });
      expect(modelCalls).toEqual([{ modelId: "grok-4.6", effort: "xhigh" }]);
      expect(result).toEqual({ modelId: "grok-4.6", reasoningEffort: "xhigh" });
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
      expect(result).toEqual({ modelId: "grok-build", reasoningEffort: undefined });
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

const grokModes = {
  currentModeId: "ask",
  availableModes: [
    { id: "ask", name: "Ask" },
    { id: "architect", name: "Architect" },
    { id: "code", name: "Code" },
  ],
};

describe("resolveGrokSessionModeId", () => {
  it("maps plan onto architect when that is the advertised plan mode", () => {
    expect(
      resolveGrokSessionModeId({
        interactionMode: "plan",
        runtimeMode: "full-access",
        modeState: grokModes,
      }),
    ).toBe("architect");
  });

  it("maps default onto code", () => {
    expect(
      resolveGrokSessionModeId({
        interactionMode: "default",
        runtimeMode: "full-access",
        modeState: grokModes,
      }),
    ).toBe("code");
  });

  it("leaves the mode alone when the user did not pick one", () => {
    expect(
      resolveGrokSessionModeId({
        interactionMode: undefined,
        runtimeMode: "full-access",
        modeState: grokModes,
      }),
    ).toBeUndefined();
  });
});

describe("applyGrokAcpSessionMode", () => {
  it.effect("calls setMode when plan is requested", () =>
    Effect.gen(function* () {
      const modeCalls: string[] = [];
      yield* applyGrokAcpSessionMode({
        runtime: {
          getModeState: Effect.succeed(grokModes),
          setMode: (modeId) =>
            Effect.sync(() => {
              modeCalls.push(modeId);
              return {};
            }),
        },
        runtimeMode: "full-access",
        interactionMode: "plan",
        mapError: (cause) => cause.message,
      });
      expect(modeCalls).toEqual(["architect"]);
    }),
  );

  it.effect("skips setMode when the session has no matching mode", () =>
    Effect.gen(function* () {
      const modeCalls: string[] = [];
      yield* applyGrokAcpSessionMode({
        runtime: {
          getModeState: Effect.succeed(undefined),
          setMode: (modeId) =>
            Effect.sync(() => {
              modeCalls.push(modeId);
              return {};
            }),
        },
        runtimeMode: "full-access",
        interactionMode: "plan",
        mapError: (cause) => cause.message,
      });
      expect(modeCalls).toEqual([]);
    }),
  );
});
