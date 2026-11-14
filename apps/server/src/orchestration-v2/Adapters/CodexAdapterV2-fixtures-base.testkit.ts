import { historyResponseItems } from "@t3tools/provider-core/server/handoffBudget";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import {
  makeProviderTextDeltaCoalescer,
  type ProviderTextDeltaUpdate,
} from "./ProviderTextDeltaCoalescer.ts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  CheckpointId,
  CodexSettings,
  EnvironmentId,
  MessageId,
  type ModelSelection,
  NodeId,
  type OrchestrationV2AppThread,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2Subagent,
  type OrchestrationV2TurnItem,
  ProjectId,
  type ProviderApprovalDecision,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderSetupError,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as CodexClient from "effect-codex-app-server/client";
import * as CodexReplay from "effect-codex-app-server/replay";
import * as CodexError from "effect-codex-app-server/errors";
import type * as CodexSchema from "effect-codex-app-server/schema";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Digest from "effect/crypto/Digest";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as FileSystem from "effect/FileSystem";
import { MCP_APP_OUTPUT_KEY, readMcpAppReference } from "@t3tools/shared/mcpApp";
import { toolOutputImages } from "@t3tools/shared/toolOutput";
import { resolveAttachmentPathById } from "../../attachmentStore.ts";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Sink from "effect/Sink";
import * as Stdio from "effect/Stdio";
import * as Exit from "effect/Exit";
import * as Cause from "effect/Cause";
import * as PlatformError from "effect/PlatformError";
import { TestClock } from "effect/testing";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import packageJson from "../../../package.json" with { type: "json" };
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as EffectWorker from "../EffectWorker.ts";
import * as Orchestrator from "../Orchestrator.ts";
import * as ProviderReplayHarness from "../testkit/ProviderReplayHarness.ts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import type * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import * as ModelManifest from "../../provider/ModelManifest.ts";
import * as PortScanner from "../../preview/PortScanner.ts";
import { resolveProviderCompatibility } from "../../provider/providerCompatibility.ts";
import * as CodexAdapterV2 from "./CodexAdapterV2.ts";
import { withCodexReplayChildMetadata } from "./CodexAdapterV2.testkit.ts";
import * as CodexAdapterV2Testkit from "./CodexAdapterV2.testkit.ts";

export const replayTranscriptJson = Schema.fromJsonString(CodexReplay.CodexAppServerReplayTranscript);

export const encodeReplayTranscriptJson = Schema.encodeEffect(replayTranscriptJson);

export const decodeReplayTranscriptJson = Schema.decodeUnknownEffect(replayTranscriptJson);

export const encodeStringJson = Schema.encodeEffect(Schema.fromJsonString(Schema.String));

export const isProviderAdapterEventStreamError = Schema.is(
  ProviderAdapter.ProviderAdapterEventStreamError,
);

export const encodeUnknownJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

export const providerThreadId = ProviderThreadId.make("provider-thread-codex-fork-boundary");

export const makeProviderThread = (now: DateTime.Utc): OrchestrationV2ProviderThread => ({
  id: providerThreadId,
  driver: CodexAdapterV2.CODEX_DRIVER_KIND,
  providerInstanceId: ProviderInstanceId.make("codex"),
  providerSessionId: ProviderSessionId.make("provider-session-codex-fork-boundary"),
  appThreadId: ThreadId.make("thread-codex-fork-boundary"),
  ownerNodeId: null,
  nativeThreadRef: {
    driver: CodexAdapterV2.CODEX_DRIVER_KIND,
    nativeId: "native-thread-codex-fork-boundary",
    strength: "strong",
  },
  nativeConversationHeadRef: null,
  status: "idle",
  firstRunOrdinal: 1,
  lastRunOrdinal: 2,
  handoffIds: [],
  forkedFrom: null,
  createdAt: now,
  updatedAt: now,
});

