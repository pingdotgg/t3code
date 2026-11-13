// Capture tool, not a test of the adapter. `run.sh` copies this file next to
// ClaudeAdapterV2.test.ts in the monorepo and runs it with vitest. It feeds recorded `claude` CLI
// transcripts (ndjson) through ClaudeAdapterV2 using the wake harness copied from that test file,
// and writes the events the adapter emitted. See README.md.
// @effect-diagnostics nodeBuiltinImport:off -- workflow fixtures use files and the fake Claude CLI uses Node streams
import * as NodeFS from "node:fs";
import * as ClaudeSdk from "@anthropic-ai/claude-agent-sdk";
import { beforeEach, vi } from "vite-plus/test";

import type { SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ChatAttachmentId,
  ChatImageAttachment,
  ClaudeSettings,
  MessageId,
  type ModelSelection,
  NodeId,
  type OrchestrationV2AppThread,
  OrchestrationV2ProviderThread,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import { describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import { type ClaudeModelCatalog } from "../../provider/ClaudeModelCatalog.ts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import type * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import * as ClaudeAdapterV2 from "./ClaudeAdapterV2.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
vi.mock("@anthropic-ai/claude-agent-sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof ClaudeSdk>()),
  resolveSettings: vi.fn(),
}));

beforeEach(() => {
  vi.mocked(ClaudeSdk.resolveSettings).mockReset().mockResolvedValue({
    effective: {},
    provenance: {},
    sources: [],
  });
});

const DEFAULT_CLAUDE_SETTINGS = Schema.decodeSync(ClaudeSettings)({});
const CLAUDE_TEST_MODEL_SELECTION = {
  instanceId: ProviderInstanceId.make(ClaudeAdapterV2.CLAUDE_PROVIDER),
  model: "claude-sonnet-4-6",
  options: [{ id: "effort", value: "ultrathink" }],
} satisfies ModelSelection;
const CLAUDE_TEST_RUNTIME_POLICY = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
  runtimeMode: "full-access",
  interactionMode: "default",
  cwd: "/workspace",
});

