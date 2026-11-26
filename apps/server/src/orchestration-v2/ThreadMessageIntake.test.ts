import * as DocumentText from "../provider/DocumentText.ts";
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  ChatAttachmentId,
  CommandId,
  EventId,
  GuestMessageId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2Command,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2StoredEvent,
  type ServerProvider,
  type UserInputAttachments,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import {
  createAttachmentId,
  createPendingAttachmentId,
  resolveAttachmentPath,
} from "../attachmentStore.ts";
import * as ServerConfig from "../config.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  OrchestratorCommandPreviouslyRejectedError,
  OrchestratorDispatchError,
} from "./Orchestrator.ts";
import * as ThreadLaunchService from "./ThreadLaunchService.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import * as ThreadMessageIntake from "./ThreadMessageIntake.ts";
import * as UsageLimitCooldownStore from "./UsageLimitCooldownStore.ts";

const dispatchCommand = (command: OrchestrationV2Command, sender = { managesProviders: true }) =>
  ThreadMessageIntake.dispatchCommand(command, sender);

const layerIntakeTest = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-question-intake-",
}).pipe(
  Layer.provideMerge(DocumentText.layer.pipe(Layer.provideMerge(NodeServices.layer))),
  Layer.provideMerge(ServerSettings.layerTest()),
);

const layerFailingDispatchHandler =
  (captured: OrchestrationV2ServerCommand[]) => (command: OrchestrationV2ServerCommand) => {
    captured.push(command);
    return Effect.fail(
      new OrchestratorDispatchError({
        commandId: command.commandId,
        commandType: command.type,
        cause: "Stop after intake",
      }),
    );
  };

const noPendingRuntimeRequests: ThreadManagementService.ThreadManagementServiceShape["getThreadRecords"] =
  () =>
    Effect.succeed({ runtimeRequests: [] } as unknown as Effect.Success<
      ReturnType<ThreadManagementService.ThreadManagementServiceShape["getThreadRecords"]>
    >);

const layerFailingDispatch = (captured: OrchestrationV2ServerCommand[]) =>
  Layer.mock(ThreadManagementService.ThreadManagementService)({
    dispatch: layerFailingDispatchHandler(captured),
    getThreadRecords: noPendingRuntimeRequests,
  });

const NOW = DateTime.makeUnsafe("2026-09-13T00:00:00.000Z");

const answeredRespondEvents = (input: {
  readonly threadId: ThreadId;
  readonly requestId: string;
  readonly attachmentsByQuestionId: UserInputAttachments;
}): OrchestrationV2StoredEvent[] => [
  {
    sequence: 1,
    commandId: null,
    event: {
      id: EventId.make("evt-recorded-answer"),
      type: "turn-item.updated",
      threadId: input.threadId,
      occurredAt: NOW,
      payload: {
        id: TurnItemId.make("item-recorded-answer"),
        type: "user_input_request",
        threadId: input.threadId,
        runId: null,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 1,
        status: "completed",
        title: null,
        startedAt: null,
        completedAt: NOW,
        updatedAt: NOW,
        requestId: RuntimeRequestId.make(input.requestId),
        questions: [],
        questionAnswer: {
          requestId: input.requestId,
          answers: {},
          attachmentsByQuestionId: input.attachmentsByQuestionId,
        },
      },
    },
  },
];

