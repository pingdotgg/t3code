import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  GrokSettings,
  type ModelSelection,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  type RuntimeMode,
  ThreadId,
} from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { resolveSelfInvocation } from "@t3tools/shared/nodeRuntime";
import * as EffectAcpErrors from "effect-acp/errors";
import { xAiRateLimitedErrorCode } from "../../provider/acp/XAiAcpExtension.ts";
import { assert, describe, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/unstable/process";
import type * as EffectAcpSchema from "effect-acp/compat";

import * as ServerConfig from "../../config.ts";
import * as ProjectStore from "../ProjectStore.ts";
import { buildInitialGrokProviderSnapshot } from "../../provider/Layers/GrokProvider.ts";
import type { ProviderInstance } from "../../provider/ProviderDriver.ts";
import * as ProviderInstanceRegistry from "../../provider/Services/ProviderInstanceRegistry.ts";
import * as IdAllocator from "../IdAllocator.ts";
import { ProviderAdapterV2RuntimePolicy } from "../ProviderAdapter.ts";
import * as RuntimePolicy from "../RuntimePolicy.ts";
import { acpPermissionDisposition } from "../../provider/acp/AcpClientPolicy.ts";
import type * as AcpSessionRuntime from "../../provider/acp/AcpSessionRuntime.ts";
import {
  AcpProviderCapabilitiesV2,
  acpCompletedTurnShouldTerminalizeTool,
  acpSubagentStatusBlocksTurnSettlement,
  acpSupportsImagePrompts,
} from "./AcpAdapterV2.ts";
import {
  makeGrokAcpAdapterFlavor,
  makeGrokAdapterV2,
  GrokProviderCapabilitiesV2,
  type GrokAdapterV2Options,
} from "./GrokAdapterV2.ts";

const LAUNCH_TEST_GROK_SETTINGS = Schema.decodeSync(GrokSettings)({
  binaryPath: "grok-launch-test",
});

function permissionRequest(
  kind: EffectAcpSchema.ToolKind,
): EffectAcpSchema.RequestPermissionRequest {
  return {
    sessionId: "session-1",
    options: [
      { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
      { optionId: "allow-always", name: "Allow always", kind: "allow_always" },
      { optionId: "reject-once", name: "Reject", kind: "reject_once" },
    ],
    toolCall: {
      toolCallId: "tool-1",
      title: "Test tool",
      kind,
    },
  };
}

function runtimePolicy(input: {
  readonly runtimeMode: RuntimeMode;
  readonly approvalPolicy?: unknown;
  readonly sandboxPolicy?: unknown;
}) {
  return ProviderAdapterV2RuntimePolicy.make({
    runtimeMode: input.runtimeMode,
    interactionMode: "default",
    cwd: "/workspace",
    ...(input.approvalPolicy === undefined ? {} : { approvalPolicy: input.approvalPolicy }),
    ...(input.sandboxPolicy === undefined ? {} : { sandboxPolicy: input.sandboxPolicy }),
  });
}

describe("acpSubagentStatusBlocksTurnSettlement", () => {
  it("blocks settlement for pending and running subagents", () => {
    assert.isTrue(acpSubagentStatusBlocksTurnSettlement("pending"));
    assert.isTrue(acpSubagentStatusBlocksTurnSettlement("running"));
  });

  it("does not block settlement for terminal subagents", () => {
    assert.isFalse(acpSubagentStatusBlocksTurnSettlement("cancelled"));
    assert.isFalse(acpSubagentStatusBlocksTurnSettlement("completed"));
    assert.isFalse(acpSubagentStatusBlocksTurnSettlement("failed"));
    assert.isFalse(acpSubagentStatusBlocksTurnSettlement("interrupted"));
  });
});

describe("GrokAdapterV2 capabilities", () => {
  it("preserves Grok's rate-limit stop and distinguishes other prompt failures", () => {
    const flavor = makeGrokAcpAdapterFlavor({
      makeRuntime: () => Effect.never,
    } as unknown as GrokAdapterV2Options);
    const limit = flavor.promptFailure?.(
      new EffectAcpErrors.AcpRequestError({
        code: xAiRateLimitedErrorCode,
        errorMessage: "Grok usage limit reached. Try again later.",
      }),
    );
    assert.equal(limit?.class, "usage_limit");
    assert.equal(limit?.code, String(xAiRateLimitedErrorCode));
    assert.equal(limit?.message, "Grok usage limit reached. Try again later.");
    assert.equal(
      flavor.promptFailure?.(
        new EffectAcpErrors.AcpRequestError({
          code: -32603,
          errorMessage: "Internal error",
        }),
      ).class,
      "provider_error",
    );
    assert.equal(
      flavor.promptFailure?.(new Error("Rate limit mentioned in an ordinary error")).class,
      "provider_error",
    );
  });

  it("wires hard Stop teardown but soft non-Stop interrupts in the constructor flavor", () => {
    const flavor = makeGrokAcpAdapterFlavor({
      makeRuntime: () => Effect.never,
    } as unknown as GrokAdapterV2Options);

    assert.isFalse(flavor.interruptPromptOnCancel);
    // User Stop (requestRuntimeRestart) keeps the hard process-group kill and
    // respawn: Grok cancel is detach-and-continue, so only a process kill
    // stops the work.
    assert.isTrue(flavor.restartRuntimeAfterInterrupt);
    assert.isTrue(flavor.terminateRuntimeProcessGroupOnInterrupt);
    // Non-Stop interrupts (steering, restart_active) reuse the process and
    // session; the cancelled work backgrounds and the model decides its fate.
    assert.isUndefined(flavor.restartRuntimeOnEveryInterrupt);
    assert.isTrue(flavor.preserveRuntimeOnSettledInterrupt);
  });

  it("terminalizes only foreground tools under the actual Grok flavor", () => {
    const flavor = makeGrokAcpAdapterFlavor({
      makeRuntime: () => Effect.never,
    } as unknown as GrokAdapterV2Options);
    const foreground = {
      toolCallId: "foreground-1",
      title: "Terminal",
      status: "inProgress" as const,
      data: {
        rawInput: { command: "true" },
        rawOutput: { type: "Bash", exit_code: 0 },
      },
    };
    const monitor = {
      toolCallId: "monitor-1",
      title: "Monitor",
      status: "inProgress" as const,
      data: {
        rawInput: { variant: "Monitor", command: "sleep 30" },
        rawOutput: {
          type: "Monitor",
          taskId: "019f44b8-8e98-7c80-a40e-df1e26a5f9e3",
        },
      },
    };
    const subagent = {
      toolCallId: "subagent-1",
      title: "Task",
      status: "inProgress" as const,
      data: {
        rawInput: {
          description: "Inspect interrupt handling",
          prompt: "Review the adapter.",
          subagent_type: "generalPurpose",
        },
      },
    };

    assert.isTrue(acpCompletedTurnShouldTerminalizeTool(foreground, flavor));
    assert.isFalse(acpCompletedTurnShouldTerminalizeTool(monitor, flavor));
    assert.isFalse(acpCompletedTurnShouldTerminalizeTool(subagent, flavor));
  });

  it("keeps optional protocol features conservative until a flavor or handshake confirms them", () => {
    assert.isFalse(AcpProviderCapabilitiesV2.sessions.supportsModelSwitchInSession);
    assert.isFalse(AcpProviderCapabilitiesV2.sessions.supportsRuntimeModeSwitchInSession);
    assert.isFalse(AcpProviderCapabilitiesV2.threads.canReadThreadSnapshot);
    assert.isFalse(AcpProviderCapabilitiesV2.tools.supportsMcpTools);
  });

  it("overrides ACP image capability false so screenshot attachments can prompt", () => {
    // Handshake alone would refuse attachments (Grok advertises image:false).
    assert.isFalse(
      acpSupportsImagePrompts({
        negotiatedImage: false,
      }),
    );
    // Flavor override unblocks image content blocks for Grok.
    assert.isTrue(
      acpSupportsImagePrompts({
        flavorSupportsImagePrompts: true,
        negotiatedImage: false,
      }),
    );
    assert.isTrue(
      acpSupportsImagePrompts({
        negotiatedImage: true,
      }),
    );
  });

  it("declares Grok Task envelopes as native subagents", () => {
    assert.isFalse(GrokProviderCapabilitiesV2.threads.canForkThread);
    assert.isTrue(GrokProviderCapabilitiesV2.subagents.supportsSubagents);
    assert.isTrue(GrokProviderCapabilitiesV2.subagents.exposesSubagentThreadIds);
    assert.isTrue(GrokProviderCapabilitiesV2.subagents.emitsSubagentLifecycle);
    assert.isFalse(GrokProviderCapabilitiesV2.turns.supportsActiveSteering);
    assert.isTrue(GrokProviderCapabilitiesV2.turns.supportsInterrupt);
    assert.isTrue(GrokProviderCapabilitiesV2.turns.supportsSteeringByInterruptRestart);
    assert.isTrue(GrokProviderCapabilitiesV2.context.supportsFullThreadHandoff);
  });

  it("declares the optional ACP features verified by the Grok handshake", () => {
    assert.isTrue(GrokProviderCapabilitiesV2.sessions.supportsModelSwitchInSession);
    assert.isTrue(GrokProviderCapabilitiesV2.threads.canReadThreadSnapshot);
    assert.isTrue(GrokProviderCapabilitiesV2.tools.supportsMcpTools);
    assert.isTrue(GrokProviderCapabilitiesV2.checkpointing.providerCanReadConversationSnapshot);
  });
});

describe("ACP permission policy", () => {
  it("honors explicit on-request approval over full-access runtime mode", () => {
    assert.equal(
      acpPermissionDisposition(
        runtimePolicy({
          runtimeMode: "full-access",
          approvalPolicy: "on-request",
          sandboxPolicy: { type: "readOnly" },
        }),
        permissionRequest("execute"),
      ),
      "ask",
    );
  });

  it("rejects mutating escalation under a non-interactive read-only policy", () => {
    const policy = runtimePolicy({
      runtimeMode: "full-access",
      approvalPolicy: "never",
      sandboxPolicy: { type: "readOnly" },
    });
    assert.equal(acpPermissionDisposition(policy, permissionRequest("execute")), "deny");
    assert.equal(acpPermissionDisposition(policy, permissionRequest("edit")), "deny");
    assert.equal(acpPermissionDisposition(policy, permissionRequest("read")), "allow");
  });

  it("auto-approves requests only when the resolved policy permits them", () => {
    assert.equal(
      acpPermissionDisposition(
        runtimePolicy({
          runtimeMode: "full-access",
          approvalPolicy: "never",
          sandboxPolicy: { type: "dangerFullAccess" },
        }),
        permissionRequest("execute"),
      ),
      "allow",
    );
    assert.equal(
      acpPermissionDisposition(
        runtimePolicy({ runtimeMode: "approval-required" }),
        permissionRequest("edit"),
      ),
      "ask",
    );
    assert.equal(
      acpPermissionDisposition(
        runtimePolicy({ runtimeMode: "approval-required" }),
        permissionRequest("read"),
      ),
      "allow",
    );
  });
});

describe("Grok permission prompts", () => {
  const disposition = makeGrokAcpAdapterFlavor({
    makeRuntime: () => Effect.never,
  } as unknown as GrokAdapterV2Options).permissionDisposition;

  // grok_auto_blocked_command replays Auto end to end. When an explicit policy
  // launches Grok asking instead, T3's policy still answers its prompts.
  it("leaves Auto prompts to the user unless an explicit policy launched Grok asking", () => {
    assert.equal(
      disposition?.(runtimePolicy({ runtimeMode: "auto" }), permissionRequest("read")),
      "ask",
    );
    const readOnly = runtimePolicy({
      runtimeMode: "auto",
      approvalPolicy: "never",
      sandboxPolicy: { type: "readOnly" },
    });
    assert.equal(disposition?.(readOnly, permissionRequest("execute")), "deny");
    assert.equal(
      disposition?.(runtimePolicy({ runtimeMode: "approval-required" }), permissionRequest("edit")),
      "ask",
    );
  });
});

describe("Grok launch permission mode", () => {
  const serverConfigLayer = ServerConfig.layerTest(process.cwd(), {
    prefix: "t3-grok-v2-launch-",
  }).pipe(Layer.provide(NodeServices.layer));
  const testLayer = Layer.mergeAll(NodeServices.layer, IdAllocator.layer, serverConfigLayer);

  // Opens a session through the adapter's own Grok runtime factory and returns
  // the argv it tried to launch. The spawn fails after recording, so no
  // process starts.
  const launchArgs = (runtimePolicy: ProviderAdapterV2RuntimePolicy) =>
    Effect.gen(function* () {
      const launches: Array<ReadonlyArray<string>> = [];
      const childProcessSpawner = ChildProcessSpawner.make((command) => {
        if (command._tag === "StandardCommand") launches.push(command.args);
        return Effect.fail(
          PlatformError.systemError({
            _tag: "NotFound",
            module: "grok-launch-test",
            method: "spawn",
          }),
        );
      });
      const instanceId = ProviderInstanceId.make("grok-launch-test");
      const adapter = makeGrokAdapterV2({
        instanceId,
        settings: LAUNCH_TEST_GROK_SETTINGS,
        environment: {},
        hostPlatform: "darwin",
        childProcessSpawner,
        crypto: yield* Crypto.Crypto,
        fileSystem: yield* FileSystem.FileSystem,
        idAllocator: yield* IdAllocator.IdAllocatorV2,
        serverConfig: yield* ServerConfig.ServerConfig,
        selfInvocation: yield* resolveSelfInvocation(),
      });
      yield* adapter
        .openSession({
          threadId: ThreadId.make("grok-launch-test"),
          providerSessionId: ProviderSessionId.make("grok-launch-test"),
          modelSelection: { instanceId, model: "grok-build" },
          runtimePolicy,
        })
        .pipe(Effect.scoped, Effect.ignore);
      return launches;
    }).pipe(
      // Keep the launch argv unwrapped by the Linux cgroup shim.
      Effect.provideService(HostProcessPlatform, "darwin"),
      Effect.provide(testLayer),
    );

  const policy = (
    runtimeMode: RuntimeMode,
    override: Partial<ProviderAdapterV2RuntimePolicy> = {},
  ) =>
    ProviderAdapterV2RuntimePolicy.make({
      runtimeMode,
      interactionMode: "default",
      cwd: process.cwd(),
      ...override,
    });

  it.effect.each(
    (
      [
        ["approval-required", ["--permission-mode", "default", "agent", "stdio"]],
        ["auto", ["--permission-mode", "auto", "agent", "stdio"]],
        ["full-access", ["agent", "--always-approve", "stdio"]],
      ] as const
    ).map(([runtimeMode, args]) => [runtimeMode, args.join(" "), args] as const),
  )("launches %s threads with %s", ([runtimeMode, , args]) =>
    Effect.gen(function* () {
      assert.deepEqual(yield* launchArgs(policy(runtimeMode)), [args]);
    }),
  );

  it.effect("launches a thread stored as Auto-accept edits asking", () =>
    Effect.gen(function* () {
      // The policy the orchestrator resolves from Grok's own provider snapshot.
      const snapshot = yield* buildInitialGrokProviderSnapshot(LAUNCH_TEST_GROK_SETTINGS);
      const instanceId = ProviderInstanceId.make("grok-launch-test");
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("grok-launch-test");
      const modelSelection = { instanceId, model: "grok-build" } as const;
      const resolved = yield* Effect.gen(function* () {
        const runtimePolicy = yield* RuntimePolicy.RuntimePolicyV2;
        return yield* runtimePolicy.resolve({
          thread: {
            createdBy: "user",
            creationSource: "web",
            id: threadId,
            projectId: ProjectId.make("grok-launch-test"),
            title: "Grok launch test",
            providerInstanceId: instanceId,
            modelSelection,
            runtimeMode: "auto-accept-edits",
            interactionMode: "default",
            branch: null,
            worktreePath: process.cwd(),
            activeProviderThreadId: null,
            lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
            forkedFrom: null,
            createdAt: now,
            updatedAt: now,
            archivedAt: null,
            settledOverride: null,
            settledAt: null,
            lastVisitedAt: null,
            deletedAt: null,
          },
          modelSelection,
        });
      }).pipe(
        Effect.provide(
          RuntimePolicy.layerFromProjectStore.pipe(
            Layer.provide(
              Layer.mock(ProjectStore.ProjectStoreV2)({
                get: () => Effect.die("the thread has a worktree"),
              }),
            ),
            Layer.provide(
              Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
                getInstance: () =>
                  Effect.succeed({
                    snapshot: { getSnapshot: Effect.succeed(snapshot) },
                  } as ProviderInstance),
              }),
            ),
          ),
        ),
      );
      assert.equal(resolved.runtimeMode, "approval-required");
      assert.deepEqual(yield* launchArgs(resolved), [
        ["--permission-mode", "default", "agent", "stdio"],
      ]);
    }),
  );

  it.effect("launches asking when an explicit approval or sandbox policy governs the thread", () =>
    Effect.gen(function* () {
      const asking = [["--permission-mode", "default", "agent", "stdio"]];
      assert.deepEqual(
        yield* launchArgs(
          policy("full-access", {
            approvalPolicy: "never",
            sandboxPolicy: { type: "workspaceWrite", writableRoots: [], networkAccess: false },
          }),
        ),
        asking,
      );
      assert.deepEqual(
        yield* launchArgs(policy("full-access", { approvalPolicy: "on-request" })),
        asking,
      );
    }),
  );
});

