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

export const backgroundExecTranscript = makeCodexReplayTranscript({
  scenario: BG_SCENARIO,
  entries: [
    ...codexReplayPreamble({
      nativeThreadId: BG_NATIVE_THREAD,
      nativeTurnId: BG_NATIVE_TURN,
      prompt: BG_PROMPT,
    }),
    {
      type: "emit_inbound",
      label: "item/started/command",
      frame: {
        method: "item/started",
        params: {
          item: backgroundCommandItem("inProgress"),
          threadId: BG_NATIVE_THREAD,
          turnId: BG_NATIVE_TURN,
          startedAtMs: 1782622440500,
        },
      },
    },
    {
      type: "emit_inbound",
      label: "item/completed/root-answer",
      frame: {
        method: "item/completed",
        params: {
          item: {
            type: "agentMessage",
            id: "root-answer-bg",
            text: "STARTED",
            phase: "final_answer",
            memoryCitation: null,
          },
          threadId: BG_NATIVE_THREAD,
          turnId: BG_NATIVE_TURN,
          completedAtMs: 1782622441000,
        },
      },
    },
    {
      type: "emit_inbound",
      label: "turn/completed",
      frame: {
        method: "turn/completed",
        params: {
          threadId: BG_NATIVE_THREAD,
          turn: makeCodexReplayTurn({ id: BG_NATIVE_TURN, status: "completed" }),
        },
      },
    },
    {
      type: "emit_inbound",
      label: "item/completed/command-late",
      afterMs: 30_000,
      frame: {
        method: "item/completed",
        params: {
          item: backgroundCommandItem("completed"),
          threadId: BG_NATIVE_THREAD,
          turnId: BG_NATIVE_TURN,
          completedAtMs: 1782622465500,
        },
      },
    },
  ],
});

export const backgroundStopCases = [true, false, "still_running", "thread_unloaded"] as const;

export const makeBackgroundStopTranscript = (terminated: (typeof backgroundStopCases)[number]) => {
  const stillRunning = terminated === "still_running";
  return makeCodexReplayTranscript({
    scenario: `codex-bg-stop-${terminated}`,
    entries: [
      ...backgroundExecTranscript.entries.slice(0, -1),
      {
        type: "expect_outbound",
        label: "terminate-background-command",
        frame: {
          id: 4,
          method: "thread/backgroundTerminals/terminate",
          params: { threadId: BG_NATIVE_THREAD, processId: "4242" },
        },
      },
      {
        type: "emit_inbound",
        label: "terminate-background-command",
        frame:
          terminated === "thread_unloaded"
            ? {
                id: 4,
                error: { code: -32600, message: `thread not found: ${BG_NATIVE_THREAD}` },
              }
            : { id: 4, result: { terminated: terminated === true } },
      },
      ...(terminated === false || stillRunning
        ? [
            {
              type: "expect_outbound" as const,
              frame: {
                id: 5,
                method: "thread/backgroundTerminals/list",
                params: { threadId: BG_NATIVE_THREAD },
              },
            },
            {
              type: "emit_inbound" as const,
              frame: {
                id: 5,
                result: { data: stillRunning ? [{ processId: "4242" }] : [], nextCursor: null },
              },
            },
          ]
        : []),
      ...(stillRunning
        ? [
            {
              type: "expect_outbound" as const,
              frame: {
                id: 6,
                method: "thread/backgroundTerminals/terminate",
                params: { threadId: BG_NATIVE_THREAD, processId: "4242" },
              },
            },
            {
              type: "emit_inbound" as const,
              frame: { id: 6, result: { terminated: false } },
            },
            {
              type: "expect_outbound" as const,
              frame: {
                id: 7,
                method: "thread/backgroundTerminals/list",
                params: { threadId: BG_NATIVE_THREAD },
              },
            },
            {
              type: "emit_inbound" as const,
              frame: { id: 7, result: { data: [{ processId: "4242" }], nextCursor: null } },
            },
            {
              type: "expect_outbound" as const,
              frame: {
                id: 8,
                method: "thread/backgroundTerminals/terminate",
                params: { threadId: BG_NATIVE_THREAD, processId: "4242" },
              },
            },
            {
              type: "emit_inbound" as const,
              frame: { id: 8, result: { terminated: true } },
            },
          ]
        : []),
      backgroundExecTranscript.entries.at(-1)!,
    ],
  });
};

export const INTERRUPT_SCENARIO = "codex-interrupt-mid-command";

export const INTERRUPT_NATIVE_THREAD = "native-codex-interrupt-thread";

export const INTERRUPT_NATIVE_TURN = "native-codex-interrupt-turn";

export const INTERRUPT_COMMAND_ITEM = "exec-codex-interrupt-command";

export const INTERRUPT_COMMAND_ITEM_TWO = "exec-codex-interrupt-command-two";

export const INTERRUPT_CHILD_COMMAND_ITEM = "exec-codex-interrupt-child-command";

export const INTERRUPT_CHILD_NATIVE_THREAD = "native-codex-interrupt-child-thread";

export const INTERRUPT_CHILD_NATIVE_TURN = "native-codex-interrupt-child-turn";

export const INTERRUPT_LATE_CHILD_NATIVE_TURN = "native-codex-interrupt-late-child-turn";