it.effect("claims question uploads and passes readable paths through the V2 request command", () =>
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const id = ChatAttachmentId.make(createPendingAttachmentId()!);
    NodeFS.writeFileSync(
      NodePath.join(config.attachmentsDir, `${id}.png`),
      new Uint8Array([1, 2, 3]),
    );
    const captured: OrchestrationV2ServerCommand[] = [];
    yield* dispatchCommand({
      type: "runtime-request.respond",
      commandId: CommandId.make("answer-1"),
      threadId: ThreadId.make("thread-answer"),
      requestId: RuntimeRequestId.make("request-1"),
      answers: { q: ["Selected option"] },
      attachmentsByQuestionId: {
        q: [{ type: "image", id, name: "screen.png", mimeType: "image/png", sizeBytes: 3 }],
      },
    }).pipe(Effect.provide(layerFailingDispatch(captured)), Effect.result);
    expect(captured).toHaveLength(1);
    const command = captured[0]!;
    expect(command.type).toBe("runtime-request.respond");
    if (command.type !== "runtime-request.respond") return;
    const attachment = command.attachmentsByQuestionId?.q?.[0];
    expect(attachment).toBeDefined();
    const path = resolveAttachmentPath({
      attachmentsDir: config.attachmentsDir,
      attachment: attachment!,
    });
    expect(path).not.toBeNull();
    expect(NodeFS.readFileSync(path!)).toEqual(Buffer.from([1, 2, 3]));
    expect(command.answers?.q).toEqual([
      "Selected option",
      `Attached image "screen.png": ${JSON.stringify(path)}`,
    ]);
  }).pipe(Effect.provide(layerIntakeTest)),
);

it.effect("leaves an async answer's text alone so its files travel as message attachments", () =>
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const id = ChatAttachmentId.make(createPendingAttachmentId()!);
    NodeFS.writeFileSync(
      NodePath.join(config.attachmentsDir, `${id}.png`),
      new Uint8Array([1, 2, 3]),
    );
    const threadId = ThreadId.make("thread-async-answer");
    const requestId = RuntimeRequestId.make("request-async");
    const captured: OrchestrationV2ServerCommand[] = [];
    yield* dispatchCommand({
      type: "runtime-request.respond",
      commandId: CommandId.make("answer-async"),
      threadId,
      requestId,
      answers: { q: "" },
      attachmentsByQuestionId: {
        q: [{ type: "image", id, name: "screen.png", mimeType: "image/png", sizeBytes: 3 }],
      },
    }).pipe(
      Effect.provide(
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          dispatch: layerFailingDispatchHandler(captured),
          getThreadRecords: () =>
            Effect.succeed({
              runtimeRequests: [
                {
                  id: requestId,
                  nodeId: null,
                  providerTurnId: null,
                  nativeRequestRef: null,
                  kind: "user_input",
                  status: "pending",
                  responseCapability: { type: "message" },
                  createdAt: NOW,
                  resolvedAt: null,
                },
              ],
            } as unknown as Effect.Success<
              ReturnType<ThreadManagementService.ThreadManagementServiceShape["getThreadRecords"]>
            >),
        }),
      ),
      Effect.result,
    );
    expect(captured).toHaveLength(1);
    const command = captured[0]!;
    if (command.type !== "runtime-request.respond") throw new Error("expected a response");
    expect(command.answers).toEqual({ q: "" });
    expect(command.attachmentsByQuestionId?.q).toHaveLength(1);
  }).pipe(Effect.provide(layerIntakeTest)),
);

it.effect("retains claimed copies when dispatch failure may have been accepted", () =>
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const pendingId = ChatAttachmentId.make(createPendingAttachmentId()!);
    NodeFS.writeFileSync(
      NodePath.join(config.attachmentsDir, `${pendingId}.png`),
      new Uint8Array([1, 2, 3]),
    );
    const captured: OrchestrationV2ServerCommand[] = [];
    const result = yield* dispatchCommand({
      type: "runtime-request.respond",
      commandId: CommandId.make("answer-ambiguous"),
      threadId: ThreadId.make("thread-ambiguous"),
      requestId: RuntimeRequestId.make("request-ambiguous"),
      answers: { q: ["one"] },
      attachmentsByQuestionId: {
        q: [
          {
            type: "image",
            id: pendingId,
            name: "screen.png",
            mimeType: "image/png",
            sizeBytes: 3,
          },
        ],
      },
    }).pipe(Effect.provide(layerFailingDispatch(captured)), Effect.result);
    expect(result._tag).toBe("Failure");
    expect(captured).toHaveLength(1);
    const threadFiles = NodeFS.readdirSync(config.attachmentsDir).filter((entry) =>
      entry.startsWith("thread-ambiguous-"),
    );
    expect(threadFiles).toHaveLength(1);
    expect(NodeFS.existsSync(NodePath.join(config.attachmentsDir, `${pendingId}.png`))).toBe(true);
  }).pipe(Effect.provide(layerIntakeTest)),
);

