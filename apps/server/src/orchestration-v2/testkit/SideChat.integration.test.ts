import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProjectId,
  RunId,
  SIDE_CHAT_CONTEXT_FALLBACK_HANDOFF_TITLE,
  SIDE_CHAT_CONTEXT_HANDOFF_TITLE,
  SIDE_CHAT_EXCERPT_MAX_CHARS,
  SIDE_CHAT_SUMMARY_HANDOFF_TITLE,
  SIDE_CHAT_WAIT_CAP_MS,
  TextGenerationError,
  ThreadId,
  type ServerProvider,
} from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import type * as TextGeneration from "../../textGeneration/TextGeneration.ts";
import { withWorkspaceLease } from "../../workspace/workspaceLease.ts";
import { ClaudeProviderCapabilitiesV2 } from "../Adapters/ClaudeAdapterV2.ts";
import { CodexProviderCapabilitiesV2 } from "../Adapters/CodexAdapterV2.ts";
import * as EffectOutbox from "../EffectOutbox.ts";
import * as EffectWorker from "../EffectWorker.ts";
import * as EventSink from "../EventSink.ts";
import * as Orchestrator from "../Orchestrator.ts";
import * as ProviderAdapterRegistry from "../ProviderAdapterRegistry.ts";
import { SIDE_CHAT_OPENING_FRAMING } from "../sideChat/sideChatText.ts";
import { makePromptRecordingAdapter } from "./PromptRecordingAdapter.ts";
import * as ProviderReplayHarness from "./ProviderReplayHarness.ts";
import * as ServerSettings from "../../serverSettings.ts";
import { makeSideChatHarness } from "./SideChatHarness.ts";
import {
  CLAUDE_SELECTION,
  completeLatestRun,
  createLesson,
  LESSON_ANCHOR_MESSAGE_ID,
  LESSON_ANCHOR_TEXT,
  LESSON_MESSAGES,
  LESSON_SELECTION,
  LESSON_SUMMARY,
  LESSON_THREAD_ID,
  LESSON_TOPIC,
  OBSERVATION_PARAGRAPH,
  observationAnchor,
  openSideChatCommand,
  OTHER_ASSISTANT_REPLY,
  OTHER_USER_MESSAGE,
  pendingSideChat,
  type SeedMessage,
  seedSideChatThread,
  seedThreadMessages,
  SIDE_CHAT_THREAD_ID,
  sideChatMessageCommand,
} from "./sideChatFixtures.ts";

const adapter: ProviderAdapter.ProviderAdapterV2["Service"] = {
  instanceId: LESSON_SELECTION.instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
  openSession: () => Effect.die("Execution is paused: opening a side chat starts no provider turn"),
};

/** The orchestrator with a paused adapter and an effect worker that runs only when drained. */
function openHarness() {
  const layerDatabase = SqlitePersistence.layerMemory;
  return Layer.mergeAll(
    ProviderReplayHarness.layerWithRegistry(
      { name: "side-chat-open" },
      ProviderAdapterRegistry.layerFromAdapters([adapter]),
      { databaseLayer: layerDatabase, runEffectWorker: false },
    ),
    EffectOutbox.layer.pipe(Layer.provide(layerDatabase)),
  );
}

const OPEN_REQUEST_ID = "command:side-chat:open";
const OBSERVATION_EXCERPT = "observation space";

const openOnObservation = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  return yield* orchestrator.dispatch(
    openSideChatCommand({
      commandId: OPEN_REQUEST_ID,
      threadId: SIDE_CHAT_THREAD_ID,
      anchor: observationAnchor(),
      excerpt: OBSERVATION_EXCERPT,
    }),
  );
});

const readThread = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    return (yield* orchestrator.getThreadRecords(threadId, [])).thread;
  });

const withAnchorMessage = (change: Partial<SeedMessage>): ReadonlyArray<SeedMessage> =>
  LESSON_MESSAGES.map((message) =>
    message.id === LESSON_ANCHOR_MESSAGE_ID ? { ...message, ...change } : message,
  );