describe("Grok model selection carries the reasoning effort", () => {
  const flavor = makeGrokAcpAdapterFlavor({
    makeRuntime: () => Effect.never,
  } as unknown as GrokAdapterV2Options);
  const select = (model: string, effort?: string): ModelSelection =>
    ({
      instanceId: "grok",
      model,
      ...(effort === undefined ? {} : { options: [{ id: "reasoningEffort", value: effort }] }),
    }) as unknown as ModelSelection;
  const selectEffort = (effort: string) => select("grok-4.6", effort);
  const selection = selectEffort("low");
  const modelOption = (currentValue: string) => ({
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue,
    options: [],
  });
  const effortOption = (currentValue: string, offered: ReadonlyArray<string>) => ({
    id: "reasoning_effort",
    name: "Reasoning effort",
    category: "thought_level",
    type: "select",
    currentValue,
    options: offered.map((value) => ({ value, name: value })),
  });

  const makeRuntime = (input?: {
    readonly configOptions?: ReadonlyArray<unknown>;
    /** What the session advertises once `setModel` has switched it. */
    readonly configOptionsAfterModelSwitch?: ReadonlyArray<unknown>;
    readonly setConfigOptionFailure?: EffectAcpErrors.AcpError;
  }) => {
    const calls: Array<Record<string, unknown>> = [];
    let live = input?.configOptions ?? [];
    const runtime = {
      getConfigOptions: Effect.sync(() => live),
      setSessionModel: (modelId: string, meta?: { readonly [key: string]: unknown } | null) =>
        Effect.sync(() => {
          calls.push(
            meta === undefined ? { setSessionModel: modelId } : { setSessionModel: modelId, meta },
          );
          return {};
        }),
      setModel: (model: string) =>
        Effect.sync(() => {
          calls.push({ setModel: model });
          live = input?.configOptionsAfterModelSwitch ?? live;
        }),
      setConfigOption: (configId: string, value: string | boolean) =>
        Effect.suspend(() => {
          calls.push({ setConfigOption: configId, value });
          return input?.setConfigOptionFailure === undefined
            ? Effect.succeed({ configOptions: [] })
            : Effect.fail(input.setConfigOptionFailure);
        }),
    } as unknown as AcpSessionRuntime.AcpSessionRuntime["Service"];
    return { runtime, calls };
  };

  const startResult = (protocolVersion: number, currentEffort?: string) =>
    ({
      sessionId: "session-1",
      initializeResult: { protocolVersion },
      sessionSetupResult: {
        sessionId: "session-1",
        models: {
          currentModelId: "grok-4.6",
          availableModels: [
            {
              modelId: "grok-4.6",
              name: "Grok 4.6",
              ...(currentEffort === undefined ? {} : { _meta: { reasoningEffort: currentEffort } }),
            },
          ],
        },
      },
      modelConfigId: undefined,
    }) as unknown as AcpSessionRuntime.AcpSessionRuntimeStartResult;

  it.effect("sends the selected effort as session/set_model metadata on protocol 1", () =>
    Effect.gen(function* () {
      const { runtime, calls } = makeRuntime();
      // Same model as the session default: only the effort changes (#15251).
      const applied = yield* flavor.applyModelSelection!({
        runtime,
        startResult: startResult(1, "xhigh"),
        modelSelection: selection,
        previousSelection: null,
      });
      assert.equal(applied, "grok-4.6");
      assert.deepEqual(calls, [{ setSessionModel: "grok-4.6", meta: { reasoningEffort: "low" } }]);
    }),
  );

  it.effect("does not resend an effort the protocol 1 session already runs at", () =>
    Effect.gen(function* () {
      const { runtime, calls } = makeRuntime();
      yield* flavor.applyModelSelection!({
        runtime,
        startResult: startResult(1, "low"),
        modelSelection: selection,
        previousSelection: null,
      });
      assert.deepEqual(calls, []);
    }),
  );

  it.effect("returns a protocol 1 session to its setup-time effort after a live change", () =>
    Effect.gen(function* () {
      const { runtime, calls } = makeRuntime();
      const setup = startResult(1, "xhigh");
      yield* flavor.applyModelSelection!({
        runtime,
        startResult: setup,
        modelSelection: selection,
        previousSelection: null,
      });
      // The adapter replays same-runtime switches against the stored setup,
      // whose metadata still says xhigh; only the previous selection knows the
      // session actually runs at low.
      yield* flavor.applyModelSelection!({
        runtime,
        startResult: setup,
        modelSelection: selectEffort("xhigh"),
        previousSelection: selection,
      });
      assert.deepEqual(calls, [
        { setSessionModel: "grok-4.6", meta: { reasoningEffort: "low" } },
        { setSessionModel: "grok-4.6", meta: { reasoningEffort: "xhigh" } },
      ]);
    }),
  );

  it.effect("resends the effort after an effort-free selection on protocol 1", () =>
    Effect.gen(function* () {
      const { runtime, calls } = makeRuntime();
      const setup = startResult(1, "xhigh");
      const effortFree = select("grok-4.6");
      yield* flavor.applyModelSelection!({
        runtime,
        startResult: setup,
        modelSelection: selection,
        previousSelection: null,
      });
      // Same model, no effort: nothing is sent and the session stays at low,
      // but the adapter now remembers only this effort-free selection.
      yield* flavor.applyModelSelection!({
        runtime,
        startResult: setup,
        modelSelection: effortFree,
        previousSelection: selection,
      });
      yield* flavor.applyModelSelection!({
        runtime,
        startResult: setup,
        modelSelection: selectEffort("xhigh"),
        previousSelection: effortFree,
      });
      assert.deepEqual(calls, [
        { setSessionModel: "grok-4.6", meta: { reasoningEffort: "low" } },
        { setSessionModel: "grok-4.6", meta: { reasoningEffort: "xhigh" } },
      ]);
    }),
  );

  it.effect("writes the thought-level option on newer protocols without a model change", () =>
    Effect.gen(function* () {
      const { runtime, calls } = makeRuntime({
        configOptions: [modelOption("grok-4.6"), effortOption("xhigh", ["low", "xhigh"])],
      });
      const applied = yield* flavor.applyModelSelection!({
        runtime,
        startResult: startResult(2),
        modelSelection: selection,
        previousSelection: null,
      });
      assert.equal(applied, "grok-4.6");
      assert.deepEqual(calls, [{ setConfigOption: "reasoning_effort", value: "low" }]);
    }),
  );

  it.effect("skips an effort the switched-to model's live option does not offer", () =>
    Effect.gen(function* () {
      const { runtime, calls } = makeRuntime({
        configOptions: [modelOption("grok-4.6"), effortOption("xhigh", ["low", "xhigh"])],
        configOptionsAfterModelSwitch: [
          modelOption("grok-4.5"),
          effortOption("high", ["low", "high"]),
        ],
      });
      const applied = yield* flavor.applyModelSelection!({
        runtime,
        startResult: startResult(2),
        modelSelection: select("grok-4.5", "xhigh"),
        previousSelection: null,
      });
      assert.equal(applied, "grok-4.5");
      assert.deepEqual(calls, [{ setModel: "grok-4.5" }]);
    }),
  );

  it.effect("keeps the session open when the live option rejects the effort", () =>
    Effect.gen(function* () {
      const { runtime, calls } = makeRuntime({
        configOptions: [modelOption("grok-4.6"), effortOption("xhigh", ["low", "xhigh"])],
        setConfigOptionFailure: new EffectAcpErrors.AcpRequestError({
          code: -32602,
          errorMessage: "Unsupported reasoning effort",
        }),
      });
      const applied = yield* flavor.applyModelSelection!({
        runtime,
        startResult: startResult(2),
        modelSelection: selection,
        previousSelection: null,
      });
      assert.equal(applied, "grok-4.6");
      assert.deepEqual(calls, [{ setConfigOption: "reasoning_effort", value: "low" }]);
    }),
  );
});