export const makeProviderTurn = (
  id: string,
  ordinal: number,
  nativeId: string | null,
  now: DateTime.Utc,
): OrchestrationV2ProviderTurn => ({
  id: ProviderTurnId.make(id),
  providerThreadId,
  nodeId: NodeId.make(`node-${id}`),
  runAttemptId: RunAttemptId.make(`run-attempt-${id}`),
  nativeTurnRef:
    nativeId === null
      ? { driver: CodexAdapterV2.CODEX_DRIVER_KIND, nativeId: null, strength: "none" }
      : { driver: CodexAdapterV2.CODEX_DRIVER_KIND, nativeId, strength: "strong" },
  ordinal,
  status: "completed",
  startedAt: now,
  completedAt: now,
});

export const DEFAULT_CODEX_SETTINGS = Schema.decodeSync(CodexSettings)({});

export const CODEX_TEST_MODEL_SELECTION = {
  instanceId: CodexAdapterV2.CODEX_DEFAULT_INSTANCE_ID,
  model: "gpt-5.4",
} satisfies ModelSelection;

export const CODEX_TEST_RUNTIME_POLICY = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
  runtimeMode: "full-access",
  interactionMode: "default",
  cwd: "/workspace",
});

export const T3_THREAD_ENV_KEY = "shell_environment_policy.set.T3CODE_THREAD_ID";

export const threadEnvOf = (params: unknown) =>
  Predicate.hasProperty(params, "config") && Predicate.hasProperty(params.config, T3_THREAD_ENV_KEY)
    ? params.config[T3_THREAD_ENV_KEY]
    : undefined;

