import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import {
  advertisedKimiModelIdsFromSessionSetup,
  applyKimiAcpModeSelection,
  applyKimiAcpModelSelection,
  applyKimiAcpThinkingSelection,
  buildKimiAcpSpawnInput,
  classifyKimiPermissionRequest,
  currentKimiModeIdFromSessionSetup,
  currentKimiModelIdFromSessionSetup,
  extractKimiProposedPlanMarkdown,
  findKimiModelConfigOption,
  findKimiThinkingConfigOption,
  isKimiAuthRequiredError,
  kimiConfigOptionsFromSessionNotification,
  kimiModelStateFromSessionSetup,
  kimiPermissionRequestDetail,
  kimiSessionHasModelConfigOption,
  resolveKimiAcpBaseModelId,
  resolveKimiAcpModeId,
  resolveKimiAcpWireModelId,
  resolveKimiThinkingSelection,
  shouldKimiAdapterAutoApprove,
} from "./KimiAcpSupport.ts";

const configOptionSession = {
  sessionId: "session-1",
  configOptions: [
    {
      id: "chosen-model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: "kimi-code/k3",
      options: [
        { value: "kimi-code/k3", name: "K3" },
        { value: "kimi-code/kimi-for-coding", name: "K2.7 Coding" },
        { value: "moonshot-ai/kimi-k3", name: "kimi-k3" },
      ],
    },
    {
      id: "permission-mode",
      name: "Mode",
      category: "mode",
      type: "select",
      currentValue: "default",
      options: [
        { value: "default", name: "Default" },
        { value: "plan", name: "Plan" },
        { value: "auto", name: "Auto" },
        { value: "yolo", name: "YOLO" },
      ],
    },
  ],
} satisfies EffectAcpSchema.NewSessionResponse;

function thinkingConfigOptions(
  values: ReadonlyArray<string>,
  currentValue: string,
): ReadonlyArray<EffectAcpSchema.SessionConfigOption> {
  return [
    {
      id: "thinking",
      name: "Thinking",
      category: "thought_level",
      type: "select",
      currentValue,
      options: values.map((value) => ({ value, name: value.toUpperCase() })),
    },
  ];
}

describe("resolveKimiAcpBaseModelId", () => {
  it("normalizes empty and custom Kimi model ids", () => {
    expect(resolveKimiAcpBaseModelId(undefined)).toBe("k3");
    expect(resolveKimiAcpBaseModelId("   ")).toBe("k3");
    expect(resolveKimiAcpBaseModelId("  kimi-for-coding  ")).toBe("kimi-for-coding");
  });

  it("strips the ,thinking variant suffix to the base model id", () => {
    expect(resolveKimiAcpBaseModelId("k3,thinking")).toBe("k3");
    expect(resolveKimiAcpBaseModelId("kimi-for-coding , thinking")).toBe("kimi-for-coding");
  });

  it("strips the kimi-code/ namespace prefix used by config.toml aliases", () => {
    expect(resolveKimiAcpBaseModelId("kimi-code/k3")).toBe("k3");
    expect(resolveKimiAcpBaseModelId("kimi-code/k3,thinking")).toBe("k3");
    expect(resolveKimiAcpBaseModelId("moonshot-ai/kimi-k3")).toBe("moonshot-ai/kimi-k3");
  });
});