it.effect("releases claimed copies when the command was already rejected", () =>
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const pendingId = ChatAttachmentId.make(createPendingAttachmentId()!);
    NodeFS.writeFileSync(
      NodePath.join(config.attachmentsDir, `${pendingId}.png`),
      new Uint8Array([1, 2, 3]),
    );
    const result = yield* dispatchCommand({
      type: "runtime-request.respond",
      commandId: CommandId.make("answer-rejected"),
      threadId: ThreadId.make("thread-rejected"),
      requestId: RuntimeRequestId.make("request-rejected"),
      answers: { q: ["one"] },
      attachmentsByQuestionId: {
        q: [
          {
            type: "image",
            id: pendingId,
            name: "screen.png",
            mimeType: "image/png",
            sizeBytes: 3,
          },
        ],
      },
    }).pipe(
      Effect.provide(
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadRecords: noPendingRuntimeRequests,
          dispatch: (command) =>
            Effect.fail(
              new OrchestratorCommandPreviouslyRejectedError({
                commandId: command.commandId,
                commandType: command.type,
                detail: "rejected earlier",
              }),
            ),
        }),
      ),
      Effect.result,
    );
    expect(result._tag).toBe("Failure");
    expect(
      NodeFS.readdirSync(config.attachmentsDir).filter((entry) =>
        entry.startsWith("thread-rejected-"),
      ),
    ).toEqual([]);
    expect(NodeFS.existsSync(NodePath.join(config.attachmentsDir, `${pendingId}.png`))).toBe(true);
  }).pipe(Effect.provide(layerIntakeTest)),
);

it.effect("releases claimed copies when dispatch replays an earlier accepted response", () =>
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const threadId = ThreadId.make("thread-replay");
    const pendingId = ChatAttachmentId.make(createPendingAttachmentId()!);
    NodeFS.writeFileSync(
      NodePath.join(config.attachmentsDir, `${pendingId}.png`),
      new Uint8Array([1, 2, 3]),
    );
    const earlierAttachment = {
      type: "image" as const,
      id: ChatAttachmentId.make("thread-replay-00000000-0000-4000-8000-0000000000aa"),
      name: "screen.png",
      mimeType: "image/png",
      sizeBytes: 3,
    };
    NodeFS.writeFileSync(
      NodePath.join(config.attachmentsDir, `${earlierAttachment.id}.png`),
      new Uint8Array([4, 4, 4]),
    );
    const storedEvents = answeredRespondEvents({
      threadId,
      requestId: "request-replay",
      attachmentsByQuestionId: { q: [earlierAttachment] },
    });
    const result = yield* dispatchCommand({
      type: "runtime-request.respond",
      commandId: CommandId.make("answer-replay"),
      threadId,
      requestId: RuntimeRequestId.make("request-replay"),
      answers: { q: ["one"] },
      attachmentsByQuestionId: {
        q: [
          {
            type: "image",
            id: pendingId,
            name: "screen.png",
            mimeType: "image/png",
            sizeBytes: 3,
          },
        ],
      },
    }).pipe(
      Effect.provide(
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadRecords: noPendingRuntimeRequests,
          dispatch: () => Effect.succeed({ sequence: 1, storedEvents }),
        }),
      ),
      Effect.result,
    );
    expect(result._tag).toBe("Success");
    expect(
      NodeFS.readdirSync(config.attachmentsDir).filter((entry) =>
        entry.startsWith("thread-replay-"),
      ),
    ).toEqual([`${earlierAttachment.id}.png`]);
    expect(
      NodeFS.readFileSync(NodePath.join(config.attachmentsDir, `${earlierAttachment.id}.png`)),
    ).toEqual(Buffer.from([4, 4, 4]));
    expect(NodeFS.existsSync(NodePath.join(config.attachmentsDir, `${pendingId}.png`))).toBe(true);
  }).pipe(Effect.provide(layerIntakeTest)),
);