export const INTERRUPT_COMMAND = "bash -c 'sleep 30; echo SHOULD_NOT_FINISH_CMD_INTERRUPT_FIXTURE'";

export const INTERRUPT_COMMAND_TWO = "bash -c 'sleep 20; echo SECOND_COMMAND'";

export const INTERRUPT_PROMPT = "Run a long foreground command and wait until interrupted.";

export const interruptCommandItem = (status: "inProgress" | "completed"): Record<string, unknown> => ({
  type: "commandExecution",
  id: INTERRUPT_COMMAND_ITEM,
  command: INTERRUPT_COMMAND,
  cwd: "/workspace",
  processId: "57680",
  source: "unifiedExecStartup",
  status,
  commandActions: [{ type: "unknown", command: INTERRUPT_COMMAND }],
  aggregatedOutput: status === "completed" ? "SHOULD_NOT_FINISH_CMD_INTERRUPT_FIXTURE\n" : null,
  exitCode: status === "completed" ? 0 : null,
  durationMs: status === "completed" ? 30_000 : null,
});

export const interruptMidCommandTranscript = makeCodexReplayTranscript({
  scenario: INTERRUPT_SCENARIO,
  entries: [
    ...codexReplayPreamble({
      nativeThreadId: INTERRUPT_NATIVE_THREAD,
      nativeTurnId: INTERRUPT_NATIVE_TURN,
      prompt: INTERRUPT_PROMPT,
    }),
    {
      type: "emit_inbound",
      label: "item/started/command",
      frame: {
        method: "item/started",
        params: {
          item: interruptCommandItem("inProgress"),
          threadId: INTERRUPT_NATIVE_THREAD,
          turnId: INTERRUPT_NATIVE_TURN,
          startedAtMs: 1782622440500,
        },
      },
    },
    {
      type: "expect_outbound",
      label: "turn/interrupt",
      frame: {
        id: 4,
        method: "turn/interrupt",
        params: {
          threadId: INTERRUPT_NATIVE_THREAD,
          turnId: INTERRUPT_NATIVE_TURN,
        },
      },
    },
    {
      type: "emit_inbound",
      label: "turn/interrupt",
      frame: { id: 4, result: {} },
    },
    {
      type: "emit_inbound",
      label: "item/started/command-two-after-interrupt-response",
      frame: {
        method: "item/started",
        params: {
          item: {
            ...interruptCommandItem("inProgress"),
            id: INTERRUPT_COMMAND_ITEM_TWO,
            command: INTERRUPT_COMMAND_TWO,
            processId: "57681",
            commandActions: [{ type: "unknown", command: INTERRUPT_COMMAND_TWO }],
          },
          threadId: INTERRUPT_NATIVE_THREAD,
          turnId: INTERRUPT_NATIVE_TURN,
          startedAtMs: 1782622440600,
        },
      },
    },
    {
      type: "emit_inbound",
      label: "turn/completed",
      frame: {
        method: "turn/completed",
        params: {
          threadId: INTERRUPT_NATIVE_THREAD,
          turn: makeCodexReplayTurn({
            id: INTERRUPT_NATIVE_TURN,
            status: "interrupted",
          }),
        },
      },
    },
    {
      type: "expect_outbound",
      label: "thread/backgroundTerminals/terminate/one",
      frame: {
        id: 5,
        method: "thread/backgroundTerminals/terminate",
        params: { threadId: INTERRUPT_NATIVE_THREAD, processId: "57680" },
      },
    },
    {
      type: "emit_inbound",
      label: "thread/backgroundTerminals/terminate/one",
      frame: { id: 5, result: { terminated: false } },
    },
    {
      type: "expect_outbound",
      label: "thread/backgroundTerminals/list/after-false",
      frame: {
        id: 6,
        method: "thread/backgroundTerminals/list",
        params: { threadId: INTERRUPT_NATIVE_THREAD },
      },
    },
    {
      type: "emit_inbound",
      label: "thread/backgroundTerminals/list/after-false",
      frame: { id: 6, result: { data: [], nextCursor: null } },
    },
    {
      type: "expect_outbound",
      label: "thread/backgroundTerminals/terminate/two",
      frame: {
        id: 7,
        method: "thread/backgroundTerminals/terminate",
        params: { threadId: INTERRUPT_NATIVE_THREAD, processId: "57681" },
      },
    },
    {
      type: "emit_inbound",
      label: "thread/backgroundTerminals/terminate/two",
      frame: { id: 7, result: { terminated: true } },
    },
    {
      type: "emit_inbound",
      label: "item/completed/command-late",
      afterMs: 30_000,
      frame: {
        method: "item/completed",
        params: {
          item: interruptCommandItem("completed"),
          threadId: INTERRUPT_NATIVE_THREAD,
          turnId: INTERRUPT_NATIVE_TURN,
          completedAtMs: 1782622465500,
        },
      },
    },
  ],
});

