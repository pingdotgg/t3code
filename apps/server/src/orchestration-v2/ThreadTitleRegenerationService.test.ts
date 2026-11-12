import { assert, describe, it, vi } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  ChatAttachmentId,
  type ChatAttachment,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  RunId,
  ScheduledTaskId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { ATTACHMENT_ONLY_BOOTSTRAP_PROMPT } from "@t3tools/shared/composerContextReferences";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EventSink from "./EventSink.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import * as ThreadTitleRegeneration from "./ThreadTitleRegenerationService.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

const projectId = ProjectId.make("project:title-regeneration");
const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.1-codex",
} as const;

const adapter = {
  instanceId: modelSelection.instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("provider execution is disabled in title regeneration tests"),
} as ProviderAdapter.ProviderAdapterV2["Service"];

function makeHarness(
  options: {
    readonly generateTitle?: TextGeneration.TextGeneration["Service"]["generateThreadTitle"];
    readonly regenerationInterval?: number;
  } = {},
) {
  const layerDatabase = SqlitePersistence.layerMemory;
  const layerRegistry = ProviderAdapterRegistry.layerFromAdapters([adapter]);
  const layerOrchestrator = ProviderReplayHarness.layerWithRegistry(
    { name: "thread-title-regeneration" },
    layerRegistry,
    {
      databaseLayer: layerDatabase,
      runEffectWorker: false,
      ...(options.regenerationInterval === undefined
        ? {}
        : { threadTitleRegenerationInterval: options.regenerationInterval }),
    },
  );
  const layerServerSettings = ServerSettings.layerTest({});
  const layerThreadManagement = ThreadManagement.layer.pipe(
    Layer.provide(layerOrchestrator),
    Layer.provide(layerServerSettings),
    Layer.provide(CommandReceiptStore.layer.pipe(Layer.provide(layerDatabase))),
  );
  const layerOutbox = EffectOutbox.layer.pipe(Layer.provide(layerDatabase));
  const generateThreadTitle = vi.fn(
    options.generateTitle ?? (() => Effect.succeed({ title: "Generated title" })),
  );
  const layerProjectedProjects = Layer.mock(ProjectStore.ProjectStoreV2)({
    get: (requestedProjectId) =>
      Effect.succeed(
        requestedProjectId === projectId
          ? Option.some({
              projectId,
              title: "Project",
              workspaceRoot: "/repo",
              defaultModelSelection: modelSelection,
              defaultThreadEnvMode: null,
              autoPull: false,
              faviconPath: null,
              projectIcon: null,
              scripts: [],
              pinnedAt: null,
              archivedAt: null,
              createdAt: "2026-06-20T00:00:00.000Z",
              updatedAt: "2026-06-20T00:00:00.000Z",
              deletedAt: null,
            })
          : Option.none(),
      ),
  });
  const layerTitleRegeneration = ThreadTitleRegeneration.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        layerThreadManagement,
        layerProjectedProjects,
        Layer.mock(TextGeneration.TextGeneration)({ generateThreadTitle }),
        layerServerSettings,
        NodeServices.layer,
      ),
    ),
  );
  return {
    layer: Layer.mergeAll(
      layerOrchestrator,
      layerThreadManagement,
      layerTitleRegeneration,
      layerOutbox,
      layerDatabase,
    ),
    generateThreadTitle,
  };
}

function createThread(input: {
  readonly command: string;
  readonly thread: string;
  readonly worktreePath?: string;
}) {
  return Effect.gen(function* () {
    const threads = yield* ThreadManagement.ThreadManagementService;
    const threadId = ThreadId.make(input.thread);
    yield* threads.dispatch({
      type: "thread.create",
      commandId: CommandId.make(input.command),
      threadId,
      projectId,
      title: "Seed title",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: input.worktreePath ?? null,
      createdBy: "user",
      creationSource: "web",
    });
    return threadId;
  });
}