it.effect("a retried response re-claims the preserved pending uploads", () =>
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const threadId = ThreadId.make("thread-retry");
    const pendingId = ChatAttachmentId.make(createPendingAttachmentId()!);
    const lateId = ChatAttachmentId.make(createPendingAttachmentId()!);
    NodeFS.writeFileSync(
      NodePath.join(config.attachmentsDir, `${pendingId}.png`),
      new Uint8Array([1, 2, 3]),
    );
    const command: OrchestrationV2Command = {
      type: "runtime-request.respond",
      commandId: CommandId.make("answer-retry"),
      threadId,
      requestId: RuntimeRequestId.make("request-retry"),
      answers: { q1: ["one"], q2: ["two"] },
      attachmentsByQuestionId: {
        q1: [
          {
            type: "image",
            id: pendingId,
            name: "screen.png",
            mimeType: "image/png",
            sizeBytes: 3,
          },
        ],
        q2: [
          {
            type: "image",
            id: lateId,
            name: "late.png",
            mimeType: "image/png",
            sizeBytes: 2,
          },
        ],
      },
    };
    const captured: OrchestrationV2ServerCommand[] = [];
    const first = yield* dispatchCommand(command).pipe(
      Effect.provide(layerFailingDispatch(captured)),
      Effect.result,
    );
    expect(first._tag).toBe("Failure");
    expect(captured).toHaveLength(0);

    NodeFS.writeFileSync(
      NodePath.join(config.attachmentsDir, `${lateId}.png`),
      new Uint8Array([7, 7]),
    );
    const retry = yield* dispatchCommand(command).pipe(
      Effect.provide(
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadRecords: noPendingRuntimeRequests,
          dispatch: (dispatched) => {
            captured.push(dispatched);
            return Effect.succeed({ sequence: 1, storedEvents: [] });
          },
        }),
      ),
      Effect.result,
    );
    expect(retry._tag).toBe("Success");
    const dispatched = captured[0]!;
    expect(dispatched.type).toBe("runtime-request.respond");
    if (dispatched.type !== "runtime-request.respond") return;
    for (const attachment of [
      ...(dispatched.attachmentsByQuestionId?.q1 ?? []),
      ...(dispatched.attachmentsByQuestionId?.q2 ?? []),
    ]) {
      const path = resolveAttachmentPath({
        attachmentsDir: config.attachmentsDir,
        attachment,
      });
      expect(path).not.toBeNull();
      expect(NodeFS.existsSync(path!)).toBe(true);
    }
    expect(
      NodeFS.readdirSync(config.attachmentsDir).filter((entry) =>
        entry.startsWith("thread-retry-"),
      ),
    ).toHaveLength(2);
  }).pipe(Effect.provide(layerIntakeTest)),
);