describe("thread.side_chat.open", () => {
  it.effect.each([
    {
      name: "a highlighted reply",
      anchor: observationAnchor(),
      excerptContext: LESSON_ANCHOR_TEXT,
    },
    {
      name: "an HTML embed",
      anchor: {
        ...observationAnchor(),
        start: 0,
        end: 0,
        prefix: "",
        suffix: "",
        embedTitle: "State diagram",
      },
      excerptContext: "",
    },
  ])(
    "opens a side chat from $name without a transfer, pins or title generation",
    ({ anchor, excerptContext }) =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const outbox = yield* EffectOutbox.EffectOutboxV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        yield* createLesson();
        yield* orchestrator.dispatch({
          type: "thread.pin",
          commandId: CommandId.make("command:side-chat:pin-lesson"),
          threadId: LESSON_THREAD_ID,
        });
        assert.isDefined((yield* readThread(LESSON_THREAD_ID)).pinnedAt);

        yield* orchestrator.dispatch(
          openSideChatCommand({
            commandId: OPEN_REQUEST_ID,
            threadId: SIDE_CHAT_THREAD_ID,
            anchor,
            excerpt: OBSERVATION_EXCERPT,
          }),
        );

        const opened = yield* orchestrator.getThreadRecords(SIDE_CHAT_THREAD_ID, [
          "contextTransfers",
        ]);
        assert.equal(opened.thread.title, OBSERVATION_EXCERPT);
        assert.deepEqual(opened.thread.lineage, {
          parentThreadId: LESSON_THREAD_ID,
          relationshipToParent: "fork",
          rootThreadId: LESSON_THREAD_ID,
        });
        assert.isNull(opened.thread.forkedFrom);
        assert.isUndefined(opened.thread.pinnedAt);
        assert.deepEqual(opened.thread.sideChat, {
          lessonThreadId: LESSON_THREAD_ID,
          anchor,
          excerpt: OBSERVATION_EXCERPT,
          excerptContext,
          label: OBSERVATION_EXCERPT,
          opening: { status: "pending", text: null, requestId: OPEN_REQUEST_ID },
          done: null,
        });
        assert.deepEqual(opened.contextTransfers, []);
        assert.deepEqual(
          (yield* orchestrator.getThreadRecords(LESSON_THREAD_ID, ["contextTransfers"]))
            .contextTransfers,
          [],
        );
        assert.deepEqual(
          (yield* outbox.listByCommandId(CommandId.make(OPEN_REQUEST_ID))).map(
            (effect) => effect.request,
          ),
          [{ type: "side-chat.opening" }],
        );

        const messageCommandId = CommandId.make("command:side-chat:first-message");
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: messageCommandId,
          threadId: SIDE_CHAT_THREAD_ID,
          messageId: MessageId.make("message:side-chat:u1"),
          text: "What goes into an observation space?",
          titleSeed: "What goes into an observation space?",
          attachments: [],
          dispatchMode: { type: "defer_start" },
          createdBy: "user",
          creationSource: "web",
        });
        assert.isFalse(
          (yield* outbox.listByCommandId(messageCommandId)).some(
            (effect) => effect.request.type === "thread-title.generate",
          ),
        );
        assert.equal((yield* readThread(SIDE_CHAT_THREAD_ID)).title, OBSERVATION_EXCERPT);

        yield* worker.drain();
        assert.equal((yield* readThread(SIDE_CHAT_THREAD_ID)).sideChat?.opening.status, "fallback");
      }).pipe(Effect.provide(openHarness())),
  );

  it.effect("opens a nested side chat under the same lesson", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const sideChatReplyId = MessageId.make("message:side-chat:a1");
      const nestedThreadId = ThreadId.make("thread:side-chat:nested");
      yield* createLesson();
      yield* openOnObservation;
      yield* seedThreadMessages(SIDE_CHAT_THREAD_ID, [
        {
          id: sideChatReplyId,
          role: "assistant",
          text: "A Box space is a bounded array of numbers.",
        },
      ]);

      yield* orchestrator.dispatch(
        openSideChatCommand({
          commandId: "command:side-chat:open-nested",
          threadId: nestedThreadId,
          anchor: {
            threadId: SIDE_CHAT_THREAD_ID,
            messageId: sideChatReplyId,
            start: 2,
            end: 5,
            prefix: "A ",
            suffix: " space",
          },
          excerpt: "Box",
        }),
      );

      const nested = yield* readThread(nestedThreadId);
      assert.equal(nested.sideChat?.lessonThreadId, LESSON_THREAD_ID);
      assert.equal(nested.lineage.parentThreadId, SIDE_CHAT_THREAD_ID);
    }).pipe(Effect.provide(openHarness())),
  );

  it.effect.each([
    {
      name: "a streaming reply",
      messages: withAnchorMessage({ streaming: true }),
      messageId: LESSON_ANCHOR_MESSAGE_ID,
      excerpt: OBSERVATION_EXCERPT,
      archive: false,
      phrase: "The highlighted reply is still streaming.",
    },
    {
      name: "a user message",
      messages: LESSON_MESSAGES,
      messageId: MessageId.make("message:lesson:u1"),
      excerpt: OBSERVATION_EXCERPT,
      archive: false,
      phrase: `Message message:lesson:u1 is not an assistant reply in thread ${LESSON_THREAD_ID}.`,
    },
    {
      name: "an over-limit excerpt",
      messages: LESSON_MESSAGES,
      messageId: LESSON_ANCHOR_MESSAGE_ID,
      excerpt: "x".repeat(SIDE_CHAT_EXCERPT_MAX_CHARS + 1),
      archive: false,
      phrase: "Side chat excerpts must be 1-4000 characters.",
    },
    {
      name: "an archived lesson",
      messages: LESSON_MESSAGES,
      messageId: LESSON_ANCHOR_MESSAGE_ID,
      excerpt: OBSERVATION_EXCERPT,
      archive: true,
      phrase: `Thread ${LESSON_THREAD_ID} is not active.`,
    },
  ])("refuses to open a side chat on $name", ({ messages, messageId, excerpt, archive, phrase }) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      yield* createLesson({ messages });
      if (archive) {
        yield* orchestrator.dispatch({
          type: "thread.archive",
          commandId: CommandId.make("command:side-chat:archive-lesson"),
          threadId: LESSON_THREAD_ID,
        });
      }

      const error = yield* orchestrator
        .dispatch(
          openSideChatCommand({
            commandId: OPEN_REQUEST_ID,
            threadId: SIDE_CHAT_THREAD_ID,
            anchor: observationAnchor(LESSON_THREAD_ID, messageId),
            excerpt,
          }),
        )
        .pipe(Effect.flip);

      assert.equal(error._tag, "OrchestratorDispatchError");
      assert.include(String(error.cause), phrase);
      assert.isNull(yield* orchestrator.getThreadShell(SIDE_CHAT_THREAD_ID));
    }).pipe(Effect.provide(openHarness())),
  );

  const INTERRUPTED_RUN_ID = RunId.make("run:lesson:interrupted");

  /** The highlighted reply came from a run the user interrupted. */
  const seedInterruptedAnchorRun = Effect.gen(function* () {
    const eventSink = yield* EventSink.EventSinkV2;
    yield* createLesson({ messages: withAnchorMessage({ runId: INTERRUPTED_RUN_ID }) });
    const now = yield* DateTime.now;
    yield* eventSink.write({
      events: [
        {
          id: EventId.make("event:lesson:interrupted-run"),
          type: "run.updated",
          threadId: LESSON_THREAD_ID,
          runId: INTERRUPTED_RUN_ID,
          occurredAt: now,
          payload: {
            id: INTERRUPTED_RUN_ID,
            threadId: LESSON_THREAD_ID,
            ordinal: 1,
            providerInstanceId: LESSON_SELECTION.instanceId,
            modelSelection: LESSON_SELECTION,
            providerThreadId: null,
            userMessageId: MessageId.make("message:lesson:u1"),
            rootNodeId: null,
            activeAttemptId: null,
            status: "interrupted",
            requestedAt: now,
            startedAt: now,
            completedAt: now,
            checkpointId: null,
            contextHandoffId: null,
          },
        },
      ],
    });
  });

  /** A newer lesson reply is still streaming below the highlighted one. */
  const seedStreamingLaterReply = createLesson({
    messages: [
      ...LESSON_MESSAGES,
      {
        id: MessageId.make("message:lesson:a3"),
        role: "assistant",
        text: "LESSON-ONLY: discount factors weigh later rewards",
        streaming: true,
      },
    ],
  });

  it.effect.each([
    { name: "a reply whose run was interrupted", seed: seedInterruptedAnchorRun },
    { name: "an earlier reply while a newer lesson reply streams", seed: seedStreamingLaterReply },
  ])("opens a side chat from $name", ({ seed }) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      yield* seed;

      yield* openOnObservation;

      assert.isNotNull(yield* orchestrator.getThreadShell(SIDE_CHAT_THREAD_ID));
      assert.equal((yield* readThread(SIDE_CHAT_THREAD_ID)).sideChat?.opening.status, "pending");
    }).pipe(Effect.provide(openHarness())),
  );
});