function dispatchUserMessage(input: {
  readonly command: string;
  readonly threadId: ThreadId;
  readonly text: string;
  readonly attachments?: ReadonlyArray<ChatAttachment>;
  readonly titleSeed?: string;
  readonly createdBy?: "user" | "agent";
  readonly scheduledTaskId?: ScheduledTaskId;
}) {
  return Effect.gen(function* () {
    const threads = yield* ThreadManagement.ThreadManagementService;
    yield* threads.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(input.command),
      threadId: input.threadId,
      messageId: MessageId.make(`${input.command}:message`),
      text: input.text,
      attachments: input.attachments ?? [],
      ...(input.titleSeed === undefined ? {} : { titleSeed: input.titleSeed }),
      ...(input.scheduledTaskId === undefined ? {} : { scheduledTaskId: input.scheduledTaskId }),
      modelSelection,
      dispatchMode: { type: "defer_start" },
      createdBy: input.createdBy ?? "user",
      creationSource: "web",
    });
  });
}

/** Records a settled source run with one exchange, as a provider turn would. */
function recordRun(input: {
  readonly threadId: ThreadId;
  readonly runId: RunId;
  readonly ordinal: number;
  readonly user: string;
  readonly assistant: string;
  readonly status?: "completed" | "rolled_back";
}) {
  return Effect.gen(function* () {
    const eventSink = yield* EventSink.EventSinkV2;
    const now = yield* DateTime.now;
    const providerThreadId = ProviderThreadId.make(`${input.threadId}:provider`);
    const message = (role: "user" | "assistant", text: string) => ({
      id: EventId.make(`${input.runId}:${role}`),
      type: "message.updated" as const,
      threadId: input.threadId,
      runId: input.runId,
      occurredAt: now,
      payload: {
        id: MessageId.make(`${input.runId}:${role}`),
        threadId: input.threadId,
        runId: input.runId,
        nodeId: null,
        role,
        text,
        attachments: [],
        streaming: false,
        createdBy: "user" as const,
        creationSource: "web" as const,
        createdAt: now,
        updatedAt: now,
      },
    });
    yield* eventSink.write({
      events: [
        {
          id: EventId.make(`${input.runId}:created`),
          type: "run.created",
          threadId: input.threadId,
          runId: input.runId,
          occurredAt: now,
          payload: {
            id: input.runId,
            threadId: input.threadId,
            ordinal: input.ordinal,
            providerInstanceId: modelSelection.instanceId,
            modelSelection,
            providerThreadId,
            userMessageId: MessageId.make(`${input.runId}:user`),
            rootNodeId: null,
            activeAttemptId: null,
            status: input.status ?? "completed",
            requestedAt: now,
            startedAt: now,
            completedAt: now,
            checkpointId: null,
            contextHandoffId: null,
          },
        },
        {
          id: EventId.make(`${input.runId}:provider-thread`),
          type: "provider-thread.updated",
          threadId: input.threadId,
          occurredAt: now,
          payload: {
            id: providerThreadId,
            driver: adapter.driver,
            providerInstanceId: modelSelection.instanceId,
            providerSessionId: null,
            appThreadId: input.threadId,
            ownerNodeId: null,
            nativeThreadRef: { driver: adapter.driver, nativeId: "native", strength: "strong" },
            nativeConversationHeadRef: null,
            status: "idle",
            firstRunOrdinal: 1,
            lastRunOrdinal: input.ordinal,
            handoffIds: [],
            forkedFrom: null,
            createdAt: now,
            updatedAt: now,
          },
        },
        message("user", input.user),
        message("assistant", input.assistant),
      ],
    });
  });
}

function armRegeneration(input: { readonly command: string; readonly threadId: ThreadId }) {
  return Effect.gen(function* () {
    const threads = yield* ThreadManagement.ThreadManagementService;
    const requestId = CommandId.make(input.command);
    yield* threads.dispatch({
      type: "thread.metadata.update",
      commandId: requestId,
      threadId: input.threadId,
      regenerateTitle: true,
    });
    return requestId;
  });
}

describe("formatThreadTitleContext", () => {
  it("pins the first user message ahead of the retained tail once content stops fitting", () => {
    const context = ThreadTitleRegeneration.formatThreadTitleContext([
      { role: "user", text: `Ancient context that anchors the topic ${"x".repeat(600)}` },
      { role: "assistant", text: "y".repeat(6_000) },
      { role: "user", text: "z".repeat(1_500) },
    ]);
    assert.isTrue(context.message.includes("USER:\nAncient context that anchors the topic"));
    assert.isTrue(context.message.includes("[Earlier content truncated]\n\n"));
    assert.isTrue(context.message.includes("y".repeat(100)));
  });
});