it.effect("sends a guest message with the guest's files, never ones the client names", () =>
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const guestFile = {
      type: "image" as const,
      id: ChatAttachmentId.make(createAttachmentId("thread-guest")!),
      name: "screen.png",
      mimeType: "image/png",
      sizeBytes: 3,
    };
    NodeFS.writeFileSync(
      NodePath.join(config.attachmentsDir, `${guestFile.id}.png`),
      new Uint8Array([1, 2, 3]),
    );
    const guestMessageId = GuestMessageId.make("guest-message:files");
    const captured: OrchestrationV2ServerCommand[] = [];
    const layerGuestShare = Layer.mock(ThreadManagementService.ThreadManagementService)({
      dispatch: layerFailingDispatchHandler(captured),
      // Only the share is read.
      getThreadSnapshotWindow: () =>
        Effect.succeed({
          projection: {
            thread: {
              guestShare: {
                messages: [{ id: guestMessageId, status: "pending", attachments: [guestFile] }],
              },
            },
          },
        } as unknown as Effect.Success<
          ReturnType<
            ThreadManagementService.ThreadManagementServiceShape["getThreadSnapshotWindow"]
          >
        >),
    });
    yield* dispatchCommand({
      type: "message.dispatch",
      commandId: CommandId.make("send-guest-message"),
      threadId: ThreadId.make("thread-guest"),
      messageId: MessageId.make("message-guest"),
      guestMessageId,
      text: "",
      attachments: [{ ...guestFile, id: ChatAttachmentId.make("thread-guest-owner-file") }],
      dispatchMode: { type: "queue_after_active" },
      createdBy: "user",
      creationSource: "web",
    }).pipe(Effect.provide(layerGuestShare), Effect.result);
    const command = captured[0];
    if (command?.type !== "message.dispatch") throw new Error("Expected a message dispatch.");
    expect(command.attachments).toHaveLength(1);
    // The guest's file, which is already the thread's.
    expect(command.attachments).toEqual([guestFile]);
  }).pipe(Effect.provide(layerIntakeTest)),
);

it.effect("refuses a queued edit that keeps a file another edit already deleted", () =>
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const storedFile = (name: string) => ({
      type: "image" as const,
      id: ChatAttachmentId.make(createAttachmentId("thread-queued-edit")!),
      name,
      mimeType: "image/png",
      sizeBytes: 3,
    });
    const kept = storedFile("kept.png");
    const deleted = storedFile("deleted.png");
    NodeFS.writeFileSync(
      NodePath.join(config.attachmentsDir, `${kept.id}.png`),
      new Uint8Array([1, 2, 3]),
    );
    const captured: OrchestrationV2ServerCommand[] = [];
    const edit = (attachments: ReadonlyArray<typeof kept>) =>
      dispatchCommand({
        type: "queued-run.edit",
        commandId: CommandId.make(`queued-edit-${attachments.length}`),
        threadId: ThreadId.make("thread-queued-edit"),
        runId: RunId.make("run-queued-edit"),
        text: "Edited from a stale view.",
        attachments,
      }).pipe(
        Effect.provide(
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            dispatch: layerFailingDispatchHandler(captured),
            hasReceipt: (commandId) =>
              Effect.succeed(captured.some((command) => command.commandId === commandId)),
          }),
        ),
        Effect.result,
      );

    yield* edit([kept]);
    expect(captured).toHaveLength(1);
    const result = yield* edit([kept, deleted]);
    expect(result._tag).toBe("Failure");
    expect(captured).toHaveLength(1);
    // A retry of the accepted edit replays its receipt even after a later cleanup removed its file.
    NodeFS.rmSync(NodePath.join(config.attachmentsDir, `${kept.id}.png`));
    yield* edit([kept]);
    expect(captured).toHaveLength(2);
  }).pipe(Effect.provide(layerIntakeTest)),
);