describe("kimiModelStateFromSessionSetup", () => {
  it("discovers exact model wire ids from a category-based select option", () => {
    const modelConfig = findKimiModelConfigOption(configOptionSession.configOptions);
    const modelState = kimiModelStateFromSessionSetup(configOptionSession);

    expect(modelConfig?.id).toBe("chosen-model");
    expect(modelState).toEqual({
      currentModelId: "kimi-code/k3",
      availableModels: [
        { modelId: "kimi-code/k3", name: "K3" },
        { modelId: "kimi-code/kimi-for-coding", name: "K2.7 Coding" },
        { modelId: "moonshot-ai/kimi-k3", name: "kimi-k3" },
      ],
    });
    expect(advertisedKimiModelIdsFromSessionSetup(configOptionSession)).toEqual([
      "kimi-code/k3",
      "kimi-code/kimi-for-coding",
      "moonshot-ai/kimi-k3",
    ]);
    expect(currentKimiModelIdFromSessionSetup(configOptionSession)).toBe("kimi-code/k3");
    expect(kimiSessionHasModelConfigOption(configOptionSession)).toBe(true);
  });

  it("falls back to the legacy model state when no model config option is advertised", () => {
    const legacySession = {
      sessionId: "legacy-session",
      models: {
        currentModelId: "k3",
        availableModels: [
          { modelId: "k3", name: "K3" },
          { modelId: "kimi-for-coding", name: "K2.7 Coding" },
        ],
      },
    } satisfies EffectAcpSchema.NewSessionResponse;

    expect(kimiModelStateFromSessionSetup(legacySession)).toEqual(legacySession.models);
    expect(advertisedKimiModelIdsFromSessionSetup(legacySession)).toEqual([
      "k3",
      "kimi-for-coding",
    ]);
    expect(kimiSessionHasModelConfigOption(legacySession)).toBe(false);
  });
});

describe("Kimi ACP modes", () => {
  it("maps T3 runtime and interaction modes to native Kimi modes", () => {
    expect(currentKimiModeIdFromSessionSetup(configOptionSession)).toBe("default");
    expect(resolveKimiAcpModeId({ runtimeMode: "approval-required" })).toBe("default");
    expect(resolveKimiAcpModeId({ runtimeMode: "auto-accept-edits" })).toBe("auto");
    expect(resolveKimiAcpModeId({ runtimeMode: "auto" })).toBe("auto");
    expect(resolveKimiAcpModeId({ runtimeMode: "full-access" })).toBe("yolo");
    for (const runtimeMode of [
      "approval-required",
      "auto-accept-edits",
      "auto",
      "full-access",
    ] as const) {
      expect(resolveKimiAcpModeId({ runtimeMode, interactionMode: "plan" })).toBe("plan");
    }
  });

  it.effect("skips unchanged modes and restores the runtime-derived mode after plan", () =>
    Effect.gen(function* () {
      const modeCalls: Array<string> = [];
      const runtime = {
        setMode: (modeId: string) =>
          Effect.sync(() => {
            modeCalls.push(modeId);
            return {};
          }),
      };
      const unchanged = yield* applyKimiAcpModeSelection({
        runtime,
        currentModeId: "plan",
        requestedModeId: "plan",
        mapError: (cause) => cause.message,
      });
      const restored = yield* applyKimiAcpModeSelection({
        runtime,
        currentModeId: unchanged,
        requestedModeId: resolveKimiAcpModeId({
          runtimeMode: "full-access",
          interactionMode: "default",
        }),
        mapError: (cause) => cause.message,
      });
      expect(modeCalls).toEqual(["yolo"]);
      expect(restored).toBe("yolo");
    }),
  );

  it("auto-approves tool gates for full-access in any native mode, never user decisions", () => {
    // Full access answers Kimi's tool-gate requests itself, whatever the
    // tracked native mode is (including a stale plan mode left over from an
    // intercepted ExitPlanMode).
    expect(shouldKimiAdapterAutoApprove({ runtimeMode: "full-access" })).toBe(true);
    expect(shouldKimiAdapterAutoApprove({ runtimeMode: "full-access", requestKind: "tool" })).toBe(
      true,
    );
    // Plan decisions and user questions are user decisions, never auto-approved.
    expect(
      shouldKimiAdapterAutoApprove({ runtimeMode: "full-access", requestKind: "plan-decision" }),
    ).toBe(false);
    expect(
      shouldKimiAdapterAutoApprove({ runtimeMode: "full-access", requestKind: "user-question" }),
    ).toBe(false);
    // Non-full-access runtime modes keep the supervised behavior exactly.
    expect(shouldKimiAdapterAutoApprove({ runtimeMode: "approval-required" })).toBe(false);
    expect(shouldKimiAdapterAutoApprove({ runtimeMode: "auto-accept-edits" })).toBe(false);
    expect(shouldKimiAdapterAutoApprove({ runtimeMode: "auto" })).toBe(false);
  });
});