describe("ThreadTitleRegenerationService", () => {
  it.effect(
    "titles an image-only first message without sending bootstrap text to the title model",
    () =>
      Effect.gen(function* () {
        for (const prefix of ["", "Ultrathink:\n"]) {
          const harness = makeHarness();
          yield* Effect.gen(function* () {
            const threads = yield* ThreadManagement.ThreadManagementService;
            const service = yield* ThreadTitleRegeneration.ThreadTitleRegenerationService;
            const threadId = yield* createThread({
              command: "image:create",
              thread: "image:thread",
            });
            const text = prefix + ATTACHMENT_ONLY_BOOTSTRAP_PROMPT;
            const attachments = [
              {
                type: "image" as const,
                id: ChatAttachmentId.make("diagram"),
                name: "diagram.png",
                mimeType: "image/png",
                sizeBytes: 10,
              },
            ];
            yield* dispatchUserMessage({ command: "image:message", threadId, text, attachments });
            const requestId = yield* armRegeneration({ command: "image:title", threadId });
            const messageId = MessageId.make("image:message:message");
            yield* service.execute({ threadId, requestId, kind: { type: "initial", messageId } });
            const call = harness.generateThreadTitle.mock.calls[0]?.[0];
            assert.equal(call?.message, "");
            assert.deepEqual(call?.attachments, attachments);
            const projection = yield* threads.getThreadProjection(threadId);
            assert.equal(projection.messages[0]?.text, text);
            assert.equal(projection.thread.title, "Generated title");
          }).pipe(Effect.provide(harness.layer));
        }
      }),
  );

  it.effect("arms and clears the regeneration marker through metadata commands", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      yield* Effect.gen(function* () {
        const threads = yield* ThreadManagement.ThreadManagementService;
        const outbox = yield* EffectOutbox.EffectOutboxV2;
        const threadId = yield* createThread({
          command: "command:title:arm:create",
          thread: "thread:title:arm",
        });

        const firstRequest = yield* armRegeneration({ command: "command:title:arm:1", threadId });
        const armed = yield* threads.getThreadProjection(threadId);
        assert.equal(armed.thread.titleRegeneration?.requestId, firstRequest);
        assert.deepEqual(
          (yield* outbox.listByCommandId(firstRequest)).map((effect) => effect.request),
          [{ type: "thread-title.generate", kind: { type: "regenerate" } }],
        );

        yield* threads.dispatch({
          type: "thread.metadata.update",
          commandId: CommandId.make("command:title:arm:abandon"),
          threadId,
          regenerateTitle: false,
        });
        const abandoned = yield* threads.getThreadProjection(threadId);
        assert.isNotOk(abandoned.thread.titleRegeneration);

        yield* armRegeneration({ command: "command:title:arm:2", threadId });
        yield* threads.dispatch({
          type: "thread.metadata.update",
          commandId: CommandId.make("command:title:arm:rename"),
          threadId,
          title: "Manual title",
        });
        const renamed = yield* threads.getThreadProjection(threadId);
        assert.equal(renamed.thread.title, "Manual title");
        assert.isNotOk(renamed.thread.titleRegeneration);
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("skips execution when the marker was superseded by a newer request", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      yield* Effect.gen(function* () {
        const threads = yield* ThreadManagement.ThreadManagementService;
        const titleRegeneration = yield* ThreadTitleRegeneration.ThreadTitleRegenerationService;
        const threadId = yield* createThread({
          command: "command:title:stale:create",
          thread: "thread:title:stale",
        });
        const staleRequest = yield* armRegeneration({ command: "command:title:stale:1", threadId });
        const currentRequest = yield* armRegeneration({
          command: "command:title:stale:2",
          threadId,
        });

        yield* titleRegeneration.execute({
          threadId,
          requestId: staleRequest,
          kind: { type: "regenerate" },
        });

        assert.equal(harness.generateThreadTitle.mock.calls.length, 0);
        const projection = yield* threads.getThreadProjection(threadId);
        assert.equal(projection.thread.title, "Seed title");
        assert.equal(projection.thread.titleRegeneration?.requestId, currentRequest);
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("lands the regenerated title from the conversation digest", () =>
    Effect.gen(function* () {
      const harness = makeHarness({
        generateTitle: () => Effect.succeed({ title: "Fresh title" }),
      });
      const fs = yield* FileSystem.FileSystem;
      const existingWorktree = yield* fs.makeTempDirectoryScoped({ prefix: "title-worktree-" });
      yield* Effect.gen(function* () {
        const threads = yield* ThreadManagement.ThreadManagementService;
        const titleRegeneration = yield* ThreadTitleRegeneration.ThreadTitleRegenerationService;
        const cases = [
          { name: "removed", worktreePath: "/repo-worktrees/removed-by-cleanup", cwd: "/repo" },
          { name: "existing", worktreePath: existingWorktree, cwd: existingWorktree },
        ];
        for (const [index, testCase] of cases.entries()) {
          const threadId = yield* createThread({
            command: `command:title:landing:${testCase.name}:create`,
            thread: `thread:title:landing:${testCase.name}`,
            worktreePath: testCase.worktreePath,
          });
          yield* dispatchUserMessage({
            command: `command:title:landing:${testCase.name}:message`,
            threadId,
            text: "Investigate the flaky login test",
          });
          const requestId = yield* armRegeneration({
            command: `command:title:landing:${testCase.name}:1`,
            threadId,
          });

          yield* titleRegeneration.execute({ threadId, requestId, kind: { type: "regenerate" } });

          const call = harness.generateThreadTitle.mock.calls[index]?.[0];
          assert.equal(call?.previousTitle, "Seed title");
          assert.equal(call?.cwd, testCase.cwd);
          assert.include(call?.message, "USER:\nInvestigate the flaky login test");
          const projection = yield* threads.getThreadProjection(threadId);
          assert.equal(projection.thread.title, "Fresh title");
          assert.isNotOk(projection.thread.titleRegeneration);
        }
      }).pipe(Effect.provide(harness.layer));
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("titles a fork's first message with the source history up to the fork point", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      yield* Effect.gen(function* () {
        const threads = yield* ThreadManagement.ThreadManagementService;
        const titleRegeneration = yield* ThreadTitleRegeneration.ThreadTitleRegenerationService;
        const sourceThreadId = yield* createThread({
          command: "command:title:fork:create",
          thread: "thread:title:fork:source",
        });
        yield* recordRun({
          threadId: sourceThreadId,
          runId: RunId.make("run:title:fork:0"),
          ordinal: 1,
          user: "Rolled back attempt",
          assistant: "Discarded.",
          status: "rolled_back",
        });
        const forkRunId = RunId.make("run:title:fork:1");
        yield* recordRun({
          threadId: sourceThreadId,
          runId: forkRunId,
          ordinal: 2,
          user: "Move session storage from Redis to Postgres",
          assistant: "Sessions now persist in the Postgres sessions table.",
        });
        yield* recordRun({
          threadId: sourceThreadId,
          runId: RunId.make("run:title:fork:2"),
          ordinal: 3,
          user: "Later work the fork never saw",
          assistant: "Done.",
        });
        const forkThreadId = ThreadId.make("thread:title:fork:target");
        yield* threads.dispatch({
          type: "thread.fork",
          commandId: CommandId.make("command:title:fork:fork"),
          sourceThreadId,
          targetThreadId: forkThreadId,
          sourcePoint: { type: "run", runId: forkRunId },
          createdBy: "user",
          creationSource: "web",
        });
        const requestId = CommandId.make("command:title:fork:message");
        const messageId = MessageId.make("command:title:fork:message:message");
        yield* threads.dispatch({
          type: "message.dispatch",
          commandId: requestId,
          threadId: forkThreadId,
          messageId,
          text: "Try SQLite instead",
          titleSeed: "Try SQLite instead",
          attachments: [],
          modelSelection,
          dispatchMode: { type: "defer_start" },
          createdBy: "user",
          creationSource: "web",
        });

        yield* titleRegeneration.execute({
          threadId: forkThreadId,
          requestId,
          kind: { type: "initial", messageId },
        });

        const call = harness.generateThreadTitle.mock.calls[0]?.[0];
        assert.equal(call?.message, "Try SQLite instead");
        assert.equal(call?.forkSource?.title, "Seed title");
        assert.include(call?.forkSource?.history, "Move session storage from Redis to Postgres");
        assert.include(call?.forkSource?.history, "Sessions now persist in the Postgres");
        assert.notInclude(call?.forkSource?.history, "Later work the fork never saw");
        assert.notInclude(call?.forkSource?.history, "Rolled back attempt");
        const fork = yield* threads.getThreadProjection(forkThreadId);
        assert.equal(fork.thread.title, "Generated title");
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("clears the marker and keeps the title when generation fails", () =>
    Effect.gen(function* () {
      const harness = makeHarness({
        generateTitle: () => Effect.die(new Error("model unavailable")),
      });
      yield* Effect.gen(function* () {
        const threads = yield* ThreadManagement.ThreadManagementService;
        const titleRegeneration = yield* ThreadTitleRegeneration.ThreadTitleRegenerationService;
        const threadId = yield* createThread({
          command: "command:title:failure:create",
          thread: "thread:title:failure",
        });
        yield* dispatchUserMessage({
          command: "command:title:failure:message",
          threadId,
          text: "Some conversation",
        });
        const requestId = yield* armRegeneration({ command: "command:title:failure:1", threadId });

        yield* titleRegeneration.execute({ threadId, requestId, kind: { type: "regenerate" } });

        assert.equal(harness.generateThreadTitle.mock.calls.length, 1);
        const projection = yield* threads.getThreadProjection(threadId);
        assert.equal(projection.thread.title, "Seed title");
        assert.isNotOk(projection.thread.titleRegeneration);
        // A failure must not hand a title someone chose to automatic regeneration.
        assert.isUndefined(projection.thread.automaticTitle);
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect.each([false, true])(
    "regenerates on every Nth message until renamed (compacted: %s)",
    (compacted) =>
      Effect.gen(function* () {
        let generated = 0;
        const harness = makeHarness({
          regenerationInterval: 2,
          // Request 1 declines to title the seed; request 4 is the manual one and keeps what it finds.
          generateTitle: () =>
            Effect.sync(() => {
              generated += 1;
              if (generated === 1) return { title: "New thread" };
              return { title: generated === 4 ? "Manual title" : `Generated ${generated}` };
            }),
        });
        yield* Effect.gen(function* () {
          const threads = yield* ThreadManagement.ThreadManagementService;
          const outbox = yield* EffectOutbox.EffectOutboxV2;
          const service = yield* ThreadTitleRegeneration.ThreadTitleRegenerationService;
          const threadId = yield* createThread({
            command: "command:title:auto:create",
            thread: "thread:title:auto",
          });
          const title = Effect.map(threads.getThreadProjection(threadId), (it) => it.thread.title);
          // Sends a message, runs the title job it queued, and reports which kind that was.
          const send = Effect.fn(function* (
            step: string,
            message: Pick<
              Parameters<typeof dispatchUserMessage>[0],
              "titleSeed" | "createdBy" | "scheduledTaskId"
            > = {},
          ) {
            const command = `command:title:auto:${step}`;
            yield* dispatchUserMessage({ command, threadId, text: `Message ${step}`, ...message });
            const requestId = CommandId.make(command);
            const queued = (yield* outbox.listByCommandId(requestId)).flatMap((effect) =>
              effect.request.type === "thread-title.generate" ? [effect.request.kind] : [],
            );
            for (const kind of queued) yield* service.execute({ threadId, requestId, kind });
            return queued.map((kind) => kind.type);
          });

          assert.deepEqual(yield* send("1", { titleSeed: "First ask" }), ["initial"]);
          // The seed stays T3's title, so the next due message retries it.
          assert.equal(yield* title, "First ask");
          assert.deepEqual(yield* send("2"), ["regenerate"]);
          assert.equal(yield* title, "Generated 2");
          assert.deepEqual(yield* send("3"), []);
          if (compacted) {
            const compactCommand = "command:title:auto:compact";
            yield* dispatchUserMessage({ command: compactCommand, threadId, text: "/compact" });
            const projection = yield* threads.getThreadProjection(threadId);
            const compactRun = projection.runs.find(
              (run) => run.userMessageId === MessageId.make(`${compactCommand}:message`),
            )!;
            const before = yield* DateTime.now;
            const after = DateTime.add(before, { seconds: 1 });
            yield* (yield* EventSink.EventSinkV2).write({
              events: [
                ...projection.runs.map((run) => ({
                  id: EventId.make(`${run.id}:completed`),
                  type: "run.updated" as const,
                  threadId,
                  runId: run.id,
                  occurredAt: after,
                  payload: {
                    ...run,
                    status: "completed" as const,
                    requestedAt: run.id === compactRun.id ? after : before,
                    startedAt: run.id === compactRun.id ? after : before,
                    completedAt: run.id === compactRun.id ? after : before,
                  },
                })),
                {
                  id: EventId.make("event:title:auto:compacted"),
                  type: "turn-item.updated",
                  threadId,
                  runId: compactRun.id,
                  occurredAt: after,
                  payload: {
                    id: TurnItemId.make("item:title:auto:compacted"),
                    threadId,
                    runId: compactRun.id,
                    nodeId: null,
                    providerThreadId: null,
                    providerTurnId: null,
                    nativeItemRef: null,
                    parentItemId: null,
                    ordinal: projection.turnItems.length + 1,
                    status: "completed",
                    title: null,
                    startedAt: after,
                    completedAt: after,
                    updatedAt: after,
                    type: "compaction",
                    driver: adapter.driver,
                  },
                },
              ],
            });
          }
          // Agent and scheduled traffic neither trigger a regeneration nor count toward the next.
          assert.deepEqual(yield* send("agent", { createdBy: "agent" }), []);
          const scheduledTaskId = ScheduledTaskId.make("task:title:auto");
          assert.deepEqual(yield* send("scheduled", { scheduledTaskId }), []);
          assert.deepEqual(yield* send("4"), ["regenerate"]);
          assert.equal(yield* title, "Generated 3");

          yield* threads.dispatch({
            type: "thread.metadata.update",
            commandId: CommandId.make("command:title:auto:rename"),
            threadId,
            title: "Manual title",
          });
          assert.deepEqual(yield* send("5"), []);
          assert.deepEqual(yield* send("6"), []);
          assert.equal(yield* title, "Manual title");

          // Asking for a generated title hands the thread back, even when the title stands.
          const requestId = yield* armRegeneration({
            command: "command:title:auto:regen",
            threadId,
          });
          yield* service.execute({ threadId, requestId, kind: { type: "regenerate" } });
          assert.equal(yield* title, "Manual title");
          assert.deepEqual(yield* send("7"), []);
          assert.deepEqual(yield* send("8"), ["regenerate"]);
          assert.equal(yield* title, "Generated 5");
        }).pipe(Effect.provide(harness.layer));
      }),
  );

  it.effect("leaves titles alone when no regeneration interval is set", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      yield* Effect.gen(function* () {
        const outbox = yield* EffectOutbox.EffectOutboxV2;
        const service = yield* ThreadTitleRegeneration.ThreadTitleRegenerationService;
        const threadId = yield* createThread({
          command: "command:title:off:create",
          thread: "thread:title:off",
        });
        const first = "command:title:off:1";
        yield* dispatchUserMessage({
          command: first,
          threadId,
          text: "First ask",
          titleSeed: "First ask",
        });
        // Finish the first title so only the missing interval can hold regeneration back.
        yield* service.execute({
          threadId,
          requestId: CommandId.make(first),
          kind: { type: "initial", messageId: MessageId.make(`${first}:message`) },
        });
        for (const step of [2, 3, 4, 5]) {
          const command = `command:title:off:${step}`;
          yield* dispatchUserMessage({ command, threadId, text: `Message ${step}` });
          assert.deepEqual(
            (yield* outbox.listByCommandId(CommandId.make(command))).filter(
              (effect) => effect.request.type === "thread-title.generate",
            ),
            [],
          );
        }
      }).pipe(Effect.provide(harness.layer));
    }),
  );
});
