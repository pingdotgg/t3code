import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ProjectId,
  MessageId,
  NodeId,
  RunAttemptId,
  RunId,
  type OrchestrationV2UserInputQuestion,
  type OrchestrationV2RuntimeRequest,
  ProviderInstanceId,
  ProviderSessionId,
  type RuntimeMode,
  ThreadId,
} from "@t3tools/contracts";
import { GrokSettings } from "@t3tools/provider-grok/settings";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveSelfInvocation } from "@t3tools/shared/nodeRuntime";
import * as EffectAcpErrors from "effect-acp/errors";
import { xAiRateLimitedErrorCode } from "@t3tools/provider-grok/testing";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import type * as EffectAcpSchema from "effect-acp/compat";

import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import * as ProjectStore from "../ProjectStore.ts";
import { buildInitialGrokProviderSnapshot } from "@t3tools/provider-grok/testing";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import * as ProviderInstanceRegistry from "../../provider/ProviderInstanceRegistry.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as RuntimePolicy from "../RuntimePolicy.ts";
import { acpPermissionDisposition } from "@t3tools/provider-acp/server/clientPolicy";
import { acpCompletedTurnShouldTerminalizeTool } from "@t3tools/provider-acp/server/adapter";
import {
  makeGrokAcpAdapterFlavor,
  makeGrokAdapterV2,
  GROK_PROVIDER,
  GROK_ACP_INITIALIZE_META,
} from "@t3tools/provider-grok/testing";

import { makeAcpReplayRuntime, type AcpReplayTranscript } from "./AcpAdapterV2.testkit.ts";

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
  return ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
    runtimeMode: input.runtimeMode,
    interactionMode: "default",
    cwd: "/workspace",
    ...(input.approvalPolicy === undefined ? {} : { approvalPolicy: input.approvalPolicy }),
    ...(input.sandboxPolicy === undefined ? {} : { sandboxPolicy: input.sandboxPolicy }),
  });
}