describe("Kimi thinking configuration", () => {
  it("resolves supported values and falls back stale selections to the advertised current value", () => {
    const k3 = thinkingConfigOptions(["low", "high", "max"], "high");
    const k27 = thinkingConfigOptions(["on", "high"], "high");

    expect(findKimiThinkingConfigOption(k3)?.id).toBe("thinking");
    expect(resolveKimiThinkingSelection({ configOptions: k3, requestedValue: "max" })).toEqual({
      configId: "thinking",
      currentValue: "high",
      selectedValue: "max",
      usedFallback: false,
    });
    expect(resolveKimiThinkingSelection({ configOptions: k27, requestedValue: "low" })).toEqual({
      configId: "thinking",
      currentValue: "high",
      selectedValue: "high",
      usedFallback: true,
    });
  });

  it.effect("skips fallback/current writes and applies supported thinking values", () =>
    Effect.gen(function* () {
      let configOptions = thinkingConfigOptions(["on", "high"], "high");
      const calls: Array<[string, string | boolean]> = [];
      const runtime = {
        setConfigOption: (configId: string, value: string | boolean) =>
          Effect.sync(() => {
            calls.push([configId, value]);
            configOptions = thinkingConfigOptions(["on", "high"], String(value));
            return { configOptions };
          }),
        getConfigOptions: Effect.sync(() => configOptions),
      };

      const fallback = yield* applyKimiAcpThinkingSelection({
        runtime,
        configOptions,
        requestedValue: "low",
        mapError: (cause) => cause.message,
      });
      expect(calls).toEqual([]);
      expect(fallback.resolution?.selectedValue).toBe("high");
      expect(fallback.resolution?.usedFallback).toBe(true);

      const applied = yield* applyKimiAcpThinkingSelection({
        runtime,
        configOptions: fallback.configOptions,
        requestedValue: "on",
        mapError: (cause) => cause.message,
      });
      expect(calls).toEqual([["thinking", "on"]]);
      expect(findKimiThinkingConfigOption(applied.configOptions)?.currentValue).toBe("on");
    }),
  );

  it("extracts config option updates from session notifications", () => {
    const configOptions = thinkingConfigOptions(["low", "high", "max"], "max");
    const notification = {
      sessionId: "session-1",
      update: {
        sessionUpdate: "config_option_update",
        configOptions,
      },
    } satisfies EffectAcpSchema.SessionNotification;

    expect(kimiConfigOptionsFromSessionNotification(notification)).toEqual(configOptions);
  });
});

describe("resolveKimiAcpWireModelId", () => {
  it("namespaces managed ids when nothing was advertised (Kimi Code CLI)", () => {
    expect(resolveKimiAcpWireModelId("k3")).toBe("kimi-code/k3");
    expect(resolveKimiAcpWireModelId("kimi-for-coding")).toBe("kimi-code/kimi-for-coding");
    expect(resolveKimiAcpWireModelId("moonshot-ai/kimi-k3")).toBe("moonshot-ai/kimi-k3");
    expect(resolveKimiAcpWireModelId("k3", [])).toBe("kimi-code/k3");
  });

  it("prefers a matching advertised id (kimi-cli advertises bare ids)", () => {
    expect(resolveKimiAcpWireModelId("k3", ["k3", "k3,thinking", "kimi-for-coding"])).toBe("k3");
    expect(resolveKimiAcpWireModelId("k3", ["k3,thinking", "k3"])).toBe("k3");
    expect(resolveKimiAcpWireModelId("k3", ["k3,thinking"])).toBe("k3,thinking");
    expect(resolveKimiAcpWireModelId("k3", ["kimi-code/k3", "kimi-code/kimi-for-coding"])).toBe(
      "kimi-code/k3",
    );
  });

  it("passes an unadvertised custom id through untouched", () => {
    expect(resolveKimiAcpWireModelId("my-custom-model", ["k3", "kimi-for-coding"])).toBe(
      "my-custom-model",
    );
  });
});