it.effect("a queued /logout edit without provider management must keep an attachment", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("thread-sign-out-edit");
    const image = {
      type: "image" as const,
      id: ChatAttachmentId.make(createAttachmentId(threadId)!),
      name: "shot.png",
      mimeType: "image/png",
      sizeBytes: 3,
    };
    const config = yield* ServerConfig.ServerConfig;
    NodeFS.writeFileSync(
      NodePath.join(config.attachmentsDir, `${image.id}.png`),
      new Uint8Array([1, 2, 3]),
    );
    const captured: OrchestrationV2ServerCommand[] = [];
    // The edit omits `attachments`, as an older client's does, so the queued ones stay.
    const edit = (run: string, managesProviders: boolean) =>
      dispatchCommand(
        {
          type: "queued-run.edit",
          commandId: CommandId.make(`edit-${run}-${managesProviders}`),
          threadId,
          runId: RunId.make(run),
          text: " /LOGOUT ",
        },
        { managesProviders },
      ).pipe(
        Effect.provide(
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            dispatch: layerFailingDispatchHandler(captured),
            hasReceipt: (commandId) => Effect.succeed(commandId === "edit-replayed-false"),
            getThreadRecords: () =>
              Effect.succeed({
                runs: ["attached", "bare"].map((id) => ({
                  id: RunId.make(id),
                  status: "queued",
                  userMessageId: MessageId.make(id),
                })),
              } as never),
            getMessagesById: (_threadId, [id]) =>
              Effect.succeed(
                new Map([[id, { attachments: id === "attached" ? [image] : [] }]]) as never,
              ),
          }),
        ),
        Effect.flip,
      );

    expect((yield* edit("bare", false))._tag).toBe("EnvironmentAuthorizationError");
    expect((yield* edit("started", false))._tag).toBe("EnvironmentAuthorizationError");
    expect(captured).toEqual([]);
    yield* edit("attached", false);
    yield* edit("bare", true);
    // A retry of an accepted edit reaches its receipt after its run left the queue.
    yield* edit("replayed", false);
    // The kept files are pinned, so an edit racing this one cannot strip them afterwards.
    expect(captured).toMatchObject([
      { runId: "attached", attachments: [image] },
      { runId: "bare" },
      { runId: "replayed" },
    ]);
    expect(captured[1]).not.toHaveProperty("attachments");
    expect(captured[2]).not.toHaveProperty("attachments");
  }).pipe(Effect.provide(layerIntakeTest)),
);