describe("side chat opening context", () => {
  type GenerateSideChatText = TextGeneration.TextGeneration["Service"]["generateSideChatText"];

  /** A recording Codex adapter for the lesson and its side chats, and a Claude one to switch to. */
  const deliveryHarness = Effect.fn("deliveryHarness")(function* (
    name: string,
    options: {
      readonly generateSideChatText?: GenerateSideChatText;
      readonly failResume?: boolean;
      readonly injectHistory?: boolean;
      readonly providers?:
        | ReadonlyArray<ServerProvider>
        | ((cwd: string) => ReadonlyArray<ServerProvider>);
      readonly settings?: Parameters<typeof ServerSettings.layerTest>[0];
      readonly localLesson?: boolean;
      readonly claudeMetadata?: "enabled" | "disabled" | "missing";
    } = {},
  ) {
    const cwd = yield* checkpointWorkspace(name);
    const lesson = yield* makePromptRecordingAdapter({
      instanceId: LESSON_SELECTION.instanceId,
      driver: ProviderDriverKind.make("codex"),
      capabilities: CodexProviderCapabilitiesV2,
      cwd,
      ...(options.failResume === undefined ? {} : { failResume: options.failResume }),
      ...(options.injectHistory === undefined ? {} : { injectHistory: options.injectHistory }),
    });
    const switched = yield* makePromptRecordingAdapter({
      instanceId: CLAUDE_SELECTION.instanceId,
      driver: ProviderDriverKind.make("claudeAgent"),
      capabilities: ClaudeProviderCapabilitiesV2,
      cwd,
    });
    const adapters = [lesson.adapter, switched.adapter];
    const registry = Layer.succeed(
      ProviderAdapterRegistry.ProviderAdapterRegistryV2,
      ProviderAdapterRegistry.ProviderAdapterRegistryV2.of({
        get: (instanceId) => {
          const adapter = adapters.find((candidate) => candidate.instanceId === instanceId);
          return adapter === undefined
            ? Effect.fail(
                new ProviderAdapterRegistry.ProviderAdapterRegistryLookupError({ instanceId }),
              )
            : Effect.succeed(adapter);
        },
        list: () => Effect.succeed(adapters.map((adapter) => adapter.instanceId)),
        getMetadata: (instanceId) => {
          const adapter = adapters.find((candidate) => candidate.instanceId === instanceId);
          if (
            adapter === undefined ||
            (instanceId === CLAUDE_SELECTION.instanceId && options.claudeMetadata === "missing")
          ) {
            return Effect.fail(
              new ProviderAdapterRegistry.ProviderAdapterRegistryLookupError({ instanceId }),
            );
          }
          return adapter.getCapabilities().pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapterRegistry.ProviderAdapterRegistryMetadataError({
                  instanceId,
                  cause,
                }),
            ),
            Effect.map((capabilities) => ({
              driver: adapter.driver,
              continuationKey: String(adapter.instanceId),
              enabled:
                instanceId === CLAUDE_SELECTION.instanceId
                  ? options.claudeMetadata !== "disabled"
                  : true,
              capabilities,
            })),
          );
        },
      }),
    );
    const layer = ProviderReplayHarness.layerWithRegistry(
      {
        name,
        ...(options.localLesson ? { runtimePolicyOverride: { cwd } } : {}),
      },
      registry,
      {
        runEffectWorker: false,
        sideChatTextGeneration:
          options.generateSideChatText ?? (() => Effect.succeed({ text: LESSON_SUMMARY })),
        ...(options.providers === undefined
          ? {}
          : {
              providers:
                typeof options.providers === "function"
                  ? options.providers(cwd)
                  : options.providers,
            }),
        ...(options.settings === undefined ? {} : { settings: options.settings }),
      },
    );
    return {
      cwd,
      layer,
      prompts: lesson.prompts,
      injected: lesson.injected,
      switchPrompts: switched.prompts,
    };
  });

  const ask = (threadId: ThreadId, commandId: string, text: string) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      yield* orchestrator.dispatch(sideChatMessageCommand({ commandId, threadId, text }));
      yield* worker.drain();
    });

  /** Opens a side chat on "observation space", lets its summary land, then asks in it. */
  const openAndAsk = (cwd: string, localLesson = false) =>
    Effect.gen(function* () {
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      yield* createLesson({ worktreePath: localLesson ? null : cwd });
      yield* openOnObservation;
      yield* worker.drain();
      yield* ask(SIDE_CHAT_THREAD_ID, "command:side-chat:ask", "What is an observation space?");
    });

  const promptsFor = (
    prompts: ReadonlyArray<{ threadId: ThreadId; text: string }>,
    threadId: ThreadId,
  ) => prompts.filter((prompt) => prompt.threadId === threadId).map((prompt) => prompt.text);

  const providerWithSkill = (instanceId: ProviderInstanceId, driver: ProviderDriverKind) =>
    ({
      instanceId,
      driver,
      enabled: true,
      installed: true,
      version: null,
      status: "ready",
      auth: { status: "authenticated" },
      checkedAt: "2026-01-01T00:00:00.000Z",
      models: [],
      slashCommands: [],
      skills: [
        {
          name: "review",
          path: "/skills/review/SKILL.md",
          enabled: true,
          userInvocable: true,
        },
      ],
    }) satisfies ServerProvider;

  it.effect("attaches configured skills to Claude's inline opening once", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { cwd, layer, switchPrompts } = yield* deliveryHarness("side-chat-skills-claude", {
          providers: [
            providerWithSkill(LESSON_SELECTION.instanceId, ProviderDriverKind.make("codex")),
            providerWithSkill(CLAUDE_SELECTION.instanceId, ProviderDriverKind.make("claudeAgent")),
          ],
          settings: { sideChatSkills: ["review"] },
        });
        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
          yield* openAndAsk(cwd);
          yield* completeLatestRun(SIDE_CHAT_THREAD_ID);
          yield* orchestrator.dispatch(
            sideChatMessageCommand({
              commandId: "command:side-chat:ask-claude-skills",
              threadId: SIDE_CHAT_THREAD_ID,
              text: "Explain the highlighted idea.",
              modelSelection: CLAUDE_SELECTION,
            }),
          );
          yield* worker.drain();
        }).pipe(Effect.provide(layer));

        const [prompt] = promptsFor(switchPrompts, SIDE_CHAT_THREAD_ID);
        assert.isDefined(prompt);
        assert.equal(prompt!.split("Explain the highlighted idea.").length, 2);
        assert.include(prompt, "User message:\nExplain the highlighted idea.\n$review");
      }),
    ),
  );

  it.effect("attaches configured skills to Codex's injected opening once", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const question = "What is an observation space?";
        const { cwd, layer, prompts, injected } = yield* deliveryHarness("side-chat-skills-codex", {
          injectHistory: true,
          providers: [
            providerWithSkill(LESSON_SELECTION.instanceId, ProviderDriverKind.make("codex")),
          ],
          settings: { sideChatSkills: ["review"] },
        });
        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
          yield* createLesson({ worktreePath: cwd });
          yield* openOnObservation;
          yield* worker.drain();
          yield* ask(SIDE_CHAT_THREAD_ID, "command:side-chat:ask-codex-skills", question);
          const projection = yield* orchestrator.getThreadProjection(SIDE_CHAT_THREAD_ID);
          assert.equal(
            projection.messages.findLast((message) => message.role === "user")?.text,
            question,
          );
          yield* completeLatestRun(SIDE_CHAT_THREAD_ID);
          yield* ask(SIDE_CHAT_THREAD_ID, "command:side-chat:ask-codex-skills-again", "And a Box?");
        }).pipe(Effect.provide(layer));

        const sidePrompts = promptsFor(prompts, SIDE_CHAT_THREAD_ID);
        assert.lengthOf(sidePrompts, 2);
        assert.equal(sidePrompts[0], `${question}\n$review`);
        assert.notInclude(sidePrompts[1], "$review");
        assert.lengthOf(injected, 1);
        assert.include(injected[0]!.history.context, SIDE_CHAT_OPENING_FRAMING);
      }),
    ),
  );

  it.effect("uses the workspace skill catalog for a local side chat", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { cwd, layer, prompts } = yield* deliveryHarness("side-chat-workspace-skills", {
          localLesson: true,
          providers: (workspaceCwd) => [
            {
              ...providerWithSkill(LESSON_SELECTION.instanceId, ProviderDriverKind.make("codex")),
              skills: [],
              workspaceSnapshots: [
                {
                  cwd: workspaceCwd,
                  checkedAt: "2026-01-01T00:00:00.000Z",
                  slashCommands: [],
                  skills: [
                    {
                      name: "review",
                      path: "/workspace/review/SKILL.md",
                      enabled: true,
                      userInvocable: true,
                    },
                  ],
                },
              ],
            },
          ],
          settings: { sideChatSkills: ["review"] },
        });
        yield* openAndAsk(cwd, true).pipe(Effect.provide(layer));
        const [prompt] = promptsFor(prompts, SIDE_CHAT_THREAD_ID);
        assert.isDefined(prompt);
        assert.include(prompt, "\n$review");
      }),
    ),
  );

  it.effect("applies a configured side-chat model only when its provider is usable", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const configured = yield* deliveryHarness("side-chat-model-configured", {
          settings: { sideChatModelSelection: CLAUDE_SELECTION },
        });
        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          yield* createLesson({ worktreePath: configured.cwd });
          yield* openOnObservation;
          const thread = yield* orchestrator.getThreadProjection(SIDE_CHAT_THREAD_ID);
          assert.deepEqual(thread.thread.modelSelection, CLAUDE_SELECTION);
        }).pipe(Effect.provide(configured.layer));

        const missing = yield* deliveryHarness("side-chat-model-missing", {
          settings: {
            sideChatModelSelection: {
              instanceId: ProviderInstanceId.make("missing"),
              model: "missing-model",
            },
            providerInstances: {
              [ProviderInstanceId.make("missing")]: { driver: ProviderDriverKind.make("codex") },
            },
          },
        });
        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          yield* createLesson({ worktreePath: missing.cwd });
          yield* openOnObservation;
          const thread = yield* orchestrator.getThreadProjection(SIDE_CHAT_THREAD_ID);
          assert.deepEqual(thread.thread.modelSelection, LESSON_SELECTION);
          assert.equal(thread.thread.providerInstanceId, LESSON_SELECTION.instanceId);
        }).pipe(Effect.provide(missing.layer));

        const disabled = yield* deliveryHarness("side-chat-model-disabled", {
          claudeMetadata: "disabled",
          settings: { sideChatModelSelection: CLAUDE_SELECTION },
        });
        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          yield* createLesson({ worktreePath: disabled.cwd });
          yield* openOnObservation;
          const thread = yield* orchestrator.getThreadProjection(SIDE_CHAT_THREAD_ID);
          assert.deepEqual(thread.thread.modelSelection, LESSON_SELECTION);
          assert.equal(thread.thread.providerInstanceId, LESSON_SELECTION.instanceId);
        }).pipe(Effect.provide(disabled.layer));

        const disabledProject = yield* deliveryHarness("side-chat-model-disabled-project", {
          settings: {
            sideChatModelSelection: CLAUDE_SELECTION,
            projectSettingsOverrides: {
              [ProjectId.make("project:side-chat")]: {
                providerInstances: { [CLAUDE_SELECTION.instanceId]: { enabled: false } },
              },
            },
          },
        });
        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          yield* createLesson({ worktreePath: disabledProject.cwd });
          yield* openOnObservation;
          const thread = yield* orchestrator.getThreadProjection(SIDE_CHAT_THREAD_ID);
          assert.deepEqual(thread.thread.modelSelection, LESSON_SELECTION);
        }).pipe(Effect.provide(disabledProject.layer));
      }),
    ),
  );

  it.effect(
    "gives the first turn the framing, summary and highlight and no other lesson messages",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { cwd, layer, prompts } = yield* deliveryHarness("side-chat-opening-ready");
          yield* Effect.gen(function* () {
            const orchestrator = yield* Orchestrator.OrchestratorV2;
            yield* openAndAsk(cwd);

            const [prompt] = promptsFor(prompts, SIDE_CHAT_THREAD_ID);
            assert.isDefined(prompt);
            assert.include(prompt, SIDE_CHAT_OPENING_FRAMING);
            assert.include(prompt, LESSON_SUMMARY);
            assert.notInclude(prompt, "Historical material is context");
            assert.include(prompt, OBSERVATION_PARAGRAPH);
            assert.include(prompt, "User message:\nWhat is an observation space?");
            assert.include(prompt, `From thread ${LESSON_THREAD_ID}`);
            assert.notInclude(prompt, `From thread ${SIDE_CHAT_THREAD_ID}`);
            assert.notInclude(prompt, LESSON_TOPIC);
            assert.notInclude(prompt, OTHER_USER_MESSAGE);
            assert.notInclude(prompt, OTHER_ASSISTANT_REPLY);

            const projection = yield* orchestrator.getThreadProjection(SIDE_CHAT_THREAD_ID);
            assert.deepEqual(
              projection.turnItems.flatMap((item) =>
                item.type === "handoff" && item.title === SIDE_CHAT_CONTEXT_HANDOFF_TITLE
                  ? [item.strategy]
                  : [],
              ),
              ["manual_context"],
            );
            assert.deepEqual(projection.contextTransfers, []);
          }).pipe(Effect.provide(layer));
        }),
      ),
  );

  it.effect.each([
    { bytes: 22_500, fails: false },
    { bytes: 34_500, fails: true },
  ])("delivers an opening of $bytes bytes whole or fails the turn", ({ bytes, fails }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const { cwd, layer, prompts } = yield* deliveryHarness(`side-chat-opening-size-${bytes}`);
        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
          yield* createLesson({ worktreePath: cwd });
          const excerpt = "界".repeat(4_000);
          const excerptContext = "語".repeat(1_500);
          const summary = "文".repeat(fails ? 6_000 : 2_000);
          yield* seedSideChatThread({
            threadId: SIDE_CHAT_THREAD_ID,
            anchorThreadId: LESSON_THREAD_ID,
            sideChat: {
              ...pendingSideChat({
                anchor: observationAnchor(),
                excerpt,
                requestId: OPEN_REQUEST_ID,
              }),
              label: "Long highlight",
              excerptContext,
              opening: { status: "ready", text: summary, requestId: OPEN_REQUEST_ID },
            },
          });
          yield* orchestrator.dispatch(
            sideChatMessageCommand({
              commandId: "command:side-chat:large-opening",
              threadId: SIDE_CHAT_THREAD_ID,
              text: "Explain the highlight.",
            }),
          );
          yield* worker.drain();
          const projection = yield* orchestrator.getThreadProjection(SIDE_CHAT_THREAD_ID);
          const opening = projection.contextHandoffs.find((handoff) =>
            handoff.id.startsWith("side-chat-opening:"),
          );
          if (fails) {
            assert.equal(projection.runs.at(-1)?.status, "failed");
            assert.lengthOf(promptsFor(prompts, SIDE_CHAT_THREAD_ID), 0);
            assert.isUndefined(opening?.delivery);
            assert.isTrue(
              projection.turnItems.some(
                (item) =>
                  item.type === "error" && item.failure.message.includes("too little context"),
              ),
            );
          } else {
            const prompt = promptsFor(prompts, SIDE_CHAT_THREAD_ID)[0] ?? "";
            assert.include(prompt, excerpt);
            assert.include(prompt, excerptContext);
            assert.include(prompt, summary);
            assert.equal(opening?.delivery?.status, "inline");
          }
        }).pipe(Effect.provide(layer));
      }),
    ),
  );

  it.effect("uses configured side-chat teaching instructions in the opening", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { cwd, layer, prompts } = yield* deliveryHarness("side-chat-opening-instructions", {
          settings: { sideChatInstructions: "Use one concrete analogy." },
        });
        yield* openAndAsk(cwd).pipe(Effect.provide(layer));
        const [prompt] = promptsFor(prompts, SIDE_CHAT_THREAD_ID);
        assert.isDefined(prompt);
        assert.include(prompt, "Use one concrete analogy.");
        assert.notInclude(prompt, "Answer at their level, briefly and clearly");
      }),
    ),
  );

  it.effect(
    "falls back to the lesson topic and the highlight's surroundings when the summary failed",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { cwd, layer, prompts } = yield* deliveryHarness("side-chat-opening-failed", {
            generateSideChatText: () =>
              Effect.fail(
                new TextGenerationError({
                  operation: "generateSideChatText",
                  detail: "The model is unavailable.",
                }),
              ),
          });
          yield* openAndAsk(cwd).pipe(Effect.provide(layer));

          const [prompt] = promptsFor(prompts, SIDE_CHAT_THREAD_ID);
          assert.isDefined(prompt);
          assert.include(prompt, "The lesson summary is unavailable.");
          assert.include(prompt, LESSON_TOPIC);
          assert.include(prompt, OBSERVATION_PARAGRAPH);
          assert.notInclude(prompt, OTHER_USER_MESSAGE);
          assert.notInclude(prompt, OTHER_ASSISTANT_REPLY);
        }),
      ),
  );

  it.effect("carries the parent side chat's summary into a nested side chat", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { cwd, layer, prompts } = yield* deliveryHarness("side-chat-opening-nested", {
          generateSideChatText: (input) =>
            Effect.succeed({
              text: input.prompt.includes("Box space") ? "NESTED SUMMARY" : LESSON_SUMMARY,
            }),
        });
        const nestedThreadId = ThreadId.make("thread:side-chat:nested");
        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
          const sideChatReplyId = MessageId.make("message:side-chat:a1");
          yield* openAndAsk(cwd);
          yield* seedThreadMessages(SIDE_CHAT_THREAD_ID, [
            {
              id: sideChatReplyId,
              role: "assistant",
              text: "A Box space is a bounded array of numbers.",
            },
          ]);
          yield* orchestrator.dispatch(
            openSideChatCommand({
              commandId: "command:side-chat:open-nested",
              threadId: nestedThreadId,
              anchor: {
                threadId: SIDE_CHAT_THREAD_ID,
                messageId: sideChatReplyId,
                start: 2,
                end: 5,
                prefix: "A ",
                suffix: " space",
              },
              excerpt: "Box",
            }),
          );
          yield* worker.drain();
          yield* ask(nestedThreadId, "command:side-chat:ask-nested", "What is a Box?");
        }).pipe(Effect.provide(layer));

        const [prompt] = promptsFor(prompts, nestedThreadId);
        assert.isDefined(prompt);
        assert.include(prompt, "NESTED SUMMARY");
        assert.include(
          prompt,
          `Context from the side chat this one was opened from:\n${LESSON_SUMMARY}`,
        );
        assert.include(prompt, `From thread ${LESSON_THREAD_ID}`);
        assert.notInclude(prompt, `From thread ${nestedThreadId}`);
      }),
    ),
  );

  it.effect("waits for an opening summary still being written before the first turn", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        const gate = yield* Deferred.make<void>();
        const { cwd, layer, prompts } = yield* deliveryHarness("side-chat-opening-wait", {
          generateSideChatText: () =>
            Deferred.succeed(entered, undefined).pipe(
              Effect.andThen(Deferred.await(gate)),
              Effect.as({ text: LESSON_SUMMARY }),
            ),
        });
        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
          yield* createLesson({ worktreePath: cwd });
          yield* openOnObservation;
          // The turn start becomes claimable after the opening, so the first claim takes the opening.
          yield* TestClock.adjust("1 millis");
          yield* orchestrator.dispatch(
            sideChatMessageCommand({
              commandId: "command:side-chat:ask",
              threadId: SIDE_CHAT_THREAD_ID,
              text: "What is an observation space?",
            }),
          );

          const opening = yield* worker.runOnce.pipe(Effect.forkChild);
          yield* Deferred.await(entered);
          const turnStart = yield* worker.runOnce.pipe(
            Effect.forkChild({ startImmediately: true }),
          );
          // The side chat waits without holding the lesson's worktree, so the lesson can still
          // take it, here to let the summary land.
          yield* withWorkspaceLease(cwd, Deferred.succeed(gate, undefined));
          assert.isTrue(yield* Fiber.join(turnStart));
          yield* Fiber.join(opening);
        }).pipe(Effect.provide(layer));

        const [prompt] = promptsFor(prompts, SIDE_CHAT_THREAD_ID);
        assert.isDefined(prompt);
        assert.include(prompt, LESSON_SUMMARY);
        assert.notInclude(prompt, "The lesson summary is unavailable.");
      }),
    ),
  );

  it.effect("gives the opening context again when the native thread is replaced", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { cwd, layer, prompts } = yield* deliveryHarness("side-chat-opening-replaced", {
          failResume: true,
          providers: [
            providerWithSkill(LESSON_SELECTION.instanceId, ProviderDriverKind.make("codex")),
          ],
          settings: { sideChatSkills: ["review"] },
        });
        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
          yield* openAndAsk(cwd);
          yield* completeLatestRun(SIDE_CHAT_THREAD_ID);
          // A live session answers resume itself; detaching it makes the next turn really try.
          const { providerSessions } = yield* orchestrator.getThreadProjection(SIDE_CHAT_THREAD_ID);
          assert.lengthOf(providerSessions, 1);
          yield* orchestrator.dispatch({
            type: "provider-session.detach",
            commandId: CommandId.make("command:side-chat:detach"),
            threadId: SIDE_CHAT_THREAD_ID,
            providerSessionId: providerSessions[0]!.id,
          });
          yield* worker.drain();
          yield* ask(SIDE_CHAT_THREAD_ID, "command:side-chat:ask-again", "Is it always a Box?");
        }).pipe(Effect.provide(layer));

        const sideChatPrompts = promptsFor(prompts, SIDE_CHAT_THREAD_ID);
        assert.lengthOf(sideChatPrompts, 2);
        assert.include(sideChatPrompts[1], LESSON_SUMMARY);
        assert.include(sideChatPrompts[1], "What is an observation space?");
        assert.include(sideChatPrompts[0], "\n$review");
        assert.include(sideChatPrompts[1], "\n$review");
      }),
    ),
  );

  it.effect("gives the opening context again after a provider switch inside the side chat", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { cwd, layer, switchPrompts } = yield* deliveryHarness("side-chat-opening-switch");
        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
          yield* openAndAsk(cwd);
          yield* completeLatestRun(SIDE_CHAT_THREAD_ID);
          yield* orchestrator.dispatch(
            sideChatMessageCommand({
              commandId: "command:side-chat:ask-claude",
              threadId: SIDE_CHAT_THREAD_ID,
              text: "And what does the agent do with it?",
              modelSelection: CLAUDE_SELECTION,
            }),
          );
          yield* worker.drain();
        }).pipe(Effect.provide(layer));

        const [prompt] = promptsFor(switchPrompts, SIDE_CHAT_THREAD_ID);
        assert.isDefined(prompt);
        assert.include(prompt, SIDE_CHAT_OPENING_FRAMING);
        assert.include(prompt, LESSON_SUMMARY);
      }),
    ),
  );

  it.effect("gives a summary that was ready for the first turn to that turn only", () =>
    Effect.gen(function* () {
      const harness = yield* makeSideChatHarness("side-chat-opening-on-time");
      yield* Effect.gen(function* () {
        const label = "observation space";
        const summary = "ON TIME LESSON SUMMARY";
        harness.scriptOpening("Teach me RL environments.", { text: summary });
        const lesson = yield* harness.createLesson("Teach me RL environments.");
        const space = yield* harness.openSideChat({ parentThreadId: lesson, label });
        yield* harness.send(space, "What is an observation space?");
        yield* harness.send(space, "Is it always a Box?");

        const prompts = harness.prompts(space);
        assert.lengthOf(prompts, 2);
        assert.include(prompts[0], summary);
        assert.notInclude(prompts[1], summary);
        const { turnItems } = yield* Orchestrator.OrchestratorV2.use((orchestrator) =>
          orchestrator.getThreadProjection(space),
        );
        assert.deepEqual(
          turnItems.flatMap((item) => (item.type === "handoff" ? [item.title] : [])),
          [SIDE_CHAT_CONTEXT_HANDOFF_TITLE],
        );
      }).pipe(Effect.provide(harness.layer));
    }).pipe(Effect.scoped),
  );

  it.effect("gives a summary that missed the first turn to the next turn, once", () =>
    Effect.gen(function* () {
      const harness = yield* makeSideChatHarness("side-chat-opening-late");
      yield* Effect.gen(function* () {
        const label = "observation space";
        const lateSummary = "LATE LESSON SUMMARY";
        const gate = yield* Deferred.make<string | null>();
        harness.scriptOpening("Teach me RL environments.", { gate });
        const lesson = yield* harness.createLesson("Teach me RL environments.");
        const space = yield* harness.openSideChat({ parentThreadId: lesson, label });
        const afterAsk = yield* harness.mark;
        const question = yield* harness.send(space, "What is an observation space?", {
          await: "none",
        });
        yield* TestClock.adjust(Duration.millis(SIDE_CHAT_WAIT_CAP_MS));
        yield* harness.awaitRun(afterAsk, question, "completed");

        const afterSummary = yield* harness.mark;
        yield* Deferred.succeed(gate, lateSummary);
        yield* harness.awaitEvent(
          afterSummary,
          (event) =>
            event.type === "thread.metadata-updated" &&
            event.threadId === space &&
            event.payload.sideChat?.opening.status === "ready",
        );
        yield* harness.send(space, "Is it always a Box?");
        yield* harness.send(space, "And a Discrete space?");

        const prompts = harness.prompts(space);
        assert.lengthOf(prompts, 3);
        assert.include(prompts[0], "The lesson summary is unavailable.");
        assert.notInclude(prompts[0], lateSummary);
        assert.include(prompts[1], lateSummary);
        assert.notInclude(prompts[2], lateSummary);

        const { turnItems } = yield* Orchestrator.OrchestratorV2.use((orchestrator) =>
          orchestrator.getThreadProjection(space),
        );
        assert.deepEqual(
          turnItems.flatMap((item) => (item.type === "handoff" ? [item.title] : [])),
          [SIDE_CHAT_CONTEXT_FALLBACK_HANDOFF_TITLE, SIDE_CHAT_SUMMARY_HANDOFF_TITLE],
        );
      }).pipe(Effect.provide(harness.layer));
    }).pipe(Effect.scoped),
  );
  it.effect("gives a fresh native thread a late summary only through its opening context", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        const gate = yield* Deferred.make<void>();
        const { cwd, layer, prompts } = yield* deliveryHarness("side-chat-opening-late-replaced", {
          failResume: true,
          generateSideChatText: () =>
            Deferred.succeed(entered, undefined).pipe(
              Effect.andThen(Deferred.await(gate)),
              Effect.as({ text: LESSON_SUMMARY }),
            ),
        });
        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
          yield* createLesson({ worktreePath: cwd });
          yield* openOnObservation;
          // The turn start becomes claimable after the opening, so the first claim takes the opening.
          yield* TestClock.adjust("1 millis");
          yield* orchestrator.dispatch(
            sideChatMessageCommand({
              commandId: "command:side-chat:ask",
              threadId: SIDE_CHAT_THREAD_ID,
              text: "What is an observation space?",
            }),
          );
          const opening = yield* worker.runOnce.pipe(Effect.forkChild);
          yield* Deferred.await(entered);
          const turnStart = yield* worker.runOnce.pipe(
            Effect.forkChild({ startImmediately: true }),
          );
          yield* TestClock.adjust(Duration.millis(SIDE_CHAT_WAIT_CAP_MS));
          assert.isTrue(yield* Fiber.join(turnStart));
          yield* Deferred.succeed(gate, undefined);
          yield* Fiber.join(opening);
          yield* worker.drain();
          yield* completeLatestRun(SIDE_CHAT_THREAD_ID);

          // The turn that takes the late summary is interrupted, so later turns carry its handoffs.
          yield* ask(SIDE_CHAT_THREAD_ID, "command:side-chat:ask-box", "Is it always a Box?");
          yield* completeLatestRun(SIDE_CHAT_THREAD_ID, "interrupted");
          // A live session answers resume itself; detaching it makes the next turn really try.
          const { providerSessions } = yield* orchestrator.getThreadProjection(SIDE_CHAT_THREAD_ID);
          assert.lengthOf(providerSessions, 1);
          yield* orchestrator.dispatch({
            type: "provider-session.detach",
            commandId: CommandId.make("command:side-chat:detach"),
            threadId: SIDE_CHAT_THREAD_ID,
            providerSessionId: providerSessions[0]!.id,
          });
          yield* worker.drain();
          yield* ask(SIDE_CHAT_THREAD_ID, "command:side-chat:ask-discrete", "And Discrete?");
          yield* completeLatestRun(SIDE_CHAT_THREAD_ID);
          yield* ask(SIDE_CHAT_THREAD_ID, "command:side-chat:ask-binary", "And MultiBinary?");
        }).pipe(Effect.provide(layer));

        const sideChatPrompts = promptsFor(prompts, SIDE_CHAT_THREAD_ID);
        assert.lengthOf(sideChatPrompts, 4);
        assert.notInclude(sideChatPrompts[0], LESSON_SUMMARY);
        assert.include(sideChatPrompts[1], LESSON_SUMMARY);
        assert.lengthOf(sideChatPrompts[2]!.split(LESSON_SUMMARY), 2);
        assert.notInclude(sideChatPrompts[3], LESSON_SUMMARY);
      }),
    ),
  );
});