describe("buildKimiAcpSpawnInput", () => {
  it("spawns `kimi acp` with the configured binary", () => {
    const spawn = buildKimiAcpSpawnInput(
      { binaryPath: "/usr/local/bin/kimi", homePath: "" },
      "/tmp/project",
    );

    expect(spawn).toEqual({
      command: "/usr/local/bin/kimi",
      args: ["acp"],
      cwd: "/tmp/project",
    });
  });

  it("injects KIMI_CODE_HOME when a homePath is configured", () => {
    const spawn = buildKimiAcpSpawnInput(
      { binaryPath: "kimi", homePath: "/data/kimi-work" },
      "/tmp/project",
      { PATH: "/bin" },
    );

    expect(spawn).toEqual({
      command: "kimi",
      args: ["acp"],
      cwd: "/tmp/project",
      env: {
        PATH: "/bin",
        KIMI_CODE_HOME: "/data/kimi-work",
      },
    });
  });
});

describe("isKimiAuthRequiredError", () => {
  it("matches the RFC auth-required error code", () => {
    expect(isKimiAuthRequiredError(EffectAcpErrors.AcpRequestError.authRequired())).toBe(true);
  });

  it("matches failures from the authenticate request", () => {
    expect(
      isKimiAuthRequiredError(
        new EffectAcpErrors.AcpRequestError({
          code: -32603,
          errorMessage: "token missing",
          method: "authenticate",
        }),
      ),
    ).toBe(true);
  });

  it("rejects unrelated errors", () => {
    expect(
      isKimiAuthRequiredError(EffectAcpErrors.AcpRequestError.invalidParams("bad params")),
    ).toBe(false);
    expect(isKimiAuthRequiredError(new Error("nope"))).toBe(false);
  });
});