function makeClaudeTestAppThread(input: {
  readonly threadId: ThreadId;
  readonly providerThread: OrchestrationV2ProviderThread;
  readonly now: DateTime.Utc;
  readonly runtimeMode?: "full-access" | "approval-required";
}): OrchestrationV2AppThread {
  return {
    createdBy: "user",
    creationSource: "web",
    id: input.threadId,
    projectId: ProjectId.make(`project-${input.threadId}`),
    title: "Claude attachment test",
    providerInstanceId: ProviderInstanceId.make(ClaudeAdapterV2.CLAUDE_PROVIDER),
    modelSelection: CLAUDE_TEST_MODEL_SELECTION,
    runtimeMode: input.runtimeMode ?? "full-access",
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

function makeClaudeTestTurnInput(input: {
  readonly threadId: ThreadId;
  readonly providerThread: OrchestrationV2ProviderThread;
  readonly now: DateTime.Utc;
  readonly attemptId: RunAttemptId;
  readonly text: string;
  readonly attachments: ProviderAdapter.ProviderAdapterV2TurnInput["message"]["attachments"];
  readonly providerTurnOrdinal?: number;
  readonly nativeThreadHasTurns?: boolean;
  readonly messageCreatedBy?: ProviderAdapter.ProviderAdapterV2TurnInput["message"]["createdBy"];
  readonly messageCreationSource?: ProviderAdapter.ProviderAdapterV2TurnInput["message"]["creationSource"];
  readonly modelSelection?: ModelSelection;
  readonly runtimePolicy?: ProviderAdapter.ProviderAdapterV2RuntimePolicy;
}): ProviderAdapter.ProviderAdapterV2TurnInput {
  return {
    appThread: makeClaudeTestAppThread({
      ...input,
      runtimeMode:
        input.runtimePolicy?.runtimeMode === "approval-required"
          ? "approval-required"
          : "full-access",
    }),
    threadId: input.threadId,
    runId: RunId.make(`run-${input.attemptId}`),
    runOrdinal: 1,
    providerTurnOrdinal: input.providerTurnOrdinal ?? 1,
    ...(input.nativeThreadHasTurns === undefined
      ? {}
      : { nativeThreadHasTurns: input.nativeThreadHasTurns }),
    attemptId: input.attemptId,
    rootNodeId: NodeId.make(`node-${input.attemptId}`),
    providerThread: input.providerThread,
    message: {
      createdBy: input.messageCreatedBy ?? "user",
      creationSource: input.messageCreationSource ?? "web",
      messageId: MessageId.make(`message-${input.attemptId}`),
      text: input.text,
      attachments: input.attachments,
    },
    modelSelection: input.modelSelection ?? CLAUDE_TEST_MODEL_SELECTION,
    runtimePolicy: input.runtimePolicy ?? CLAUDE_TEST_RUNTIME_POLICY,
  };
}

const WAKE_NATIVE_SESSION = "native-thread-claude-wake";
function claudeSdkFrame(frame: unknown): SDKMessage {
  if (
    typeof frame !== "object" ||
    frame === null ||
    typeof Reflect.get(frame, "type") !== "string"
  ) {
    throw new Error("Frame is not a Claude Agent SDK message.");
  }
  return frame as SDKMessage;
}

// Harnesses notify after every recorded event, continuation, or prompt, so a
// wait re-checks exactly when the state it reads changes. Subscribing before
// the first check means a change that lands in between is not lost.
const makeChangeSignal = Effect.gen(function* () {
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

const makeWakeHarnessWithOptions = (options?: {
  readonly runtimePolicy?: ProviderAdapter.ProviderAdapterV2RuntimePolicy;
  readonly close?: (sdkMessages: Queue.Queue<SDKMessage>) => Effect.Effect<void>;
  readonly interrupt?: Effect.Effect<void, ClaudeAdapterV2.ClaudeAgentSdkQueryRunnerError>;
  readonly setPermissionMode?: ClaudeAdapterV2.ClaudeAgentSdkQuerySession["setPermissionMode"];
  readonly applyFlagSettings?: ClaudeAdapterV2.ClaudeAgentSdkQuerySession["applyFlagSettings"];
  readonly stopTask?: (
    taskId: string,
  ) => Effect.Effect<void, ClaudeAdapterV2.ClaudeAgentSdkQueryRunnerError>;
  readonly backgroundTasks?: (
    toolUseId: string,
  ) => Effect.Effect<boolean, ClaudeAdapterV2.ClaudeAgentSdkQueryRunnerError>;
  readonly mcp?: Pick<
    ClaudeAdapterV2.ClaudeAgentSdkQuerySession,
    "mcpServerStatus" | "readMcpResource" | "callMcpTool"
  > &
    Partial<Pick<ClaudeAdapterV2.ClaudeAgentSdkQuerySession, "listPermissionRules">>;
  readonly environment?: NodeJS.ProcessEnv;
  readonly subagentLaunchToolUseId?: string;
  readonly subagentModel?: string;
  readonly nativeSessionId?: string;
  readonly settings?: ClaudeSettings;
  readonly modelCatalog?: Effect.Effect<ClaudeModelCatalog>;
  readonly freshQueueOnReopen?: boolean;
  readonly forkSession?: ClaudeAdapterV2.ClaudeAgentSdkQueryRunnerShape["forkSession"];
  readonly allocateSessionId?: Effect.Effect<string>;
  readonly offer?: (message: SDKUserMessage) => Effect.Effect<void>;
  readonly promptSuggestions?: boolean;
}) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const idAllocator = yield* IdAllocator.IdAllocatorV2;
    const attachmentsDir = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "t3-claude-v2-wake-",
    });
    const sdkMessages = yield* Queue.unbounded<SDKMessage>();
    const processQueues: Array<Queue.Queue<SDKMessage>> = [];
    const processedMessages = new WeakMap<SDKMessage, Deferred.Deferred<void>>();
    const offerAndWait = Effect.fnUntraced(function* (
      message: SDKMessage,
      offered?: Deferred.Deferred<void>,
    ) {
      const processed = yield* Deferred.make<void>();
      processedMessages.set(message, processed);
      yield* Queue.offer(processQueues.at(-1) ?? sdkMessages, message);
      if (offered !== undefined) yield* Deferred.succeed(offered, undefined);
      yield* Deferred.await(processed);
    });
    const changes = yield* makeChangeSignal;
    const offeredMessages: Array<SDKUserMessage> = [];
    const permissionModeChanges: Array<string> = [];
    const liveSelectionChanges: Array<unknown> = [];
    const continuationRequests: Array<ProviderContinuationRequests.ProviderContinuationRequest> =
      [];
    const continuationReceipts =
      yield* Queue.unbounded<ProviderContinuationRequests.ProviderContinuationRequest>();
    const terminalReceipts =
      yield* Queue.unbounded<
        Extract<ProviderAdapter.ProviderAdapterV2Event, { type: "turn.terminal" }>
      >();
    const subagentReceipts =
      yield* Queue.unbounded<
        Extract<ProviderAdapter.ProviderAdapterV2Event, { type: "subagent.updated" }>
      >();
    const systemNoticeReceipts =
      yield* Queue.unbounded<
        Extract<ProviderAdapter.ProviderAdapterV2Event, { type: "turn_item.updated" }>
      >();
    const runtimeRequestReceipts =
      yield* Queue.unbounded<
        Extract<ProviderAdapter.ProviderAdapterV2Event, { type: "runtime_request.updated" }>
      >();
    const planReceipts =
      yield* Queue.unbounded<
        Extract<ProviderAdapter.ProviderAdapterV2Event, { type: "plan.updated" }>
      >();
    const providerThreadReceipts =
      yield* Queue.unbounded<
        Extract<ProviderAdapter.ProviderAdapterV2Event, { type: "provider_thread.updated" }>
      >();
    let openedOptions: ClaudeAdapterV2.ClaudeAgentSdkQueryOptions | undefined;
    const adapter = yield* ClaudeAdapterV2.makeClaudeAdapterV2({
      instanceId: ClaudeAdapterV2.CLAUDE_DEFAULT_INSTANCE_ID,
      settings: options?.settings ?? DEFAULT_CLAUDE_SETTINGS,
      ...(options?.modelCatalog === undefined ? {} : { modelCatalog: options.modelCatalog }),
      environment: options?.environment ?? {},
      attachmentsDir,
      fileSystem,
      path: yield* Path.Path,
      random: yield* SecureRandom.SecureRandom,
      idAllocator,
      continuationRequests: {
        offer: (request) =>
          Effect.sync(() => {
            continuationRequests.push(request);
          }).pipe(
            Effect.andThen(Queue.offer(continuationReceipts, request)),
            Effect.andThen(changes.notify),
          ),
      },
      queryRunner: {
        allocateSessionId:
          options?.allocateSessionId ??
          Effect.succeed(options?.nativeSessionId ?? WAKE_NATIVE_SESSION),
        open: (input) =>
          Effect.gen(function* () {
            openedOptions = input.options;
            const processMessages =
              options?.freshQueueOnReopen === true && processQueues.length > 0
                ? yield* Queue.unbounded<SDKMessage>()
                : sdkMessages;
            const messages = Stream.fromQueue(processMessages).pipe(
              Stream.flatMap((message) =>
                Stream.make(message).pipe(
                  Stream.concat(
                    Stream.fromEffect(
                      Effect.suspend(() => {
                        const processed = processedMessages.get(message);
                        return processed === undefined
                          ? Effect.void
                          : Deferred.succeed(processed, undefined);
                      }),
                    ).pipe(Stream.drain),
                  ),
                ),
              ),
            );
            if (options?.freshQueueOnReopen === true && processQueues.length > 0) {
              processQueues.push(processMessages);
              return {
                messages,
                offer: (message: SDKUserMessage) =>
                  Effect.sync(() => {
                    offeredMessages.push(message);
                  }).pipe(Effect.andThen(changes.notify)),
                setModel: () => Effect.void,
                applyFlagSettings: () => Effect.void,
                setPermissionMode: (mode) =>
                  Effect.sync(() => {
                    permissionModeChanges.push(mode);
                  }).pipe(Effect.andThen(() => options?.setPermissionMode?.(mode) ?? Effect.void)),
                backgroundTasks: options?.backgroundTasks ?? (() => Effect.succeed(false)),
                mcpServerStatus: Effect.succeed([]),
                readMcpResource: () => Effect.die("unexpected MCP resource read"),
                callMcpTool: () => Effect.die("unexpected MCP tool call"),
                listPermissionRules: Effect.die("unexpected permission rules read"),
                stopTask: options?.stopTask ?? (() => Effect.void),
                interrupt: Effect.void,
                close: Queue.shutdown(processMessages),
              };
            }
            processQueues.push(sdkMessages);
            return {
              messages,
              offer: (message) =>
                Effect.sync(() => {
                  offeredMessages.push(message);
                }).pipe(
                  Effect.andThen(changes.notify),
                  Effect.andThen(options?.offer?.(message) ?? Effect.void),
                ),
              setModel: (model) =>
                Effect.sync(() => {
                  liveSelectionChanges.push({ model });
                }),
              applyFlagSettings: (settings) =>
                Effect.sync(() => {
                  liveSelectionChanges.push(settings);
                }).pipe(
                  Effect.andThen(() => options?.applyFlagSettings?.(settings) ?? Effect.void),
                ),
              setPermissionMode: (mode) =>
                Effect.sync(() => {
                  permissionModeChanges.push(mode);
                }).pipe(Effect.andThen(() => options?.setPermissionMode?.(mode) ?? Effect.void)),
              backgroundTasks: options?.backgroundTasks ?? (() => Effect.succeed(false)),
              mcpServerStatus: options?.mcp?.mcpServerStatus ?? Effect.succeed([]),
              readMcpResource:
                options?.mcp?.readMcpResource ?? (() => Effect.die("unexpected MCP resource read")),
              callMcpTool:
                options?.mcp?.callMcpTool ?? (() => Effect.die("unexpected MCP tool call")),
              listPermissionRules: options?.mcp?.listPermissionRules ?? Effect.succeed([]),
              stopTask: options?.stopTask ?? (() => Effect.void),
              interrupt: options?.interrupt ?? Effect.void,
              close: options?.close?.(sdkMessages) ?? Effect.void,
            };
          }),
        forkSession: options?.forkSession ?? (() => Effect.die("unused forkSession")),
        subagentLaunchToolUseId: () => Effect.succeed(options?.subagentLaunchToolUseId ?? null),
        subagentModel: () => Effect.succeed(options?.subagentModel ?? null),
        assertComplete: Effect.void,
      },
    });
    const threadId = ThreadId.make("thread-claude-wake");
    const runtime = yield* adapter.openSession({
      threadId,
      providerSessionId: ProviderSessionId.make("provider-session-claude-wake"),
      modelSelection: CLAUDE_TEST_MODEL_SELECTION,
      runtimePolicy: CLAUDE_TEST_RUNTIME_POLICY,
      promptSuggestions: Effect.succeed(options?.promptSuggestions === true),
    });
    const providerThread = yield* runtime.ensureThread({
      threadId,
      modelSelection: CLAUDE_TEST_MODEL_SELECTION,
      runtimePolicy: options?.runtimePolicy ?? CLAUDE_TEST_RUNTIME_POLICY,
    });
    const events: Array<ProviderAdapter.ProviderAdapterV2Event> = [];
    yield* runtime.events.pipe(
      Stream.runForEach((event) =>
        Effect.gen(function* () {
          events.push(event);
          if (event.type === "subagent.updated") {
            yield* Queue.offer(subagentReceipts, event);
          }
          if (event.type === "turn.terminal") {
            yield* Queue.offer(terminalReceipts, event);
          }
          if (event.type === "runtime_request.updated") {
            yield* Queue.offer(runtimeRequestReceipts, event);
          }
          if (event.type === "plan.updated") {
            yield* Queue.offer(planReceipts, event);
          }
          if (event.type === "provider_thread.updated") {
            yield* Queue.offer(providerThreadReceipts, event);
          }
          if (event.type === "turn_item.updated" && event.turnItem.type === "system_notice") {
            yield* Queue.offer(systemNoticeReceipts, event);
          }
          yield* changes.notify;
        }),
      ),
      Effect.forkScoped,
    );
    if (runtime.hasPendingBackgroundWork === undefined) {
      throw new Error("Claude adapter runtime must expose hasPendingBackgroundWork.");
    }
    const hasPendingBackgroundWork = runtime.hasPendingBackgroundWork;
    const terminalEvents = () =>
      events.filter(
        (
          event,
        ): event is Extract<ProviderAdapter.ProviderAdapterV2Event, { type: "turn.terminal" }> =>
          event.type === "turn.terminal",
      );
    return {
      attachmentsDir,
      runtime,
      providerThread,
      threadId,
      sdkMessages,
      processQueues,
      offerAndWait,
      offeredMessages,
      promptUuid: (index: number) => {
        const uuid = offeredMessages[index]?.uuid;
        if (uuid === undefined) throw new Error(`No prompt offered at index ${index}.`);
        return uuid;
      },
      permissionModeChanges,
      liveSelectionChanges,
      continuationRequests,
      continuationReceipts,
      events,
      terminalReceipts,
      subagentReceipts,
      systemNoticeReceipts,
      runtimeRequestReceipts,
      planReceipts,
      providerThreadReceipts,
      getOpenedOptions: () => openedOptions,
      terminalEvents,
      hasPendingBackgroundWork,
      until: changes.until,
      awaitTerminal: (count: number) => changes.until(() => terminalEvents().length >= count),
      awaitContinuation: (count: number) =>
        changes.until(() => continuationRequests.length >= count),
    };
  });