export const interruptSubagentCommandTranscript = makeCodexReplayTranscript({
  scenario: "codex-interrupt-subagent-command",
  entries: [
    ...codexReplayPreamble({
      nativeThreadId: INTERRUPT_NATIVE_THREAD,
      nativeTurnId: INTERRUPT_NATIVE_TURN,
      prompt: INTERRUPT_PROMPT,
    }),
    {
      type: "emit_inbound",
      label: "item/completed/subAgentActivity-started",
      frame: {
        method: "item/completed",
        params: {
          item: {
            type: "subAgentActivity",
            id: "call-codex-interrupt-subagent",
            kind: "started",
            agentThreadId: INTERRUPT_CHILD_NATIVE_THREAD,
            agentPath: "/root/stop_hold",
          },
          threadId: INTERRUPT_NATIVE_THREAD,
          turnId: INTERRUPT_NATIVE_TURN,
          completedAtMs: 1782622441000,
        },
      },
    },
    {
      type: "emit_inbound",
      label: "turn/started/child",
      frame: {
        method: "turn/started",
        params: {
          threadId: INTERRUPT_CHILD_NATIVE_THREAD,
          turn: makeCodexReplayTurn({
            id: INTERRUPT_CHILD_NATIVE_TURN,
            status: "inProgress",
          }),
        },
      },
    },
    {
      type: "emit_inbound",
      label: "item/started/child-command",
      frame: {
        method: "item/started",
        params: {
          item: {
            ...interruptCommandItem("inProgress"),
            id: INTERRUPT_CHILD_COMMAND_ITEM,
            processId: "57682",
          },
          threadId: INTERRUPT_CHILD_NATIVE_THREAD,
          turnId: INTERRUPT_CHILD_NATIVE_TURN,
          startedAtMs: 1782622441500,
        },
      },
    },
    {
      type: "expect_outbound",
      label: "turn/interrupt/root",
      frame: {
        id: 4,
        method: "turn/interrupt",
        params: {
          threadId: INTERRUPT_NATIVE_THREAD,
          turnId: INTERRUPT_NATIVE_TURN,
        },
      },
    },
    {
      type: "emit_inbound",
      label: "turn/interrupt/root",
      frame: { id: 4, result: {} },
    },
    {
      type: "expect_outbound",
      label: "turn/interrupt/child",
      frame: {
        id: 5,
        method: "turn/interrupt",
        params: {
          threadId: INTERRUPT_CHILD_NATIVE_THREAD,
          turnId: INTERRUPT_CHILD_NATIVE_TURN,
        },
      },
    },
    {
      type: "emit_inbound",
      label: "turn/interrupt/child",
      frame: { id: 5, result: {} },
    },
    {
      type: "expect_outbound",
      label: "thread/backgroundTerminals/terminate/child",
      frame: {
        id: 6,
        method: "thread/backgroundTerminals/terminate",
        params: { threadId: INTERRUPT_CHILD_NATIVE_THREAD, processId: "57682" },
      },
    },
    {
      type: "emit_inbound",
      label: "thread/backgroundTerminals/terminate/child",
      frame: { id: 6, result: { terminated: true } },
    },
    {
      type: "emit_inbound",
      label: "turn/completed/root",
      frame: {
        method: "turn/completed",
        params: {
          threadId: INTERRUPT_NATIVE_THREAD,
          turn: makeCodexReplayTurn({ id: INTERRUPT_NATIVE_TURN, status: "interrupted" }),
        },
      },
    },
    {
      type: "emit_inbound",
      label: "turn/completed/child-completed-race",
      frame: {
        method: "turn/completed",
        params: {
          threadId: INTERRUPT_CHILD_NATIVE_THREAD,
          turn: makeCodexReplayTurn({
            id: INTERRUPT_CHILD_NATIVE_TURN,
            status: "completed",
          }),
        },
      },
    },
    { type: "runtime_exit", status: "success" },
  ],
});

export const assertChildProviderTerminalBeforeRoot = (
  events: ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event>,
  rootThreadId: ThreadId,
) => {
  const terminalIndex = events.findIndex((event) => event.type === "turn.terminal");
  const childProviderTurnIndex = events.findIndex(
    (event) =>
      event.type === "provider_turn.updated" &&
      event.threadId !== rootThreadId &&
      event.providerTurn.status === "interrupted",
  );
  const childProviderThreadIndex = events.findIndex(
    (event) =>
      event.type === "provider_thread.updated" &&
      event.providerThread.appThreadId !== rootThreadId &&
      event.providerThread.status === "idle",
  );
  assert.isAtLeast(childProviderTurnIndex, 0, "child provider turn must terminalize");
  assert.isAtLeast(childProviderThreadIndex, 0, "child provider thread must become idle");
  assert.isAbove(
    terminalIndex,
    childProviderTurnIndex,
    "child provider turn must terminalize before the root run",
  );
  assert.isAbove(
    terminalIndex,
    childProviderThreadIndex,
    "child provider thread must become idle before the root run",
  );
};

export const rootCompletionIndex = interruptSubagentCommandTranscript.entries.findIndex(
  (entry) => entry.type === "emit_inbound" && entry.label === "turn/completed/root",
);