describe("applyKimiAcpModelSelection", () => {
  const makeRecordingRuntime = (stableFailure?: EffectAcpErrors.AcpError) => {
    const stableModelCalls: Array<string> = [];
    const fallbackModelCalls: Array<string> = [];
    const runtime = {
      setModel: (modelId: string) =>
        Effect.gen(function* () {
          stableModelCalls.push(modelId);
          if (stableFailure) return yield* stableFailure;
        }),
      setSessionModel: (modelId: string) =>
        Effect.sync(() => {
          fallbackModelCalls.push(modelId);
          return {};
        }),
    };
    return { runtime, stableModelCalls, fallbackModelCalls };
  };

  it.effect("uses setModel and the exact advertised wire id for model config sessions", () =>
    Effect.gen(function* () {
      const { runtime, stableModelCalls, fallbackModelCalls } = makeRecordingRuntime();
      const result = yield* applyKimiAcpModelSelection({
        runtime,
        currentModelId: "kimi-code/k3",
        requestedModelId: "kimi-for-coding",
        advertisedModelIds: ["kimi-code/k3", "kimi-code/kimi-for-coding"],
        hasModelConfigOption: true,
        mapError: (cause) => cause.message,
      });
      expect(stableModelCalls).toEqual(["kimi-code/kimi-for-coding"]);
      expect(fallbackModelCalls).toEqual([]);
      expect(result).toBe("kimi-for-coding");
    }),
  );

  it.effect("switches K3 to K2.7 and back through stable model configuration", () =>
    Effect.gen(function* () {
      const { runtime, stableModelCalls } = makeRecordingRuntime();
      const advertisedModelIds = ["kimi-code/k3", "kimi-code/kimi-for-coding"];
      const k27 = yield* applyKimiAcpModelSelection({
        runtime,
        currentModelId: "kimi-code/k3",
        requestedModelId: "kimi-for-coding",
        advertisedModelIds,
        hasModelConfigOption: true,
        mapError: (cause) => cause.message,
      });
      const k3 = yield* applyKimiAcpModelSelection({
        runtime,
        currentModelId: k27,
        requestedModelId: "k3",
        advertisedModelIds,
        hasModelConfigOption: true,
        mapError: (cause) => cause.message,
      });
      expect(stableModelCalls).toEqual(["kimi-code/kimi-for-coding", "kimi-code/k3"]);
      expect(k3).toBe("k3");
    }),
  );

  it.effect("falls back to session/set_model when stable model configuration is unsupported", () =>
    Effect.gen(function* () {
      const unsupported = EffectAcpErrors.AcpRequestError.methodNotFound(
        "session/set_config_option",
      );
      const { runtime, stableModelCalls, fallbackModelCalls } = makeRecordingRuntime(unsupported);
      const result = yield* applyKimiAcpModelSelection({
        runtime,
        currentModelId: "kimi-code/k3",
        requestedModelId: "kimi-for-coding",
        advertisedModelIds: ["kimi-code/k3", "kimi-code/kimi-for-coding"],
        hasModelConfigOption: true,
        mapError: (cause) => cause.message,
      });
      expect(stableModelCalls).toEqual(["kimi-code/kimi-for-coding"]);
      expect(fallbackModelCalls).toEqual(["kimi-code/kimi-for-coding"]);
      expect(result).toBe("kimi-for-coding");
    }),
  );

  it.effect("falls back to session/set_model for legacy model-state sessions", () =>
    Effect.gen(function* () {
      const { runtime, stableModelCalls, fallbackModelCalls } = makeRecordingRuntime();
      const result = yield* applyKimiAcpModelSelection({
        runtime,
        currentModelId: "k3",
        requestedModelId: "kimi-for-coding",
        advertisedModelIds: ["k3", "k3,thinking", "kimi-for-coding"],
        hasModelConfigOption: false,
        mapError: (cause) => cause.message,
      });
      expect(stableModelCalls).toEqual([]);
      expect(fallbackModelCalls).toEqual(["kimi-for-coding"]);
      expect(result).toBe("kimi-for-coding");
    }),
  );

  it.effect("skips model RPCs when requested matches current", () =>
    Effect.gen(function* () {
      const { runtime, stableModelCalls, fallbackModelCalls } = makeRecordingRuntime();
      const result = yield* applyKimiAcpModelSelection({
        runtime,
        currentModelId: "k3",
        requestedModelId: "k3",
        hasModelConfigOption: true,
        mapError: (cause) => cause.message,
      });
      expect(stableModelCalls).toEqual([]);
      expect(fallbackModelCalls).toEqual([]);
      expect(result).toBe("k3");
    }),
  );

  it.effect("treats a thinking-variant current model as its base id", () =>
    Effect.gen(function* () {
      const { runtime, stableModelCalls, fallbackModelCalls } = makeRecordingRuntime();
      const result = yield* applyKimiAcpModelSelection({
        runtime,
        currentModelId: "k3,thinking",
        requestedModelId: "k3",
        hasModelConfigOption: false,
        mapError: (cause) => cause.message,
      });
      expect(stableModelCalls).toEqual([]);
      expect(fallbackModelCalls).toEqual([]);
      expect(result).toBe("k3,thinking");
    }),
  );

  it.effect("skips model RPCs when no model is requested", () =>
    Effect.gen(function* () {
      const { runtime, stableModelCalls, fallbackModelCalls } = makeRecordingRuntime();
      const result = yield* applyKimiAcpModelSelection({
        runtime,
        currentModelId: "k3",
        requestedModelId: undefined,
        hasModelConfigOption: true,
        mapError: (cause) => cause.message,
      });
      expect(stableModelCalls).toEqual([]);
      expect(fallbackModelCalls).toEqual([]);
      expect(result).toBe("k3");
    }),
  );

  it.effect("does not report a new current model when setModel fails", () =>
    Effect.gen(function* () {
      const failure = EffectAcpErrors.AcpRequestError.invalidParams("model is unavailable");
      const { runtime, fallbackModelCalls } = makeRecordingRuntime(failure);
      const error = yield* Effect.flip(
        applyKimiAcpModelSelection({
          runtime,
          currentModelId: "k3",
          requestedModelId: "kimi-for-coding",
          hasModelConfigOption: true,
          mapError: (cause) => cause.message,
        }),
      );
      expect(error).toBe(failure.message);
      expect(fallbackModelCalls).toEqual([]);
    }),
  );
});