export function makeCodexTestAppThread(input: {
  readonly threadId: ThreadId;
  readonly providerThread: OrchestrationV2ProviderThread;
  readonly now: DateTime.Utc;
}): OrchestrationV2AppThread {
  return {
    createdBy: "user",
    creationSource: "web",
    id: input.threadId,
    projectId: ProjectId.make(`project-${input.threadId}`),
    title: "Codex continuation test",
    providerInstanceId: CodexAdapterV2.CODEX_DEFAULT_INSTANCE_ID,
    modelSelection: CODEX_TEST_MODEL_SELECTION,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: input.providerThread.id,
    lineage: {
      parentThreadId: null,
      relationshipToParent: null,
      rootThreadId: input.threadId,
    },
    forkedFrom: null,
    createdAt: input.now,
    updatedAt: input.now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
}

export function makeCodexTestTurnInput(input: {
  readonly threadId: ThreadId;
  readonly providerThread: OrchestrationV2ProviderThread;
  readonly now: DateTime.Utc;
  readonly attemptId: RunAttemptId;
  readonly text: string;
}): ProviderAdapter.ProviderAdapterV2TurnInput {
  return {
    appThread: makeCodexTestAppThread(input),
    threadId: input.threadId,
    runId: RunId.make(`run-${input.attemptId}`),
    runOrdinal: 1,
    providerTurnOrdinal: 1,
    attemptId: input.attemptId,
    rootNodeId: NodeId.make(`node-${input.attemptId}`),
    providerThread: input.providerThread,
    message: {
      createdBy: "user",
      creationSource: "web",
      messageId: MessageId.make(`message-${input.attemptId}`),
      text: input.text,
      attachments: [],
    },
    modelSelection: CODEX_TEST_MODEL_SELECTION,
    runtimePolicy: CODEX_TEST_RUNTIME_POLICY,
  };
}

export function makeCodexReplayTurn(input: {
  readonly id: string;
  readonly status: "inProgress" | "completed" | "interrupted" | "failed";
}): Record<string, unknown> {
  const terminal =
    input.status === "completed" || input.status === "interrupted" || input.status === "failed";
  return {
    id: input.id,
    items: [],
    itemsView: "notLoaded",
    status: input.status,
    error: null,
    startedAt: 1782622440,
    completedAt: terminal ? 1782622450 : null,
    durationMs: null,
  };
}

export function codexReplayPreamble(input: {
  readonly nativeThreadId: string;
  readonly nativeTurnId: string;
  readonly prompt: string;
  readonly sentPrompt?: string;
  readonly effort?: string;
}): Array<CodexReplay.CodexAppServerReplayEntry> {
  return [
    {
      type: "expect_outbound",
      label: "initialize",
      frame: {
        id: 1,
        method: "initialize",
        params: {
          clientInfo: { name: "T3 Code", title: "T3 Code", version: packageJson.version },
          capabilities: {
            experimentalApi: true,
            optOutNotificationMethods: ["turn/diff/updated"],
            extensions: {
              "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] },
            },
          },
        },
      },
    },
    {
      type: "emit_inbound",
      label: "initialize",
      frame: {
        id: 1,
        result: {
          userAgent: "T3 Code/0.156.1",
          codexHome: "/tmp/codex-home",
          platformFamily: "unix",
          platformOs: "macos",
        },
      },
    },
    { type: "expect_outbound", label: "initialized", frame: { method: "initialized" } },
    {
      type: "expect_outbound",
      label: "thread/start",
      frame: {
        id: 2,
        method: "thread/start",
        params: { config: CodexAdapterV2.CODEX_THREAD_CONFIG },
      },
    },
    {
      type: "emit_inbound",
      label: "thread/start",
      frame: {
        id: 2,
        result: {
          thread: {
            id: input.nativeThreadId,
            sessionId: input.nativeThreadId,
            projectId: null,
            forkedFromId: null,
            preview: "",
            ephemeral: false,
            modelProvider: "openai",
            createdAt: 1782622440,
            updatedAt: 1782622440,
            status: { type: "idle" },
            path: `/tmp/${input.nativeThreadId}.jsonl`,
            cwd: "/workspace",
            cliVersion: "0.144.0",
            source: "vscode",
            threadSource: null,
            agentNickname: null,
            agentRole: null,
            gitInfo: null,
            name: null,
            turns: [],
          },
          model: "gpt-5.4",
          modelProvider: "openai",
          serviceTier: null,
          cwd: "/workspace",
          instructionSources: [],
          approvalPolicy: "on-request",
          approvalsReviewer: "user",
          sandbox: { type: "workspaceWrite", writableRoots: [], networkAccess: false },
          reasoningEffort: "medium",
        },
      },
    },
    {
      type: "expect_outbound",
      label: "turn/start",
      frame: {
        id: 3,
        method: "turn/start",
        params: {
          threadId: input.nativeThreadId,
          input: [{ type: "text", text: input.sentPrompt ?? input.prompt }],
          cwd: "/workspace",
          model: "gpt-5.4",
          approvalPolicy: "never",
          approvalsReviewer: "user",
          sandboxPolicy: { type: "dangerFullAccess" },
          summary: "detailed",
          ...(input.effort === undefined ? {} : { effort: input.effort }),
          collaborationMode: {
            mode: "default",
            settings: {
              model: "gpt-5.4",
              ...(input.effort === undefined ? {} : { reasoning_effort: input.effort }),
            },
          },
        },
      },
    },
    {
      type: "emit_inbound",
      label: "turn/start",
      frame: {
        id: 3,
        result: { turn: makeCodexReplayTurn({ id: input.nativeTurnId, status: "inProgress" }) },
      },
    },
    {
      type: "emit_inbound",
      label: "turn/started",
      frame: {
        method: "turn/started",
        params: {
          threadId: input.nativeThreadId,
          turn: makeCodexReplayTurn({ id: input.nativeTurnId, status: "inProgress" }),
        },
      },
    },
  ];
}

export function makeCodexReplayTranscript(input: {
  readonly scenario: string;
  readonly entries: ReadonlyArray<CodexReplay.CodexAppServerReplayEntry>;
}): CodexReplay.CodexAppServerReplayTranscript {
  return {
    provider: "codex",
    protocol: "codex.app-server",
    version: "0.144.0",
    scenario: input.scenario,
    entries: input.entries,
  };
}

export function withReplayRequestId(
  entry: CodexReplay.CodexAppServerReplayEntry,
  id: number,
): CodexReplay.CodexAppServerReplayEntry {
  return entry.type !== "runtime_exit" && Predicate.isObject(entry.frame)
    ? { ...entry, frame: { ...entry.frame, id } }
    : entry;
}

export const openReplaySession = (
  transcript: CodexReplay.CodexAppServerReplayTranscript,
  beforeEmitInbound?: CodexReplay.CodexAppServerReplayDriver["beforeEmitInbound"],
  compatibility?: CodexAdapterV2.CodexAdapterV2Options["compatibility"],
) =>
  Effect.gen(function* () {
    const driver = yield* CodexReplay.makeReplayDriver(
      transcript,
      beforeEmitInbound === undefined ? {} : { beforeEmitInbound },
    );
    let initializeRequests = 0;
    const adapter = yield* CodexAdapterV2.makeCodexAdapterV2({
      instanceId: CodexAdapterV2.CODEX_DEFAULT_INSTANCE_ID,
      settings: DEFAULT_CODEX_SETTINGS,
      environment: {},
      ...(compatibility === undefined ? {} : { compatibility }),
      clientFactory: {
        open: (openInput) =>
          Layer.build(CodexReplay.layerReplayWithDriver(driver)).pipe(
            Effect.flatMap((context) =>
              Effect.service(CodexClient.CodexAppServerClient).pipe(Effect.provide(context)),
            ),
            Effect.map(
              (client) =>
                ({
                  ...client,
                  request: (method, params) =>
                    Effect.sync(() => {
                      if (method === "initialize") initializeRequests++;
                    }).pipe(Effect.andThen(client.request(method, params))),
                }) satisfies CodexClient.CodexAppServerClient["Service"],
            ),
            Effect.mapError(
              (cause) =>
                new ProviderAdapter.ProviderAdapterOpenSessionError({
                  driver: CodexAdapterV2.CODEX_DRIVER_KIND,
                  providerSessionId: openInput.providerSessionId,
                  cause,
                }),
            ),
          ),
      },
      digest: yield* Digest.Digest,
      fileSystem: yield* FileSystem.FileSystem,
      idAllocator: yield* IdAllocator.IdAllocatorV2,
      serverConfig: yield* ProviderReplayHarness.makeReplayServerConfig(transcript.scenario).pipe(
        Effect.orDie,
      ),
    });
    const runtime = yield* adapter.openSession({
      threadId: ThreadId.make(`thread-${transcript.scenario}`),
      providerSessionId: ProviderSessionId.make(`provider-session-${transcript.scenario}`),
      modelSelection: CODEX_TEST_MODEL_SELECTION,
      runtimePolicy: CODEX_TEST_RUNTIME_POLICY,
    });
    return {
      ensureThread: (threadId: string) =>
        runtime.ensureThread({
          threadId: ThreadId.make(threadId),
          modelSelection: CODEX_TEST_MODEL_SELECTION,
          runtimePolicy: CODEX_TEST_RUNTIME_POLICY,
        }),
      initializeRequests: () => initializeRequests,
    };
  });

export const replayPreamble = (nativeThreadId: string) =>
  codexReplayPreamble({ nativeThreadId, nativeTurnId: "unused", prompt: "unused" });

export const makeChangeSignal = Effect.gen(function* () {
  const changes = yield* PubSub.unbounded<void>();
  const until = (predicate: () => boolean): Effect.Effect<void> =>
    Effect.scoped(
      Effect.gen(function* () {
        const subscription = yield* PubSub.subscribe(changes);
        while (!predicate()) yield* PubSub.take(subscription);
      }),
    );
  return { notify: PubSub.publish(changes, undefined), until };
});

export const makeCodexReplayHarness = (
  transcript: CodexReplay.CodexAppServerReplayTranscript,
  onEvent: (event: ProviderAdapter.ProviderAdapterV2Event) => Effect.Effect<unknown> = () =>
    Effect.void,
  onRequest: (method: string, params: unknown) => Effect.Effect<void> = () => Effect.void,
  readChildMetadata?: Parameters<typeof withCodexReplayChildMetadata>[2],
  beforeEmitInbound?: CodexReplay.CodexAppServerReplayDriver["beforeEmitInbound"],
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const idAllocator = yield* IdAllocator.IdAllocatorV2;
    const serverConfig = yield* ProviderReplayHarness.makeReplayServerConfig(
      transcript.scenario,
    ).pipe(Effect.orDie);
    const changes = yield* makeChangeSignal;
    const continuationRequests: Array<ProviderContinuationRequests.ProviderContinuationRequest> =
      [];
    const driver = yield* CodexReplay.makeReplayDriver(
      transcript,
      beforeEmitInbound === undefined ? {} : { beforeEmitInbound },
    );
    const clientFactory: CodexAdapterV2.CodexAppServerClientFactoryShape = {
      open: (openInput) =>
        Layer.build(CodexReplay.layerReplayWithDriver(driver)).pipe(
          Effect.mapError(
            (cause) =>
              new ProviderAdapter.ProviderAdapterOpenSessionError({
                driver: CodexAdapterV2.CODEX_DRIVER_KIND,
                providerSessionId: openInput.providerSessionId,
                cause,
              }),
          ),
          Effect.flatMap((context) =>
            Effect.service(CodexClient.CodexAppServerClient).pipe(
              Effect.map((client) =>
                withCodexReplayChildMetadata(client, transcript, readChildMetadata),
              ),
              Effect.map(
                (client) =>
                  ({
                    ...client,
                    request: (method, params) =>
                      onRequest(method, params).pipe(
                        Effect.andThen(client.request(method, params)),
                      ),
                    raw: {
                      ...client.raw,
                      request: (method, params) =>
                        onRequest(method, params).pipe(
                          Effect.andThen(client.raw.request(method, params)),
                        ),
                    },
                  }) satisfies CodexClient.CodexAppServerClient["Service"],
              ),
              Effect.provide(context),
            ),
          ),
        ),
    };
    const adapter = yield* CodexAdapterV2.makeCodexAdapterV2({
      instanceId: CodexAdapterV2.CODEX_DEFAULT_INSTANCE_ID,
      settings: DEFAULT_CODEX_SETTINGS,
      environment: {},
      clientFactory,
      digest: yield* Digest.Digest,
      fileSystem,
      idAllocator,
      serverConfig,
      continuationRequests: {
        offer: (request) =>
          Effect.sync(() => {
            continuationRequests.push(request);
          }).pipe(Effect.andThen(changes.notify)),
      },
    });
    const threadId = ThreadId.make(`thread-${transcript.scenario}`);
    const runtime = yield* adapter.openSession({
      threadId,
      providerSessionId: ProviderSessionId.make(`provider-session-${transcript.scenario}`),
      modelSelection: CODEX_TEST_MODEL_SELECTION,
      runtimePolicy: CODEX_TEST_RUNTIME_POLICY,
    });
    const providerThread = yield* runtime.ensureThread({
      threadId,
      modelSelection: CODEX_TEST_MODEL_SELECTION,
      runtimePolicy: CODEX_TEST_RUNTIME_POLICY,
    });
    const events: Array<ProviderAdapter.ProviderAdapterV2Event> = [];
    const firstTerminal = yield* Deferred.make<void>();
    yield* runtime.events.pipe(
      Stream.runForEach((event) =>
        Effect.sync(() => {
          events.push(event);
        }).pipe(
          Effect.andThen(
            event.type === "turn.terminal"
              ? Deferred.succeed(firstTerminal, undefined)
              : Effect.void,
          ),
          Effect.andThen(changes.notify),
          Effect.andThen(onEvent(event)),
        ),
      ),
      Effect.forkScoped,
    );
    if (runtime.hasPendingBackgroundWork === undefined) {
      return yield* Effect.die("Codex adapter runtime must expose hasPendingBackgroundWork.");
    }
    const hasPendingBackgroundWork = runtime.hasPendingBackgroundWork;
    const terminalEvents = () =>
      events.filter(
        (
          event,
        ): event is Extract<ProviderAdapter.ProviderAdapterV2Event, { type: "turn.terminal" }> =>
          event.type === "turn.terminal",
      );
    const subagentUpdates = () =>
      events.filter(
        (
          event,
        ): event is Extract<
          ProviderAdapter.ProviderAdapterV2Event,
          { type: "subagent.updated" }
        > => event.type === "subagent.updated",
      );
    return {
      runtime,
      providerThread,
      threadId,
      serverConfig,
      events,
      continuationRequests,
      terminalEvents,
      subagentUpdates,
      hasPendingBackgroundWork,
      firstTerminal: Deferred.await(firstTerminal),
      until: changes.until,
      awaitTerminal: (count: number) => changes.until(() => terminalEvents().length >= count),
    };
  });