describe("GrokAdapterV2 capabilities", () => {
  it("preserves Grok's rate-limit stop and distinguishes other prompt failures", () => {
    const flavor = makeGrokAcpAdapterFlavor(
      {
        makeRuntime: () => Effect.never,
      } as unknown as Parameters<typeof makeGrokAcpAdapterFlavor>[0],
      "/home/ada",
    );
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

  it("terminalizes only foreground tools under the actual Grok flavor", () => {
    const flavor = makeGrokAcpAdapterFlavor(
      {
        makeRuntime: () => Effect.never,
      } as unknown as Parameters<typeof makeGrokAcpAdapterFlavor>[0],
      "/home/ada",
    );
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
});

describe("ACP permission policy", () => {
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
  const disposition = makeGrokAcpAdapterFlavor(
    {
      makeRuntime: () => Effect.never,
    } as unknown as Parameters<typeof makeGrokAcpAdapterFlavor>[0],
    "/home/ada",
  ).permissionDisposition;

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
  const layerHost = TestProviderHost.layer().pipe(Layer.provide(NodeServices.layer));
  const layerTest = Layer.mergeAll(
    NodeServices.layer,
    IdAllocator.layer,
    McpProviderSessions.layer,
    layerHost,
  );

  const launchArgs = (runtimePolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy) =>
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
      const adapter = yield* makeGrokAdapterV2({
        instanceId,
        settings: LAUNCH_TEST_GROK_SETTINGS,
        environment: {},
        hostPlatform: "darwin",
        selfInvocation: yield* resolveSelfInvocation(),
      }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, childProcessSpawner));
      yield* adapter
        .openSession({
          threadId: ThreadId.make("grok-launch-test"),
          providerSessionId: ProviderSessionId.make("grok-launch-test"),
          modelSelection: { instanceId, model: "grok-build" },
          runtimePolicy,
        })
        .pipe(Effect.scoped, Effect.ignore);
      return launches;
    }).pipe(Effect.provideService(HostProcess.Platform, "darwin"), Effect.provide(layerTest));

  const policy = (
    runtimeMode: RuntimeMode,
    override: Partial<ProviderAdapter.ProviderAdapterV2RuntimePolicy> = {},
  ) =>
    ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
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
});

describe("Grok native questions", () => {
  const layerHost = TestProviderHost.layer().pipe(Layer.provide(NodeServices.layer));
  const layerTest = Layer.mergeAll(
    NodeServices.layer,
    IdAllocator.layer,
    McpProviderSessions.layer,
    layerHost,
  );

  it.live("keeps x.ai multi-select questions live and returns all selected answers", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const workspace = yield* fs.makeTempDirectoryScoped({ prefix: "grok-multi-select-" });
      const questionText = "Which changes should be included?";
      const transcript: AcpReplayTranscript = {
        provider: GROK_PROVIDER,
        protocol: "acp.ndjson-jsonrpc",
        version: "1",
        scenario: "grok-multi-select",
        entries: [
          {
            type: "expect_outbound",
            label: "initialize",
            frame: { kind: "request", method: "initialize", params: "<any>" },
          },
          {
            type: "emit_inbound",
            label: "initialized",
            frame: {
              kind: "response",
              method: "initialize",
              result: {
                protocolVersion: 1,
                agentCapabilities: { loadSession: true, promptCapabilities: { image: false } },
                authMethods: [{ id: "replay", name: "Replay" }],
              },
            },
          },
          {
            type: "expect_outbound",
            label: "session.new",
            frame: { kind: "request", method: "session/new", params: "<any>" },
          },
          {
            type: "emit_inbound",
            label: "session.created",
            frame: {
              kind: "response",
              method: "session/new",
              result: {
                sessionId: "grok-multi-select-session",
                models: {
                  currentModelId: "grok-build",
                  availableModels: [{ modelId: "grok-build", name: "Grok Build" }],
                },
              },
            },
          },
          {
            type: "expect_outbound",
            label: "prompt",
            frame: { kind: "request", method: "session/prompt", params: "<any>" },
          },
          {
            type: "emit_inbound",
            label: "question",
            frame: {
              kind: "request",
              method: "_x.ai/ask_user_question",
              params: {
                method: "x.ai/ask_user_question",
                params: {
                  sessionId: "grok-multi-select-session",
                  toolCallId: "grok-question",
                  mode: "default",
                  questions: [
                    {
                      id: "changes",
                      question: questionText,
                      multiSelect: true,
                      options: [
                        { label: "Tests", description: "Cover behavior" },
                        { label: "Docs", description: "Explain usage" },
                      ],
                    },
                  ],
                },
              },
            },
          },
          {
            type: "expect_outbound",
            label: "selected answers",
            frame: {
              kind: "response",
              method: "_x.ai/ask_user_question",
              result: { outcome: "accepted", answers: { [questionText]: ["Tests", "Docs"] } },
            },
          },
          {
            type: "emit_inbound",
            label: "complete",
            frame: {
              kind: "response",
              method: "session/prompt",
              result: { stopReason: "end_turn" },
            },
          },
        ],
      };
      const statusPath = path.join(workspace, "status.json");
      const scriptPath = yield* path.fromFileUrl(
        new URL("../../../scripts/acp-replay-agent.ts", import.meta.url),
      );
      const instanceId = ProviderInstanceId.make("grok-multi-select");
      const threadId = ThreadId.make("grok-multi-select-thread");
      const adapter = yield* makeGrokAdapterV2({
        instanceId,
        settings: LAUNCH_TEST_GROK_SETTINGS,
        environment: {},
        hostPlatform: "darwin",
        selfInvocation: yield* resolveSelfInvocation(),
        makeRuntime: makeAcpReplayRuntime({
          transcript,
          statusPath,
          scriptPath,
          childProcessSpawner,
          fileSystem: fs,
          initializeMeta: GROK_ACP_INITIALIZE_META,
        }),
      });
      const policy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "approval-required",
        interactionMode: "default",
        cwd: workspace,
      });
      const modelSelection = { instanceId, model: "grok-build" };
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("grok-multi-select-session"),
        modelSelection,
        runtimePolicy: policy,
      });
      const providerThread = yield* runtime.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy: policy,
      });
      const question = yield* Deferred.make<OrchestrationV2UserInputQuestion>();
      const request = yield* Deferred.make<OrchestrationV2RuntimeRequest>();
      const terminal = yield* Deferred.make<void>();
      yield* runtime.events.pipe(
        Stream.runForEach((event) => {
          if (
            event.type === "turn_item.updated" &&
            event.turnItem.type === "user_input_request" &&
            event.turnItem.questions[0]
          )
            return Deferred.succeed(question, event.turnItem.questions[0]);
          if (event.type === "runtime_request.updated")
            return Deferred.succeed(request, event.runtimeRequest);
          if (event.type === "turn.terminal") return Deferred.succeed(terminal, undefined);
          return Effect.void;
        }),
        Effect.forkScoped,
      );
      const now = yield* DateTime.now;
      yield* runtime.startTurn({
        appThread: {
          createdBy: "user",
          creationSource: "web",
          id: threadId,
          projectId: ProjectId.make("grok-multi-select-project"),
          title: "Grok multi-select",
          providerInstanceId: instanceId,
          modelSelection,
          runtimeMode: "approval-required",
          interactionMode: "default",
          branch: null,
          worktreePath: workspace,
          activeProviderThreadId: providerThread.id,
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
        threadId,
        runId: RunId.make("grok-multi-select-run"),
        runOrdinal: 1,
        providerTurnOrdinal: 1,
        attemptId: RunAttemptId.make("grok-multi-select-attempt"),
        rootNodeId: NodeId.make("grok-multi-select-root"),
        providerThread,
        message: {
          createdBy: "user",
          creationSource: "web",
          messageId: MessageId.make("grok-multi-select-message"),
          text: "Ask which changes to include.",
          attachments: [],
        },
        modelSelection,
        runtimePolicy: policy,
      });
      assert.deepEqual(yield* Deferred.await(question), {
        id: "changes",
        header: "Question",
        question: questionText,
        multiSelect: true,
        options: [
          { label: "Tests", description: "Cover behavior" },
          { label: "Docs", description: "Explain usage" },
        ],
      });
      const pending = yield* Deferred.await(request);
      assert.equal(pending.kind, "user_input");
      assert.equal(pending.responseCapability.type, "live");
      yield* runtime.respondToRuntimeRequest({
        requestId: pending.id,
        answers: { changes: ["Tests", "Docs"] },
      });
      yield* Deferred.await(terminal);
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );
});