const CLI_DIR = process.env.CAPTURE_CLI_DIR;
const OUT_DIR = process.env.CAPTURE_OUT_DIR;
const NAMES = [
  "e01_turn",
  "e02_second_turn",
  "e03_interrupt",
  "e06_permissions",
  "e12_subagent",
  "e13_subagent_fg",
  "e14_steer",
  "e15_image",
];
const RUNTIME_MODE: Record<string, "full-access" | "approval-required"> = {
  e06_permissions: "approval-required",
};
type Line = { dir: string; msg: any };

describe("capture ClaudeAdapterV2 events from recorded CLI transcripts", () => {
  it.effect.each(NAMES)("%s", (name) =>
    Effect.gen(function* () {
      if (CLI_DIR === undefined || OUT_DIR === undefined) {
        throw new Error("Set CAPTURE_CLI_DIR and CAPTURE_OUT_DIR.");
      }
      const lines: Array<Line> = NodeFS.readFileSync(`${CLI_DIR}/${name}.ndjson`, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l));
      const native = lines.find(
        (l) => typeof l.msg.session_id === "string" && l.msg.session_id !== "",
      )!.msg.session_id as string;
      const runtimeMode = RUNTIME_MODE[name] ?? "full-access";
      const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode,
        interactionMode: "default",
        cwd: "/workspace",
      });
      const harness = yield* makeWakeHarnessWithOptions({
        nativeSessionId: native,
        runtimePolicy,
      });
      const { runtime } = harness;
      const latestThread = () => {
        const e = harness.events.findLast((c) => c.type === "provider_thread.updated");
        return e?.type === "provider_thread.updated" ? e.providerThread : harness.providerThread;
      };
      const lastTurnId = () => {
        const e = harness.events.findLast((c) => c.type === "provider_turn.updated");
        if (e?.type !== "provider_turn.updated") throw new Error("no provider turn yet");
        return e.providerTurn.id;
      };
      const mk = (n: number, text: string, attachments: any[], continuation: boolean) =>
        makeClaudeTestTurnInput({
          threadId: harness.threadId,
          providerThread: latestThread(),
          now: DateTime.makeUnsafe(0),
          attemptId: RunAttemptId.make(`attempt-${n}`),
          text,
          attachments,
          providerTurnOrdinal: n,
          runtimePolicy,
          ...(continuation
            ? { messageCreatedBy: "agent" as const, messageCreationSource: "provider" as const }
            : {}),
        });
      // The adapter offers its own random prompt uuids; the CLI echoed the recorded ones, so
      // later `in` frames get the recorded uuid replaced by the offered one.
      const uuidMap = new Map<string, string>();
      const log: Array<string> = [];
      let turn = 0;
      let handledContinuations = 0;
      const interrupts: Array<Fiber.Fiber<unknown>> = [];
      const rewrite = (msg: unknown) => {
        let s = JSON.stringify(msg);
        for (const [from, to] of uuidMap) s = s.split(from).join(to);
        return JSON.parse(s);
      };
      const startContinuation = Effect.gen(function* () {
        handledContinuations++;
        turn++;
        yield* runtime.startTurn(mk(turn, "", [], true));
      });
      for (let i = 0; i < lines.length; i++) {
        const { dir, msg } = lines[i]!;
        if (dir === "out") {
          if (msg.type === "control_request" && msg.request?.subtype === "interrupt") {
            // interruptTurn waits (TestClock timeout) for the CLI to close, which the fake never
            // does, so it runs beside the remaining frames and is settled at the end.
            interrupts.push(
              yield* Effect.forkScoped(
                runtime
                  .interruptTurn({ providerThread: latestThread(), providerTurnId: lastTurnId() })
                  .pipe(Effect.exit),
              ),
            );
            log.push(`line ${i}: interruptTurn`);
            continue;
          }
          if (msg.type !== "user") continue;
          if (msg.priority === "now") {
            const before = harness.offeredMessages.length;
            yield* runtime.steerTurn({
              threadId: harness.threadId,
              runId: RunId.make("run-attempt-1"),
              providerThread: latestThread(),
              providerTurnId: lastTurnId(),
              message: {
                messageId: MessageId.make("message-steer-1"),
                text: msg.message.content,
                attachments: [],
                createdBy: "user",
                creationSource: "web",
              },
            });
            uuidMap.set(msg.uuid, harness.offeredMessages[before]!.uuid as string);
            log.push(`line ${i}: steer`);
            continue;
          }
          // The next turn starts from the thread the previous turn left behind.
          yield* harness.awaitTerminal(turn);
          turn++;
          const content = msg.message.content;
          const text =
            typeof content === "string"
              ? content
              : content.find((b: any) => b.type === "text").text;
          let attachments: any[] = [];
          if (typeof content !== "string") {
            const img = content.find((b: any) => b.type === "image");
            if (img !== undefined) {
              const bytes = Buffer.from(img.source.data, "base64");
              NodeFS.writeFileSync(`${harness.attachmentsDir}/attach-1.png`, bytes);
              attachments = [
                ChatImageAttachment.make({
                  type: "image",
                  id: ChatAttachmentId.make("attach-1"),
                  name: "red.png",
                  mimeType: "image/png",
                  sizeBytes: bytes.length,
                }),
              ];
            }
          }
          const before = harness.offeredMessages.length;
          yield* runtime.startTurn(mk(turn, text, attachments, false));
          const offered = harness.offeredMessages[before];
          if (offered !== undefined && typeof msg.uuid === "string")
            uuidMap.set(msg.uuid, offered.uuid as string);
          log.push(`line ${i}: startTurn ${turn}`);
          continue;
        }
        if (msg.type === "control_response") continue;
        if (msg.type === "control_request") {
          // Permission prompt: the adapter learns of it through the SDK's canUseTool callback.
          const req = msg.request;
          if (req?.subtype !== "can_use_tool") continue;
          const answer = lines
            .slice(i)
            .find((l) => l.dir === "out" && l.msg.type === "control_response")!;
          const accept = answer.msg.response.response.behavior === "allow";
          const canUseTool = harness.getOpenedOptions()?.canUseTool;
          if (canUseTool === undefined) throw new Error("no canUseTool");
          const pending = harness.runtimeRequestReceipts;
          const decision = yield* Effect.promise(() =>
            canUseTool(req.tool_name, req.input, {
              signal: new AbortController().signal,
              toolUseID: req.tool_use_id,
              requestId: msg.request_id,
              ...(req.description === undefined ? {} : { description: req.description }),
              ...(req.blocked_path === undefined ? {} : { blockedPath: req.blocked_path }),
              ...(req.permission_suggestions === undefined
                ? {}
                : { suggestions: req.permission_suggestions }),
            }),
          ).pipe(Effect.forkScoped);
          let request: any;
          while (request === undefined || request.runtimeRequest.status !== "pending") {
            request = yield* Queue.take(pending);
          }
          yield* runtime.respondToRuntimeRequest({
            requestId: request.runtimeRequest.id,
            decision: accept ? "accept" : "decline",
          });
          yield* Fiber.join(decision);
          log.push(`line ${i}: permission ${accept ? "accept" : "decline"}`);
          continue;
        }
        const frame = claudeSdkFrame(rewrite(msg));
        const fiber = yield* Effect.forkScoped(harness.offerAndWait(frame));
        // A frame can make the adapter ask for a continuation turn before it finishes it.
        while (true) {
          const settled = yield* Effect.raceFirst(
            Fiber.join(fiber).pipe(Effect.as("processed" as const)),
            harness
              .awaitContinuation(handledContinuations + 1)
              .pipe(Effect.as("continuation" as const)),
          );
          if (settled === "processed") break;
          log.push(`line ${i}: continuation request while feeding`);
          yield* startContinuation;
        }
      }
      if (interrupts.length > 0) {
        yield* TestClock.adjust("1 hour");
        for (const fiber of interrupts) yield* Fiber.join(fiber);
      }
      yield* harness.awaitTerminal(turn);
      const offered = JSON.parse(
        JSON.stringify(harness.offeredMessages).split(harness.attachmentsDir).join("<ATTACHMENTS>"),
      );
      const events = harness.events.map((event) => {
        const { driver: _driver, ...rest } = event as any;
        return rest;
      });
      const out = {
        note: `ProviderAdapterV2Event list from ClaudeAdapterV2 (TS) for cli/${name}.ndjson, via the wake test harness (tools/capture-ts); driver field dropped. Clock is the TestClock (epoch 0).`,
        offered,
        events,
      };
      NodeFS.mkdirSync(OUT_DIR, { recursive: true });
      NodeFS.writeFileSync(`${OUT_DIR}/${name}.json`, JSON.stringify(out, null, 2) + "\n");
      NodeFS.writeFileSync(`${OUT_DIR}/${name}.log`, log.join("\n") + "\n");
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(
          IdAllocator.layer,
          McpProviderSessions.layer,
          NodeServices.layer,
          NodeCrypto.layer,
        ),
      ),
    ),
  );
});