export const interruptLateSubagentTurnTranscript = makeCodexReplayTranscript({
  scenario: "codex-interrupt-late-subagent-turn",
  entries: [
    ...interruptSubagentCommandTranscript.entries.slice(0, rootCompletionIndex),
    {
      type: "emit_inbound",
      label: "turn/started/late-child",
      frame: {
        method: "turn/started",
        params: {
          threadId: INTERRUPT_CHILD_NATIVE_THREAD,
          turn: makeCodexReplayTurn({
            id: INTERRUPT_LATE_CHILD_NATIVE_TURN,
            status: "inProgress",
          }),
        },
      },
    },
    ...interruptSubagentCommandTranscript.entries.slice(rootCompletionIndex, -1),
    {
      type: "expect_outbound",
      label: "turn/interrupt/late-child",
      frame: {
        id: 7,
        method: "turn/interrupt",
        params: {
          threadId: INTERRUPT_CHILD_NATIVE_THREAD,
          turnId: INTERRUPT_LATE_CHILD_NATIVE_TURN,
        },
      },
    },
    {
      type: "emit_inbound",
      label: "turn/interrupt/late-child",
      frame: { id: 7, result: {} },
    },
    { type: "runtime_exit", status: "success" },
  ],
});

export const interruptSubagentTurnAfterStopTranscript = makeCodexReplayTranscript({
  scenario: "codex-interrupt-subagent-turn-after-stop",
  entries: [
    ...interruptSubagentCommandTranscript.entries.slice(0, -1),
    {
      type: "emit_inbound",
      label: "turn/started/child-after-stop",
      frame: {
        method: "turn/started",
        params: {
          threadId: INTERRUPT_CHILD_NATIVE_THREAD,
          turn: makeCodexReplayTurn({
            id: INTERRUPT_LATE_CHILD_NATIVE_TURN,
            status: "inProgress",
          }),
        },
      },
    },
    {
      type: "expect_outbound",
      label: "turn/interrupt/child-after-stop",
      frame: {
        id: 7,
        method: "turn/interrupt",
        params: {
          threadId: INTERRUPT_CHILD_NATIVE_THREAD,
          turnId: INTERRUPT_LATE_CHILD_NATIVE_TURN,
        },
      },
    },
    {
      type: "emit_inbound",
      label: "turn/interrupt/child-after-stop",
      frame: { id: 7, result: {} },
    },
    {
      type: "emit_inbound",
      label: "thread/goal/updated/root",
      frame: {
        method: "thread/goal/updated",
        params: {
          threadId: INTERRUPT_NATIVE_THREAD,
          turnId: null,
          goal: {
            threadId: INTERRUPT_NATIVE_THREAD,
            objective: INTERRUPT_PROMPT,
            status: "paused",
            tokenBudget: null,
            tokensUsed: 0,
            timeUsedSeconds: 0,
            createdAt: 1782622440,
            updatedAt: 1782622450,
          },
        },
      },
    },
    { type: "runtime_exit", status: "success" },
  ],
});

export const FAILED_SCENARIO = "codex-failed-mid-command";

export const FAILED_NATIVE_THREAD = "native-codex-failed-thread";

export const FAILED_NATIVE_TURN = "native-codex-failed-turn";

export const FAILED_COMMAND_ITEM = "exec-codex-failed-command";

export const FAILED_COMMAND = "sleep 30";

export const FAILED_PROMPT = "Run a command that will be abandoned when the turn fails.";

export const failedMidCommandTranscript = makeCodexReplayTranscript({
  scenario: FAILED_SCENARIO,
  entries: [
    ...codexReplayPreamble({
      nativeThreadId: FAILED_NATIVE_THREAD,
      nativeTurnId: FAILED_NATIVE_TURN,
      prompt: FAILED_PROMPT,
    }),
    {
      type: "emit_inbound",
      label: "item/started/command",
      frame: {
        method: "item/started",
        params: {
          item: {
            type: "commandExecution",
            id: FAILED_COMMAND_ITEM,
            command: FAILED_COMMAND,
            cwd: "/workspace",
            processId: "99",
            source: "unifiedExecStartup",
            status: "inProgress",
            commandActions: [{ type: "unknown", command: FAILED_COMMAND }],
            aggregatedOutput: null,
            exitCode: null,
            durationMs: null,
          },
          threadId: FAILED_NATIVE_THREAD,
          turnId: FAILED_NATIVE_TURN,
          startedAtMs: 1782622440500,
        },
      },
    },
    {
      type: "emit_inbound",
      label: "turn/completed",
      frame: {
        method: "turn/completed",
        params: {
          threadId: FAILED_NATIVE_THREAD,
          turn: {
            ...makeCodexReplayTurn({
              id: FAILED_NATIVE_TURN,
              status: "failed",
            }),
            error: { message: "provider failed mid-command" },
          },
        },
      },
    },
  ],
});

export const MCP_APP_SCENARIO = "codex-mcp-app-capture";

export const MCP_APP_NATIVE_THREAD = "native-codex-mcp-app-thread";

export const MCP_APP_NATIVE_TURN = "native-codex-mcp-app-turn";

export const MCP_APP_ITEM = "mcp-weather-call";

export const MCP_APP_PROMPT = "Show the weather in Oslo.";

export const MCP_APP_RESOURCE = "ui://weather/dashboard";

export const MCP_APP_HTML = "<!doctype html><html><body><p>Weather</p><script>1</script></body></html>";

export const mcpAppToolItem = (status: "inProgress" | "completed") => ({
  type: "mcpToolCall",
  id: MCP_APP_ITEM,
  server: "weather",
  tool: "get_weather",
  status,
  arguments: { city: "Oslo" },
  mcpAppResourceUri: MCP_APP_RESOURCE,
  ...(status === "completed"
    ? { result: { content: [{ type: "text", text: "Sunny" }], structuredContent: { temp: 21 } } }
    : {}),
});