describe("side chat cascade", () => {
  it.effect("archiving, unarchiving and deleting a lesson does the same to its side chats", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      const space = ThreadId.make("thread:side-chat:space");
      const box = ThreadId.make("thread:side-chat:box");
      const spaceReplyId = MessageId.make("message:space:a1");
      yield* createLesson();
      yield* seedSideChatThread({
        threadId: space,
        anchorThreadId: LESSON_THREAD_ID,
        sideChat: pendingSideChat({
          anchor: observationAnchor(),
          excerpt: OBSERVATION_EXCERPT,
          requestId: "command:side-chat:open-space",
        }),
      });
      yield* seedThreadMessages(space, [
        { id: spaceReplyId, role: "assistant", text: "A Box space is a bounded array of numbers." },
      ]);
      yield* seedSideChatThread({
        threadId: box,
        anchorThreadId: space,
        sideChat: pendingSideChat({
          anchor: {
            threadId: space,
            messageId: spaceReplyId,
            start: 2,
            end: 5,
            prefix: "A ",
            suffix: " space",
          },
          excerpt: "Box",
          requestId: "command:side-chat:open-box",
          lessonThreadId: LESSON_THREAD_ID,
        }),
      });
      const archivedAt = (threadId: ThreadId) =>
        orchestrator
          .getThreadProjection(threadId)
          .pipe(Effect.map((projection) => projection.thread.archivedAt));

      yield* orchestrator.dispatch({
        type: "thread.archive",
        commandId: CommandId.make("command:side-chat:archive-lesson"),
        threadId: LESSON_THREAD_ID,
      });
      yield* worker.drain();
      assert.isNotNull(yield* archivedAt(space));
      assert.isNotNull(yield* archivedAt(box));
      // box has no side chat below it, so its own archive enqueues no cascade.
      const boxArchiveEffects = (yield* outbox.listByCommandId(
        CommandId.make(
          `command:side-chat:archive-lesson:side-chat-cascade:${space}:side-chat-cascade:${box}`,
        ),
      )).map((effect) => effect.request.type);
      assert.include(boxArchiveEffects, "terminal.cleanup");
      assert.notInclude(boxArchiveEffects, "side-chat.cascade");

      yield* orchestrator.dispatch({
        type: "thread.unarchive",
        commandId: CommandId.make("command:side-chat:unarchive-lesson"),
        threadId: LESSON_THREAD_ID,
      });
      yield* worker.drain();
      assert.isNull(yield* archivedAt(space));
      assert.isNull(yield* archivedAt(box));

      yield* orchestrator.dispatch({
        type: "thread.delete",
        commandId: CommandId.make("command:side-chat:delete-lesson"),
        threadId: LESSON_THREAD_ID,
      });
      yield* worker.drain();
      assert.isNull(yield* orchestrator.getThreadShell(space));
      assert.isNull(yield* orchestrator.getThreadShell(box));
    }).pipe(Effect.provide(openHarness())),
  );

  it.effect("refuses to unarchive a side chat while its lesson is archived", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      yield* createLesson();
      yield* seedSideChatThread({
        threadId: SIDE_CHAT_THREAD_ID,
        anchorThreadId: LESSON_THREAD_ID,
        sideChat: pendingSideChat({
          anchor: observationAnchor(),
          excerpt: OBSERVATION_EXCERPT,
          requestId: OPEN_REQUEST_ID,
        }),
      });
      yield* orchestrator.dispatch({
        type: "thread.archive",
        commandId: CommandId.make("command:side-chat:archive-lesson"),
        threadId: LESSON_THREAD_ID,
      });
      yield* worker.drain();

      const error = yield* orchestrator
        .dispatch({
          type: "thread.unarchive",
          commandId: CommandId.make("command:side-chat:unarchive-side-chat"),
          threadId: SIDE_CHAT_THREAD_ID,
        })
        .pipe(Effect.flip);

      assert.equal(error._tag, "OrchestratorDispatchError");
      assert.isNotNull((yield* readThread(SIDE_CHAT_THREAD_ID)).archivedAt);
    }).pipe(Effect.provide(openHarness())),
  );
});