it.effect(
  "routes sends to fallback during Antigravity cooldown and switches back after reset",
  () =>
    Effect.gen(function* () {
      const startMs = Date.parse("2026-10-19T12:00:00.000Z");
      const resetIso = "2026-10-19T12:05:00.000Z";
      yield* TestClock.setTime(startMs);
      const agySelection = {
        instanceId: ProviderInstanceId.make("antigravity"),
        model: "gemini-4-neon",
      };
      const claudeSelection = {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-opus-5-5",
      };
      const makeProvider = (
        instanceId: ProviderInstanceId,
        driver: ProviderDriverKind,
      ): ServerProvider => ({
        instanceId,
        driver,
        enabled: true,
        installed: true,
        version: "1.0.0",
        status: "ready",
        auth: { status: "authenticated" },
        checkedAt: "2026-10-19T11:59:00.000Z",
        models: [],
        slashCommands: [],
        skills: [],
      });
      const providers = [
        makeProvider(agySelection.instanceId, ProviderDriverKind.make("antigravity")),
        makeProvider(claudeSelection.instanceId, ProviderDriverKind.make("claudeAgent")),
      ];
      const captured: OrchestrationV2ServerCommand[] = [];
      const launched: ThreadLaunchService.ThreadLaunchInput[] = [];
      const threadId = ThreadId.make("thread-agy-fallback");
      const projectId = ProjectId.make("project-1");
      let currentThread: {
        projectId: ProjectId;
        modelSelection: typeof agySelection;
        fallbackOrigin: {
          originSelection: typeof agySelection;
          fallbackSelection: typeof claudeSelection;
          switchedFromRunId: null;
          switchedAt: string;
          resetAt: string | null;
        } | null;
      } = {
        projectId,
        modelSelection: agySelection,
        fallbackOrigin: null,
      };

      const layer = Layer.mergeAll(
        ServerConfig.layerTest(process.cwd(), { prefix: "t3-fallback-intake-" }).pipe(
          Layer.provideMerge(DocumentText.layer.pipe(Layer.provideMerge(NodeServices.layer))),
        ),
        ServerSettings.layerTest({
          fallbackOnUsageLimit: true,
          fallbackModelSelection: claudeSelection,
          providerInstances: {
            [agySelection.instanceId]: {
              driver: ProviderDriverKind.make("antigravity"),
              enabled: true,
              config: {},
            },
            [claudeSelection.instanceId]: {
              driver: ProviderDriverKind.make("claudeAgent"),
              enabled: true,
              config: {},
            },
          },
        }),
        UsageLimitCooldownStore.layer,
        Layer.mock(ProviderRegistry.ProviderRegistry)({
          getProviders: Effect.succeed(providers),
          streamChanges: Stream.never,
        }),
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          dispatch: layerFailingDispatchHandler(captured),
          getThreadRecords: noPendingRuntimeRequests,
          getThreadSnapshotWindow: () =>
            Effect.succeed({ projection: { thread: currentThread } } as never),
        }),
        Layer.mock(ThreadLaunchService.ThreadLaunchService)({
          launch: (input) => {
            launched.push(input);
            return Effect.succeed({
              threadId,
              projection: { messages: [] },
              resumed: false,
            } as never);
          },
        }),
      );

      yield* Effect.gen(function* () {
        const cooldowns = yield* UsageLimitCooldownStore.UsageLimitCooldownStore;
        yield* cooldowns.record({
          instanceId: agySelection.instanceId,
          model: agySelection.model,
          failedAtMs: startMs - 1_000,
          resetAt: resetIso,
        });

        // 1. Send on an Antigravity Neon thread during cooldown routes to Claude Code Opus 5.5.
        yield* dispatchCommand({
          type: "message.dispatch",
          commandId: CommandId.make("send-during-cooldown"),
          threadId,
          messageId: MessageId.make("msg-1"),
          text: "continue",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        }).pipe(Effect.flip);
        expect(captured[0]?.type).toBe("message.dispatch");
        if (captured[0]?.type === "message.dispatch") {
          expect(captured[0].modelSelection).toEqual(claudeSelection);
          expect(captured[0].fallbackOrigin?.originSelection).toEqual(agySelection);
          expect(captured[0].fallbackOrigin?.resetAt).toBe(resetIso);
        }

        // 2. Launching a new Antigravity Neon thread during cooldown launches on Claude Code Opus 5.5.
        yield* ThreadMessageIntake.launchThread({
          commandId: CommandId.make("launch-during-cooldown"),
          projectId,
          title: "New thread",
          modelSelection: agySelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          workspaceStrategy: { type: "root" },
          createdBy: "user",
          creationSource: "web",
        });
        expect(launched[0]?.modelSelection).toEqual(claudeSelection);
        expect(launched[0]?.fallbackOrigin?.originSelection).toEqual(agySelection);

        // 3. Once resetAt passes, sending on the switched thread switches back to Antigravity Neon.
        currentThread = {
          projectId,
          modelSelection: claudeSelection,
          fallbackOrigin: {
            originSelection: agySelection,
            fallbackSelection: claudeSelection,
            switchedFromRunId: null,
            switchedAt: DateTime.formatIso(DateTime.makeUnsafe(startMs)),
            resetAt: resetIso,
          },
        };
        yield* TestClock.setTime(Date.parse(resetIso));
        yield* dispatchCommand({
          type: "message.dispatch",
          commandId: CommandId.make("send-after-reset"),
          threadId,
          messageId: MessageId.make("msg-2"),
          text: "next task",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        }).pipe(Effect.flip);
        expect(captured[1]?.type).toBe("message.dispatch");
        if (captured[1]?.type === "message.dispatch") {
          expect(captured[1].modelSelection).toEqual(agySelection);
          expect(captured[1].fallbackOrigin).toBeNull();
        }
      }).pipe(Effect.provide(layer));
    }),
);