export const mcpAppTranscript = makeCodexReplayTranscript({
  scenario: MCP_APP_SCENARIO,
  entries: [
    ...codexReplayPreamble({
      nativeThreadId: MCP_APP_NATIVE_THREAD,
      nativeTurnId: MCP_APP_NATIVE_TURN,
      prompt: MCP_APP_PROMPT,
    }),
    {
      type: "emit_inbound",
      label: "item/started/app-tool",
      frame: {
        method: "item/started",
        params: {
          item: mcpAppToolItem("inProgress"),
          threadId: MCP_APP_NATIVE_THREAD,
          turnId: MCP_APP_NATIVE_TURN,
          startedAtMs: 1782622440500,
        },
      },
    },
    {
      type: "emit_inbound",
      label: "item/completed/app-tool",
      frame: {
        method: "item/completed",
        params: {
          item: mcpAppToolItem("completed"),
          threadId: MCP_APP_NATIVE_THREAD,
          turnId: MCP_APP_NATIVE_TURN,
          completedAtMs: 1782622441500,
        },
      },
    },
    {
      type: "emit_inbound",
      label: "turn/completed",
      frame: {
        method: "turn/completed",
        params: {
          threadId: MCP_APP_NATIVE_THREAD,
          turn: makeCodexReplayTurn({ id: MCP_APP_NATIVE_TURN, status: "completed" }),
        },
      },
    },
    {
      type: "expect_outbound",
      label: "mcpServer/resource/read",
      frame: {
        id: 4,
        method: "mcpServer/resource/read",
        params: { threadId: MCP_APP_NATIVE_THREAD, server: "weather", uri: MCP_APP_RESOURCE },
      },
    },
    {
      type: "emit_inbound",
      label: "mcpServer/resource/read",
      frame: {
        id: 4,
        result: {
          contents: [
            {
              uri: MCP_APP_RESOURCE,
              mimeType: "text/html;profile=mcp-app",
              text: MCP_APP_HTML,
              _meta: { ui: { csp: { connectDomains: ["https://api.weather.test"] } } },
            },
          ],
        },
      },
    },
  ],
});

export const MCP_APP_DEFERRED_RESULT = {
  content: [{ type: "text", text: "An interactive form is being shown to the user." }],
  structuredContent: { status: "awaiting_user_submission" },
};

export const mcpAppDeferredTranscript = makeCodexReplayTranscript({
  scenario: MCP_APP_SCENARIO,
  entries: mcpAppTranscript.entries.map((entry) =>
    entry.type === "emit_inbound" && entry.label === "item/completed/app-tool"
      ? {
          ...entry,
          frame: {
            method: "item/completed",
            params: {
              item: {
                ...mcpAppToolItem("inProgress"),
                status: "failed",
                result: MCP_APP_DEFERRED_RESULT,
              },
              threadId: MCP_APP_NATIVE_THREAD,
              turnId: MCP_APP_NATIVE_TURN,
              completedAtMs: 1782622441500,
            },
          },
        }
      : entry,
  ),
});

export const ORPHAN_WAIT_SCENARIO = "codex-orphaned-dynamic-tool";

export const ORPHAN_WAIT_NATIVE_THREAD = "native-codex-orphan-wait-thread";

export const ORPHAN_WAIT_NATIVE_TURN = "native-codex-orphan-wait-turn";

export const ORPHAN_WAIT_ITEM = "exec-4669f3bb-78c9-4af1-b44e-daa340d2c538";

export const PERSISTENT_MONITOR_ITEM = "exec-persistent-monitor";

export const COMPLETED_WAIT_ITEM = "exec-completed-wait";

export const ORPHAN_WAIT_PROMPT = "Wait on two nested tasks, then finish.";