describe("Kimi permission request classification", () => {
  const bashRequest = {
    sessionId: "session-1",
    toolCall: {
      toolCallId: "tool-bash-1",
      title: "Bash",
      kind: "execute",
      status: "pending",
      content: [
        {
          type: "content",
          content: { type: "text", text: 'Requesting approval to Running: echo "hello"' },
        },
      ],
    },
    options: [
      { optionId: "approve_once", name: "Approve once", kind: "allow_once" },
      { optionId: "approve_always", name: "Approve for this session", kind: "allow_always" },
      { optionId: "reject", name: "Reject", kind: "reject_once" },
    ],
  } satisfies EffectAcpSchema.RequestPermissionRequest;

  const exitPlanModeRequest = {
    sessionId: "session-1",
    toolCall: {
      toolCallId: "tool-exit-plan-1",
      title: "ExitPlanMode",
      status: "pending",
      content: [
        {
          type: "content",
          content: {
            type: "text",
            text: "Plan saved to: D:/plans/mock-plan.md\n\n# Plan: Mock\n\n## Steps\n- do the thing",
          },
        },
        {
          type: "content",
          content: {
            type: "text",
            text: "Requesting approval to Presenting plan and exiting plan mode",
          },
        },
      ],
    },
    options: [
      { optionId: "plan_approve", name: "Approve", kind: "allow_once" },
      { optionId: "plan_revise", name: "Revise", kind: "reject_once" },
      { optionId: "plan_reject_and_exit", name: "Reject and Exit", kind: "reject_once" },
    ],
  } satisfies EffectAcpSchema.RequestPermissionRequest;

  it("classifies tool gates, plan decisions, and user questions", () => {
    expect(classifyKimiPermissionRequest(bashRequest)).toBe("tool");
    expect(classifyKimiPermissionRequest(exitPlanModeRequest)).toBe("plan-decision");
    expect(
      classifyKimiPermissionRequest({
        ...bashRequest,
        toolCall: { toolCallId: "tool-q-1", title: "AskUserQuestion" },
      }),
    ).toBe("user-question");
    // The plan_approve option id is the fallback signal when the title changes.
    expect(
      classifyKimiPermissionRequest({
        ...exitPlanModeRequest,
        toolCall: { toolCallId: "tool-plan-2", title: "Present plan" },
      }),
    ).toBe("plan-decision");
  });

  it("extracts the plan markdown without the saved-path header", () => {
    expect(extractKimiProposedPlanMarkdown(exitPlanModeRequest)).toBe(
      "# Plan: Mock\n\n## Steps\n- do the thing",
    );
  });

  it("falls back to bare plan text and skips the approval-scaffolding entry", () => {
    expect(
      extractKimiProposedPlanMarkdown({
        ...exitPlanModeRequest,
        toolCall: {
          toolCallId: "tool-plan-3",
          title: "ExitPlanMode",
          content: [
            {
              type: "content",
              content: {
                type: "text",
                text: "Requesting approval to Presenting plan and exiting plan mode",
              },
            },
            {
              type: "content",
              content: { type: "text", text: "# Plan: bare markdown" },
            },
          ],
        },
      }),
    ).toBe("# Plan: bare markdown");
    expect(
      extractKimiProposedPlanMarkdown({
        ...exitPlanModeRequest,
        toolCall: { toolCallId: "tool-plan-4", title: "ExitPlanMode" },
      }),
    ).toBeUndefined();
  });

  it("surfaces the real command text as the approval detail", () => {
    expect(kimiPermissionRequestDetail(bashRequest)).toBe('Running: echo "hello"');
    expect(
      kimiPermissionRequestDetail({
        ...bashRequest,
        toolCall: {
          toolCallId: "tool-q-2",
          title: "AskUserQuestion",
          content: [
            { type: "content", content: { type: "text", text: "What should the site be about?" } },
          ],
        },
      }),
    ).toBe("What should the site be about?");
    expect(
      kimiPermissionRequestDetail({
        ...bashRequest,
        toolCall: { toolCallId: "tool-bare-1", title: "Bash" },
      }),
    ).toBeUndefined();
  });

  it("surfaces the plan markdown as the plan-decision approval detail", () => {
    expect(kimiPermissionRequestDetail(exitPlanModeRequest)).toBe(
      "# Plan: Mock\n\n## Steps\n- do the thing",
    );
    // A plan decision without usable plan text falls back to the stripped
    // scaffolding text rather than the raw "Plan saved to:" line.
    expect(
      kimiPermissionRequestDetail({
        ...exitPlanModeRequest,
        toolCall: {
          toolCallId: "tool-plan-5",
          title: "ExitPlanMode",
          content: [
            {
              type: "content",
              content: {
                type: "text",
                text: "Requesting approval to Presenting plan and exiting plan mode",
              },
            },
          ],
        },
      }),
    ).toBe("Presenting plan and exiting plan mode");
  });
});