export const assistantMessages = (events: ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event>) =>
  events.filter(
    (
      event,
    ): event is Extract<ProviderAdapter.ProviderAdapterV2Event, { type: "message.updated" }> =>
      event.type === "message.updated" && event.message.role === "assistant",
  );

export const finalAnswerTranscript = (
  scenario: string,
  answers: ReadonlyArray<{
    readonly id: string;
    readonly text: string;
    readonly phase?: "commentary" | "partial_answer" | "final_answer" | null;
    readonly omitPhase?: boolean;
    readonly streamed?: boolean;
    readonly completionDelayMs?: number;
  }>,
) => {
  const nativeThreadId = `native-${scenario}-thread`;
  const nativeTurnId = `native-${scenario}-turn`;
  const prompt = "Reply with the requested recovery marker.";
  return makeCodexReplayTranscript({
    scenario,
    entries: [
      ...codexReplayPreamble({ nativeThreadId, nativeTurnId, prompt }),
      ...answers.flatMap(
        (answer, index): ReadonlyArray<CodexReplay.CodexAppServerReplayEntry> => {
          const phase = answer.omitPhase
            ? {}
            : { phase: answer.phase === undefined ? ("final_answer" as const) : answer.phase };
          const completed: CodexReplay.CodexAppServerReplayEntry = {
            type: "emit_inbound",
            label: `item/completed/${answer.id}`,
            ...(answer.completionDelayMs === undefined
              ? {}
              : { afterMs: answer.completionDelayMs }),
            frame: {
              method: "item/completed",
              params: {
                item: {
                  type: "agentMessage",
                  id: answer.id,
                  text: answer.text,
                  ...phase,
                  memoryCitation: null,
                },
                threadId: nativeThreadId,
                turnId: nativeTurnId,
                completedAtMs: 1782622441000 + index,
              },
            },
          };
          if (!answer.streamed) {
            return [completed];
          }
          return [
            {
              type: "emit_inbound",
              label: `item/started/${answer.id}`,
              frame: {
                method: "item/started",
                params: {
                  item: {
                    type: "agentMessage",
                    id: answer.id,
                    text: "",
                    ...phase,
                    memoryCitation: null,
                  },
                  threadId: nativeThreadId,
                  turnId: nativeTurnId,
                  startedAtMs: 1782622440500 + index,
                },
              },
            },
            {
              type: "emit_inbound",
              label: `item/agentMessage/delta/${answer.id}`,
              frame: {
                method: "item/agentMessage/delta",
                params: {
                  threadId: nativeThreadId,
                  turnId: nativeTurnId,
                  itemId: answer.id,
                  delta: answer.text,
                },
              },
            },
            completed,
          ];
        },
      ),
      {
        type: "emit_inbound",
        label: "turn/completed",
        frame: {
          method: "turn/completed",
          params: {
            threadId: nativeThreadId,
            turn: makeCodexReplayTurn({ id: nativeTurnId, status: "completed" }),
          },
        },
      },
    ],
  });
};

export const BG_SCENARIO = "codex-bg-exec-wake";

export const BG_NATIVE_THREAD = "native-codex-bg-thread";

export const BG_NATIVE_TURN = "native-codex-bg-turn";

export const BG_COMMAND_ITEM = "call-codex-bg-command";

export const BG_COMMAND = "sleep 20 && echo CODEX_BG_WAKE_DONE";

export const BG_PROMPT = "Start the sleep in the background and reply STARTED.";

export const backgroundCommandItem = (status: "inProgress" | "completed"): Record<string, unknown> => ({
  type: "commandExecution",
  id: BG_COMMAND_ITEM,
  command: BG_COMMAND,
  cwd: "/workspace",
  processId: "4242",
  source: "unifiedExecStartup",
  status,
  commandActions: [{ type: "unknown", command: BG_COMMAND }],
  aggregatedOutput: status === "completed" ? "CODEX_BG_WAKE_DONE\n" : null,
  exitCode: status === "completed" ? 0 : null,
  durationMs: status === "completed" ? 25_000 : null,
});