export const orphanedDynamicToolTranscript = makeCodexReplayTranscript({
  scenario: ORPHAN_WAIT_SCENARIO,
  entries: [
    ...codexReplayPreamble({
      nativeThreadId: ORPHAN_WAIT_NATIVE_THREAD,
      nativeTurnId: ORPHAN_WAIT_NATIVE_TURN,
      prompt: ORPHAN_WAIT_PROMPT,
    }),
    {
      type: "emit_inbound",
      label: "item/started/completed-wait",
      frame: {
        method: "item/started",
        params: {
          item: {
            type: "mcpToolCall",
            id: COMPLETED_WAIT_ITEM,
            server: "t3-code",
            tool: "t3_thread_wait",
            status: "inProgress",
            arguments: { threadId: "thread:completed-wait", timeoutMs: 30000 },
          },
          threadId: ORPHAN_WAIT_NATIVE_THREAD,
          turnId: ORPHAN_WAIT_NATIVE_TURN,
          startedAtMs: 1782622440500,
        },
      },
    },
    {
      type: "emit_inbound",
      label: "item/completed/completed-wait",
      frame: {
        method: "item/completed",
        params: {
          item: {
            type: "mcpToolCall",
            id: COMPLETED_WAIT_ITEM,
            server: "t3-code",
            tool: "t3_thread_wait",
            status: "completed",
            arguments: { threadId: "thread:completed-wait", timeoutMs: 30000 },
            result: { content: [{ type: "text", text: "idle" }] },
          },
          threadId: ORPHAN_WAIT_NATIVE_THREAD,
          turnId: ORPHAN_WAIT_NATIVE_TURN,
          completedAtMs: 1782622441500,
        },
      },
    },
    {
      type: "emit_inbound",
      label: "item/started/orphan-wait",
      frame: {
        method: "item/started",
        params: {
          item: {
            type: "mcpToolCall",
            id: ORPHAN_WAIT_ITEM,
            server: "t3-code",
            tool: "t3_thread_wait",
            status: "inProgress",
            arguments: {
              threadId:
                "thread:delegated-task:command%3Amcp%3Aaafffab1-e811-458a-ae83-558e542c61ff%3Adelegate-task%3Areview-mobile-reconnect-opus-20260815",
              timeoutMs: 30000,
            },
          },
          threadId: ORPHAN_WAIT_NATIVE_THREAD,
          turnId: ORPHAN_WAIT_NATIVE_TURN,
          startedAtMs: 1782622442500,
        },
      },
    },
    {
      type: "emit_inbound",
      label: "item/started/persistent-monitor",
      frame: {
        method: "item/started",
        params: {
          item: {
            type: "dynamicToolCall",
            id: PERSISTENT_MONITOR_ITEM,
            namespace: "grok",
            tool: "monitor",
            status: "inProgress",
            arguments: { persistent: true, command: "tail -f" },
          },
          threadId: ORPHAN_WAIT_NATIVE_THREAD,
          turnId: ORPHAN_WAIT_NATIVE_TURN,
          startedAtMs: 1782622443500,
        },
      },
    },
    {
      type: "emit_inbound",
      label: "turn/completed",
      frame: {
        method: "turn/completed",
        params: {
          threadId: ORPHAN_WAIT_NATIVE_THREAD,
          turn: makeCodexReplayTurn({
            id: ORPHAN_WAIT_NATIVE_TURN,
            status: "completed",
          }),
        },
      },
    },
    {
      type: "emit_inbound",
      label: "item/completed/persistent-monitor",
      afterMs: 30_000,
      frame: {
        method: "item/completed",
        params: {
          item: {
            type: "dynamicToolCall",
            id: PERSISTENT_MONITOR_ITEM,
            namespace: "grok",
            tool: "monitor",
            status: "completed",
            arguments: { persistent: true, command: "tail -f" },
            result: { content: [{ type: "text", text: "stopped" }] },
          },
          threadId: ORPHAN_WAIT_NATIVE_THREAD,
          turnId: ORPHAN_WAIT_NATIVE_TURN,
          completedAtMs: 1782622473500,
        },
      },
    },
  ],
});

export const RESUME_SCENARIO = "codex-resume-subagent";

export const RESUME_NATIVE_THREAD = "native-codex-resume-thread";

export const RESUME_NATIVE_TURN = "native-codex-resume-root-turn";

export const RESUME_CHILD_THREAD = "native-codex-resume-child-thread";

export const RESUME_CHILD_TURN_1 = "native-codex-resume-child-turn-1";

export const RESUME_CHILD_TURN_2 = "native-codex-resume-child-turn-2";

export const RESUME_PROMPT = "Spawn a sub-agent, nudge it, and reply NUDGED.";

export const childAgentMessage = (input: {
  readonly id: string;
  readonly text: string;
  readonly turnId: string;
  readonly completedAtMs: number;
  readonly afterMs?: number;
  readonly omitPhase?: boolean;
}): CodexReplay.CodexAppServerReplayEntry => ({
  type: "emit_inbound",
  label: `item/completed/${input.id}`,
  ...(input.afterMs === undefined ? {} : { afterMs: input.afterMs }),
  frame: {
    method: "item/completed",
    params: {
      item: {
        type: "agentMessage",
        id: input.id,
        text: input.text,
        ...(input.omitPhase ? {} : { phase: "final_answer" as const }),
        memoryCitation: null,
      },
      threadId: RESUME_CHILD_THREAD,
      turnId: input.turnId,
      completedAtMs: input.completedAtMs,
    },
  },
});

export const childTurnStarted = (
  turnId: string,
  afterMs?: number,
): CodexReplay.CodexAppServerReplayEntry => ({
  type: "emit_inbound",
  label: `turn/started/${turnId}`,
  ...(afterMs === undefined ? {} : { afterMs }),
  frame: {
    method: "turn/started",
    params: {
      threadId: RESUME_CHILD_THREAD,
      turn: {
        ...makeCodexReplayTurn({ id: turnId, status: "inProgress" }),
        startedAt: turnId === RESUME_CHILD_TURN_2 ? 1782622470 : 1782622440,
      },
    },
  },
});

export const childTurnCompleted = (
  turnId: string,
  afterMs?: number,
): CodexReplay.CodexAppServerReplayEntry => ({
  type: "emit_inbound",
  label: `turn/completed/${turnId}`,
  ...(afterMs === undefined ? {} : { afterMs }),
  frame: {
    method: "turn/completed",
    params: {
      threadId: RESUME_CHILD_THREAD,
      turn: makeCodexReplayTurn({ id: turnId, status: "completed" }),
    },
  },
});

