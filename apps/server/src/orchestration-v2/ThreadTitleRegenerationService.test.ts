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
  TextGenerationError,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";
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
  } = {},
) {
  const layerDatabase = SqlitePersistence.layerMemory;
  const layerRegistry = ProviderAdapterRegistry.layerFromAdapters([adapter]);
  const layerOrchestrator = ProviderReplayHarness.layerWithRegistry(
    { name: "thread-title-regeneration" },
    layerRegistry,
    { databaseLayer: layerDatabase, runEffectWorker: false },
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
              hasCustomTitle: false,
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
      modelSelection,
      dispatchMode: { type: "defer_start" },
      createdBy: "user",
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

/** Forks a source thread at its middle run, between a rolled-back run and later work. */
function forkSeededSource(prefix: string, sideChat = false, rollbackPriorRun = true) {
  return Effect.gen(function* () {
    const threads = yield* ThreadManagement.ThreadManagementService;
    const sourceThreadId = yield* createThread({
      command: `${prefix}:create`,
      thread: `${prefix}:source`,
    });
    yield* recordRun({
      threadId: sourceThreadId,
      runId: RunId.make(`${prefix}:run:0`),
      ordinal: 1,
      user: "Rolled back attempt",
      assistant: "Discarded.",
      status: rollbackPriorRun ? "rolled_back" : "completed",
    });
    yield* TestClock.adjust(1);
    const forkRunId = RunId.make(`${prefix}:run:1`);
    yield* recordRun({
      threadId: sourceThreadId,
      runId: forkRunId,
      ordinal: 2,
      user: "Move session storage from Redis to Postgres",
      assistant: "Sessions now persist in the Postgres sessions table.",
    });
    yield* recordRun({
      threadId: sourceThreadId,
      runId: RunId.make(`${prefix}:run:2`),
      ordinal: 3,
      user: "Later work the fork never saw",
      assistant: "Done.",
    });
    const forkThreadId = ThreadId.make(`${prefix}:target`);
    yield* threads.dispatch({
      type: "thread.fork",
      commandId: CommandId.make(`${prefix}:fork`),
      sourceThreadId,
      targetThreadId: forkThreadId,
      sourcePoint: { type: "run", runId: forkRunId },
      sideChat,
      createdBy: "user",
      creationSource: "web",
    });
    return { sourceThreadId, forkRunId, forkThreadId };
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
          assert.deepInclude(projection.thread.lastTitleRegeneration, {
            requestId,
            status: "renamed",
          });
        }
      }).pipe(Effect.provide(harness.layer));
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect.each([
    { name: "its first message", followUp: true },
    { name: "no message of its own yet", followUp: false },
  ])("titles a fork with $name from the source history up to the fork point", ({ followUp }) =>
    Effect.gen(function* () {
      const harness = makeHarness();
      yield* Effect.gen(function* () {
        const threads = yield* ThreadManagement.ThreadManagementService;
        const titleRegeneration = yield* ThreadTitleRegeneration.ThreadTitleRegenerationService;
        const { forkThreadId } = yield* forkSeededSource("thread:title:fork");
        const requestId = CommandId.make("command:title:fork:request");
        const messageId = MessageId.make("command:title:fork:request:message");
        if (followUp) {
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
        } else {
          yield* armRegeneration({ command: requestId, threadId: forkThreadId });
        }

        yield* titleRegeneration.execute({
          threadId: forkThreadId,
          requestId,
          kind: followUp ? { type: "initial", messageId } : { type: "regenerate" },
        });

        const call = harness.generateThreadTitle.mock.calls[0]?.[0];
        assert.equal(call?.message, followUp ? "Try SQLite instead" : "");
        assert.equal(call?.forkSource?.title, "Seed title");
        assert.include(call?.forkSource?.history, "Move session storage from Redis to Postgres");
        assert.include(call?.forkSource?.history, "Sessions now persist in the Postgres");
        assert.notInclude(call?.forkSource?.history, "Later work the fork never saw");
        assert.notInclude(call?.forkSource?.history, "Rolled back attempt");
        const fork = yield* threads.getThreadRecords(forkThreadId, []);
        assert.equal(fork.thread.title, "Generated title");
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect.each(["plain", "deleted source"] as const)(
    "refuses to title an empty thread with %s history",
    (history) =>
      Effect.gen(function* () {
        const harness = makeHarness();
        yield* Effect.gen(function* () {
          const threads = yield* ThreadManagement.ThreadManagementService;
          const titleRegeneration = yield* ThreadTitleRegeneration.ThreadTitleRegenerationService;
          const { forkThreadId } = yield* forkSeededSource("thread:title:empty");
          const { thread } = yield* threads.getThreadProjection(forkThreadId);
          const eventSink = yield* EventSink.EventSinkV2;
          yield* eventSink.write({
            events: [
              {
                id: EventId.make("empty:lineage"),
                type: "thread.metadata-updated",
                threadId: forkThreadId,
                occurredAt: yield* DateTime.now,
                payload: {
                  ...thread,
                  forkedFrom:
                    history === "plain"
                      ? null
                      : {
                          type: "run",
                          threadId: ThreadId.make("absent"),
                          runId: RunId.make("absent"),
                        },
                },
              },
            ],
          });
          const requestId = yield* armRegeneration({
            command: "empty:request",
            threadId: forkThreadId,
          });
          yield* titleRegeneration.execute({
            threadId: forkThreadId,
            requestId,
            kind: { type: "regenerate" },
          });
          assert.equal(harness.generateThreadTitle.mock.calls.length, 0);
          const fork = yield* threads.getThreadRecords(forkThreadId, []);
          assert.deepInclude(fork.thread.lastTitleRegeneration, {
            requestId,
            status: "failed",
            message: "This thread has no messages to title yet.",
          });
        }).pipe(Effect.provide(harness.layer));
      }),
  );

  it.effect("keeps the fork point when the source rolls it back after forking", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      yield* Effect.gen(function* () {
        const threads = yield* ThreadManagement.ThreadManagementService;
        const titleRegeneration = yield* ThreadTitleRegeneration.ThreadTitleRegenerationService;
        const { sourceThreadId, forkRunId, forkThreadId } = yield* forkSeededSource(
          "thread:title:rollback",
          false,
          false,
        );
        yield* TestClock.adjust(1);
        const source = yield* threads.getThreadRecords(sourceThreadId, ["runs"]);
        const run = source.runs.find((run) => run.id === forkRunId);
        assert.isDefined(run);
        const now = yield* DateTime.now;
        const eventSink = yield* EventSink.EventSinkV2;
        yield* eventSink.write({
          events: [
            {
              id: EventId.make("source:rollback"),
              type: "run.updated",
              threadId: sourceThreadId,
              runId: run.id,
              occurredAt: now,
              payload: { ...run, status: "rolled_back", completedAt: now },
            },
          ],
        });
        const requestId = yield* armRegeneration({
          command: "rollback:request",
          threadId: forkThreadId,
        });
        yield* titleRegeneration.execute({
          threadId: forkThreadId,
          requestId,
          kind: { type: "regenerate" },
        });
        const call = harness.generateThreadTitle.mock.calls[0]?.[0];
        assert.include(call?.forkSource?.history, "Move session storage from Redis to Postgres");
        assert.include(call?.forkSource?.history, "Rolled back attempt");
        assert.notInclude(call?.forkSource?.history, "Later work the fork never saw");
        const fork = yield* threads.getThreadRecords(forkThreadId, []);
        assert.equal(fork.thread.title, "Generated title");
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("does not inherit imported history when the fork point is missing", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      yield* Effect.gen(function* () {
        const threads = yield* ThreadManagement.ThreadManagementService;
        const titleRegeneration = yield* ThreadTitleRegeneration.ThreadTitleRegenerationService;
        const { sourceThreadId, forkThreadId } = yield* forkSeededSource("thread:title:invalid");
        yield* dispatchUserMessage({
          command: "imported:message",
          threadId: sourceThreadId,
          text: "Imported history",
        });
        const source = yield* threads.getThreadRecords(sourceThreadId, []);
        const fork = yield* threads.getThreadRecords(forkThreadId, []);
        const eventSink = yield* EventSink.EventSinkV2;
        yield* eventSink.write({
          events: [
            {
              id: EventId.make("source:imported"),
              type: "thread.metadata-updated",
              threadId: sourceThreadId,
              occurredAt: yield* DateTime.now,
              payload: { ...source.thread, historyOrigin: "v1_import" },
            },
            {
              id: EventId.make("fork:missing-run"),
              type: "thread.metadata-updated",
              threadId: forkThreadId,
              occurredAt: yield* DateTime.now,
              payload: {
                ...fork.thread,
                forkedFrom: {
                  type: "run",
                  threadId: sourceThreadId,
                  runId: RunId.make("absent:run"),
                },
              },
            },
          ],
        });
        const requestId = yield* armRegeneration({
          command: "invalid:request",
          threadId: forkThreadId,
        });
        yield* titleRegeneration.execute({
          threadId: forkThreadId,
          requestId,
          kind: { type: "regenerate" },
        });
        assert.equal(harness.generateThreadTitle.mock.calls.length, 0);
        const updated = yield* threads.getThreadRecords(forkThreadId, []);
        assert.deepInclude(updated.thread.lastTitleRegeneration, {
          requestId,
          status: "failed",
          message: "This thread has no messages to title yet.",
        });
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("inherits a side chat's own exchange without its parent's history", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      yield* Effect.gen(function* () {
        const threads = yield* ThreadManagement.ThreadManagementService;
        const titleRegeneration = yield* ThreadTitleRegeneration.ThreadTitleRegenerationService;
        const { forkThreadId: sideChatId } = yield* forkSeededSource(
          "thread:title:side-ancestor",
          true,
        );
        const runId = RunId.make("side:run");
        yield* recordRun({
          threadId: sideChatId,
          runId,
          ordinal: 1,
          user: "Side topic",
          assistant: "Side answer",
        });
        const threadId = ThreadId.make("side:fork");
        yield* threads.dispatch({
          type: "thread.fork",
          commandId: CommandId.make("side:fork"),
          sourceThreadId: sideChatId,
          targetThreadId: threadId,
          sourcePoint: { type: "run", runId },
          title: "Side fork",
          createdBy: "user",
          creationSource: "web",
        });
        const requestId = yield* armRegeneration({ command: "side:request", threadId });
        yield* titleRegeneration.execute({ threadId, requestId, kind: { type: "regenerate" } });
        const call = harness.generateThreadTitle.mock.calls[0]?.[0];
        assert.equal(call?.forkSource?.title, "Seed title fork");
        assert.include(call?.forkSource?.history, "Side topic");
        assert.include(call?.forkSource?.history, "Side answer");
        assert.notInclude(call?.forkSource?.history, "Move session storage");
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("clears the marker and keeps the title when generation fails", () =>
    Effect.gen(function* () {
      const harness = makeHarness({
        generateTitle: () =>
          Effect.fail(
            new TextGenerationError({
              operation: "generateThreadTitle",
              detail:
                "Codex CLI command failed: OpenAI Codex\nuser\nConversation text\nmodel unavailable\n",
            }),
          ),
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
        assert.deepInclude(projection.thread.lastTitleRegeneration, {
          requestId,
          status: "failed",
          message: "model unavailable",
        });
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("records an unchanged outcome when the model keeps the current title", () =>
    Effect.gen(function* () {
      const harness = makeHarness({
        generateTitle: () => Effect.succeed({ title: "Seed title" }),
      });
      yield* Effect.gen(function* () {
        const threads = yield* ThreadManagement.ThreadManagementService;
        const titleRegeneration = yield* ThreadTitleRegeneration.ThreadTitleRegenerationService;
        const threadId = yield* createThread({
          command: "command:title:unchanged:create",
          thread: "thread:title:unchanged",
        });
        yield* dispatchUserMessage({
          command: "command:title:unchanged:message",
          threadId,
          text: "Some conversation",
        });
        const requestId = yield* armRegeneration({
          command: "command:title:unchanged:1",
          threadId,
        });

        yield* titleRegeneration.execute({ threadId, requestId, kind: { type: "regenerate" } });

        const projection = yield* threads.getThreadProjection(threadId);
        assert.deepInclude(projection.thread.lastTitleRegeneration, {
          requestId,
          status: "unchanged",
        });
      }).pipe(Effect.provide(harness.layer));
    }),
  );
});