export const resumeSubagentTranscript = makeCodexReplayTranscript({
  scenario: RESUME_SCENARIO,
  entries: [
    ...codexReplayPreamble({
      nativeThreadId: RESUME_NATIVE_THREAD,
      nativeTurnId: RESUME_NATIVE_TURN,
      prompt: RESUME_PROMPT,
    }),
    {
      type: "emit_inbound",
      label: "item/completed/subAgentActivity-started",
      frame: {
        method: "item/completed",
        params: {
          item: {
            type: "subAgentActivity",
            id: "call-codex-resume-spawn",
            kind: "started",
            agentThreadId: RESUME_CHILD_THREAD,
            agentPath: "/root/resume_agent",
          },
          threadId: RESUME_NATIVE_THREAD,
          turnId: RESUME_NATIVE_TURN,
          completedAtMs: 1782622441000,
        },
      },
    },
    childTurnStarted(RESUME_CHILD_TURN_1),
    childAgentMessage({
      id: "child-first-answer",
      text: "CODEX_FIRST_DONE",
      turnId: RESUME_CHILD_TURN_1,
      completedAtMs: 1782622442000,
    }),
    childAgentMessage({
      id: "child-first-answer-empty",
      text: "",
      turnId: RESUME_CHILD_TURN_1,
      completedAtMs: 1782622442001,
      omitPhase: true,
    }),
    childAgentMessage({
      id: "child-first-answer-duplicate",
      text: "CODEX_FIRST_DONE",
      turnId: RESUME_CHILD_TURN_1,
      completedAtMs: 1782622442002,
    }),
    childTurnCompleted(RESUME_CHILD_TURN_1, 100),
    {
      type: "emit_inbound",
      label: "item/completed/root-answer",
      frame: {
        method: "item/completed",
        params: {
          item: {
            type: "agentMessage",
            id: "root-answer-resume",
            text: "NUDGED",
            phase: "final_answer",
            memoryCitation: null,
          },
          threadId: RESUME_NATIVE_THREAD,
          turnId: RESUME_NATIVE_TURN,
          completedAtMs: 1782622443000,
        },
      },
    },
    {
      type: "emit_inbound",
      label: "turn/completed/root",
      frame: {
        method: "turn/completed",
        params: {
          threadId: RESUME_NATIVE_THREAD,
          turn: makeCodexReplayTurn({ id: RESUME_NATIVE_TURN, status: "completed" }),
        },
      },
    },
    childTurnStarted(RESUME_CHILD_TURN_2, 30_000),
    childAgentMessage({
      id: "child-resume-answer",
      text: "CODEX_RESUME_DONE",
      turnId: RESUME_CHILD_TURN_2,
      completedAtMs: 1782622480000,
      afterMs: 30_000,
    }),
    childTurnCompleted(RESUME_CHILD_TURN_2),
  ],
});

export const lateChildPrefix = () => {
  const entries = resumeSubagentTranscript.entries;
  const labelIndex = (label: string) =>
    entries.findIndex((entry) => entry.type === "emit_inbound" && entry.label === label);
  const rootCompleted = labelIndex("turn/completed/root");
  return {
    spawned: entries.slice(0, labelIndex(`turn/started/${RESUME_CHILD_TURN_1}`) + 1),
    rootFinished: entries.slice(rootCompleted - 1, rootCompleted + 1),
  };
};

export const codexReplayThreadResult = (input: {
  readonly nativeThreadId: string;
  readonly forkedFromId: string | null;
}) => ({
  thread: {
    id: input.nativeThreadId,
    sessionId: input.nativeThreadId,
    forkedFromId: input.forkedFromId,
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
});

export const errorCauseChainText = (error: unknown): string =>
  error instanceof Error ? `${error.message} ${errorCauseChainText(error.cause)}` : String(error);

export const codexReplaySourceTurn = (input: {
  readonly id: string;
  readonly ordinal: number;
  readonly nativeId: string | null;
  readonly providerThreadId: ProviderThreadId;
  readonly now: DateTime.Utc;
}): OrchestrationV2ProviderTurn => ({
  id: ProviderTurnId.make(input.id),
  providerThreadId: input.providerThreadId,
  nodeId: NodeId.make(`node-${input.id}`),
  runAttemptId: RunAttemptId.make(`run-attempt-${input.id}`),
  nativeTurnRef:
    input.nativeId === null
      ? { driver: CodexAdapterV2.CODEX_DRIVER_KIND, nativeId: null, strength: "none" }
      : {
          driver: CodexAdapterV2.CODEX_DRIVER_KIND,
          nativeId: input.nativeId,
          strength: "strong",
        },
  ordinal: input.ordinal,
  status: "completed",
  startedAt: input.now,
  completedAt: input.now,
});

export const nativeThreadId = "goal-thread";

export const objective = "Ship the feature";

export const codexGoal = (status: string, tokensUsed: number) => ({
  threadId: nativeThreadId,
  objective,
  status,
  tokenBudget: null,
  tokensUsed,
  timeUsedSeconds: 3,
  createdAt: 1782622440,
  updatedAt: 1782622450,
});

export const notification = (
  label: string,
  method: string,
  params: unknown,
): CodexReplay.CodexAppServerReplayEntry => ({
  type: "emit_inbound",
  label,
  frame: { method, params },
});

export const request = (id: number, method: string, params: unknown, result: unknown) =>
  [
    { type: "expect_outbound", label: method, frame: { id, method, params } },
    { type: "emit_inbound", label: method, frame: { id, result } },
  ] satisfies Array<CodexReplay.CodexAppServerReplayEntry>;

export const withReplayRequestId_2 = (
  entries: ReadonlyArray<CodexReplay.CodexAppServerReplayEntry>,
  id: number,
) =>
  entries.map((entry) =>
    "frame" in entry && Predicate.isObject(entry.frame) && "id" in entry.frame
      ? { ...entry, frame: { ...entry.frame, id } }
      : entry,
  );

export const sessionStart = codexReplayPreamble({
  nativeThreadId,
  nativeTurnId: "unused",
  prompt: "unused",
}).slice(0, 5);

export const goalTurnInput = (
  harness: {
    readonly threadId: ThreadId;
    readonly providerThread: OrchestrationV2ProviderThread;
  },
  text: string,
) =>
  DateTime.now.pipe(
    Effect.map((now) =>
      makeCodexTestTurnInput({
        threadId: harness.threadId,
        providerThread: harness.providerThread,
        now,
        attemptId: RunAttemptId.make("goal-attempt"),
        text,
      }),
    ),
  );

export const providerGoals = (events: ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event>) =>
  events.flatMap((event) =>
    event.type === "provider_thread.updated" ? [event.providerThread.goal?.status ?? null] : [],
  );

export const nativeThreadId_2 = "file-approval-thread";

export const nativeTurnId = "file-approval-turn";

export const prompt = "Edit the files.";

export type FileUpdateChange = CodexSchema.V2ItemStartedNotification__FileUpdateChange;

export const addA: FileUpdateChange = { path: "/w/a.ts", kind: { type: "add" }, diff: "export {};" };

export const updateB: FileUpdateChange = {
  path: "/w/b.ts",
  kind: { type: "update", move_path: null },
  diff: "@@",
};

export const renameC: FileUpdateChange = {
  path: "/w/c.ts",
  kind: { type: "update", move_path: "/w/d.ts" },
  diff: "@@",
};

export const deleteE: FileUpdateChange = { path: "/w/e.ts", kind: { type: "delete" }, diff: "gone" };

export const fileChange = (
  phase: "started" | "completed",
  turnId: string,
  itemId: string,
  changes: ReadonlyArray<FileUpdateChange>,
): CodexReplay.CodexAppServerReplayEntry => ({
  type: "emit_inbound",
  label: `${phase} ${itemId}`,
  frame: {
    method: `item/${phase}`,
    params: {
      threadId: nativeThreadId_2,
      turnId,
      ...(phase === "started" ? { startedAtMs: 1 } : { completedAtMs: 3 }),
      item: {
        type: "fileChange",
        id: itemId,
        status: phase === "started" ? "inProgress" : "completed",
        changes,
      },
    },
  },
});

export const approval = (input: {
  readonly id: number;
  readonly turnId: string;
  readonly itemId: string;
}): Array<CodexReplay.CodexAppServerReplayEntry> => [
  {
    type: "emit_inbound",
    label: `approval ${input.itemId}`,
    frame: {
      id: input.id,
      method: "item/fileChange/requestApproval",
      params: {
        threadId: nativeThreadId_2,
        turnId: input.turnId,
        itemId: input.itemId,
        startedAtMs: 2,
        reason: null,
        grantRoot: null,
      },
    },
  },
  {
    type: "expect_outbound",
    label: `approval ${input.itemId}`,
    frame: { id: input.id, result: { decision: "accept" } },
  },
];

export const turnCompleted = (turnId: string): CodexReplay.CodexAppServerReplayEntry => ({
  type: "emit_inbound",
  label: `complete ${turnId}`,
  frame: {
    method: "turn/completed",
    params: {
      threadId: nativeThreadId_2,
      turn: makeCodexReplayTurn({ id: turnId, status: "completed" }),
    },
  },
});

export const startApprovalTurn = (
  scenario: string,
  entries: ReadonlyArray<CodexReplay.CodexAppServerReplayEntry>,
) =>
  Effect.gen(function* () {
    const pending = yield* Queue.unbounded<OrchestrationV2RuntimeRequest>();
    const harness = yield* makeCodexReplayHarness(
      makeCodexReplayTranscript({
        scenario,
        entries: [...codexReplayPreamble({ nativeThreadId, nativeTurnId, prompt }), ...entries],
      }),
      (event) =>
        event.type === "runtime_request.updated" && event.runtimeRequest.status === "pending"
          ? Queue.offer(pending, event.runtimeRequest)
          : Effect.void,
    );
    yield* harness.runtime.startTurn(
      makeCodexTestTurnInput({
        threadId: harness.threadId,
        providerThread: harness.providerThread,
        now: yield* DateTime.now,
        attemptId: RunAttemptId.make(`${scenario}-attempt`),
        text: prompt,
      }),
    );
    return {
      harness,
      answerNext: Queue.take(pending).pipe(
        Effect.tap((request) =>
          harness.runtime.respondToRuntimeRequest({
            requestId: request.id,
            decision: "accept",
          }),
        ),
      ),
    };
  });

export const approvalItem = (
  events: ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event>,
  request: OrchestrationV2RuntimeRequest,
) =>
  events.flatMap((event) =>
    event.type === "turn_item.updated" &&
    event.turnItem.type === "approval_request" &&
    event.turnItem.requestId === request.id
      ? [event.turnItem]
      : [],
  )[0];
