import { assert, describe, it, vi } from "@effect/vitest";
import {
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  TextGenerationError,
  ThreadId,
  type OrchestrationV2AppThread,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2Run,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as PromptSuggestionService from "./PromptSuggestionService.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";

const projectId = ProjectId.make("project:prompt-suggestion");
const threadId = ThreadId.make("thread:prompt-suggestion");
const run1Id = RunId.make("run:1");
const run2Id = RunId.make("run:2");
const now = DateTime.makeUnsafe("2026-11-26T00:00:00.000Z");

const baseThread = {
  id: threadId,
  projectId,
  title: "Test thread",
  titleSource: "auto",
  titleRegeneration: null,
  modelSelection: {
    instanceId: ProviderInstanceId.make("grok"),
    model: "grok-4",
  },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  managedWorkspace: null,
  lineage: {
    parentThreadId: null,
    rootThreadId: threadId,
    relationshipToParent: null,
  },
  forkedFrom: null,
  historyOrigin: "native",
  createdAt: now,
  updatedAt: now,
  deletedAt: null,
  archivedAt: null,
  snoozedUntil: null,
  pinnedAt: null,
  sidebarOrder: null,
  tags: [],
} as unknown as OrchestrationV2AppThread;

function makeRun(
  overrides: Partial<OrchestrationV2Run> & {
    readonly id: RunId;
    readonly ordinal: number;
    readonly status: OrchestrationV2Run["status"];
  },
): OrchestrationV2Run {
  return {
    threadId,
    providerInstanceId: ProviderInstanceId.make("grok"),
    modelSelection: baseThread.modelSelection,
    interactionMode: "default",
    activeAttemptId: null,
    promptMessageId: null,
    createdAt: now,
    startedAt: now,
    completedAt: overrides.status === "completed" ? now : null,
    ...overrides,
  } as unknown as OrchestrationV2Run;
}

function makeMessage(
  overrides: Partial<OrchestrationV2ConversationMessage> & {
    readonly id: MessageId;
    readonly role: "user" | "assistant";
    readonly text: string;
    readonly runId: RunId | null;
  },
): OrchestrationV2ConversationMessage {
  return {
    threadId,
    streaming: false,
    attachments: [],
    createdBy: overrides.role === "user" ? "user" : "agent",
    creationSource: overrides.role === "user" ? "web" : "provider",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  } as unknown as OrchestrationV2ConversationMessage;
}

interface HarnessOptions {
  readonly promptSuggestionsEnabled?: boolean;
  readonly thread?: OrchestrationV2AppThread;
  readonly runsSequence?: ReadonlyArray<ReadonlyArray<OrchestrationV2Run>>;
  readonly messages?: ReadonlyArray<OrchestrationV2ConversationMessage>;
  readonly generatePromptSuggestion?: TextGeneration.TextGeneration["Service"]["generatePromptSuggestion"];
  readonly worktreeExists?: boolean;
}

function makeHarness(options: HarnessOptions = {}) {
  const thread = options.thread ?? baseThread;
  const runsSequence = options.runsSequence ?? [
    [makeRun({ id: run1Id, ordinal: 1, status: "completed" })],
  ];
  const messages = options.messages ?? [
    makeMessage({
      id: MessageId.make("msg:1"),
      role: "user",
      text: "Add prompt suggestions",
      runId: run1Id,
    }),
    makeMessage({
      id: MessageId.make("msg:2"),
      role: "assistant",
      text: "Done! Added PromptSuggestionService.",
      runId: run1Id,
    }),
  ];
  let getThreadRecordsCalls = 0;

  const generatePromptSuggestion = vi.fn(
    options.generatePromptSuggestion ??
      (() => Effect.succeed({ suggestion: "Run the test suite" })),
  );
  const recorded: Array<{
    readonly threadId: ThreadId;
    readonly runId: RunId;
    readonly text: string;
    readonly overwrite?: boolean;
  }> = [];

  const layer = PromptSuggestionService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        ServerSettings.layerTest({
          promptSuggestionsEnabled: options.promptSuggestionsEnabled ?? true,
        }),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getThreadRecords: () => {
            const index = Math.min(getThreadRecordsCalls, runsSequence.length - 1);
            getThreadRecordsCalls += 1;
            return Effect.succeed({
              thread,
              runs: runsSequence[index]!,
              messages,
            }) as never;
          },
        }),
        Layer.mock(ProjectStore.ProjectStoreV2)({
          get: (requestedProjectId) =>
            Effect.succeed(
              requestedProjectId === projectId
                ? Option.some({
                    projectId,
                    title: "T3 Code",
                    workspaceRoot: "/workspace/t3code",
                    defaultModelSelection: baseThread.modelSelection,
                    defaultThreadEnvMode: null,
                    hasCustomTitle: false,
                    autoPull: false,
                    faviconPath: null,
                    projectIcon: null,
                    scripts: [],
                    trackedFolders: [],
                    pinnedAt: null,
                    archivedAt: null,
                    createdAt: "2026-11-26T00:00:00.000Z",
                    updatedAt: "2026-11-26T00:00:00.000Z",
                    deletedAt: null,
                  })
                : Option.none(),
            ),
        }),
        Layer.mock(TextGeneration.TextGeneration)({
          generatePromptSuggestion,
        }),
        Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
          subscribePromptSuggestion: () => Stream.empty,
          setPromptSuggestion: (input) =>
            Effect.sync(() => {
              recorded.push(input);
            }),
        }),
        FileSystem.layerNoop({
          exists: () => Effect.succeed(options.worktreeExists ?? false),
        }),
      ),
    ),
  );

  return { layer, generatePromptSuggestion, recorded };
}

describe("PromptSuggestionService", () => {
  it.effect("generates and records a suggestion for non-native drivers", () =>
    Effect.gen(function* () {
      const harness = makeHarness({
        runsSequence: [
          [
            makeRun({ id: RunId.make("run:rolled-back"), ordinal: 1, status: "rolled_back" }),
            makeRun({ id: run1Id, ordinal: 2, status: "completed" }),
          ],
        ],
        messages: [
          makeMessage({
            id: MessageId.make("msg:old"),
            role: "user",
            text: "Rolled back prompt",
            runId: RunId.make("run:rolled-back"),
          }),
          makeMessage({
            id: MessageId.make("msg:1"),
            role: "user",
            text: "Implement feature X",
            runId: run1Id,
          }),
          makeMessage({
            id: MessageId.make("msg:2"),
            role: "assistant",
            text: "Implemented feature X.",
            runId: run1Id,
          }),
        ],
      });

      yield* Effect.gen(function* () {
        const service = yield* PromptSuggestionService.PromptSuggestionService;
        yield* service.generateForRun({
          threadId,
          runId: run1Id,
          driver: ProviderDriverKind.make("grok"),
        });
      }).pipe(Effect.provide(harness.layer));

      assert.equal(harness.generatePromptSuggestion.mock.calls.length, 1);
      const call = harness.generatePromptSuggestion.mock.calls[0]![0];
      assert.equal(call.cwd, "/workspace/t3code");
      assert.equal(call.projectId, projectId);
      assert.isFalse(call.transcript.includes("Rolled back prompt"));
      assert.isTrue(call.transcript.includes("Implement feature X"));
      assert.isTrue(call.transcript.includes("Implemented feature X."));

      assert.deepStrictEqual(harness.recorded, [
        {
          threadId,
          runId: run1Id,
          text: "Run the test suite",
          overwrite: false,
        },
      ]);
    }),
  );

  it.effect("skips native prompt suggestion drivers (claudeAgent and codex)", () =>
    Effect.gen(function* () {
      const harness = makeHarness();

      yield* Effect.gen(function* () {
        const service = yield* PromptSuggestionService.PromptSuggestionService;
        yield* service.generateForRun({
          threadId,
          runId: run1Id,
          driver: ProviderDriverKind.make("claudeAgent"),
        });
        yield* service.generateForRun({
          threadId,
          runId: run1Id,
          driver: ProviderDriverKind.make("codex"),
        });
      }).pipe(Effect.provide(harness.layer));

      assert.equal(harness.generatePromptSuggestion.mock.calls.length, 0);
      assert.equal(harness.recorded.length, 0);
    }),
  );

  it.effect("skips when promptSuggestionsEnabled is false", () =>
    Effect.gen(function* () {
      const harness = makeHarness({ promptSuggestionsEnabled: false });

      yield* Effect.gen(function* () {
        const service = yield* PromptSuggestionService.PromptSuggestionService;
        yield* service.generateForRun({
          threadId,
          runId: run1Id,
          driver: ProviderDriverKind.make("cursor"),
        });
      }).pipe(Effect.provide(harness.layer));

      assert.equal(harness.generatePromptSuggestion.mock.calls.length, 0);
      assert.equal(harness.recorded.length, 0);
    }),
  );

  it.effect("skips delegated threads", () =>
    Effect.gen(function* () {
      const harness = makeHarness({
        thread: {
          ...baseThread,
          lineage: {
            parentThreadId: ThreadId.make("thread:parent"),
            rootThreadId: ThreadId.make("thread:parent"),
            relationshipToParent: "subagent",
          },
        },
      });

      yield* Effect.gen(function* () {
        const service = yield* PromptSuggestionService.PromptSuggestionService;
        yield* service.generateForRun({
          threadId,
          runId: run1Id,
          driver: ProviderDriverKind.make("grok"),
        });
      }).pipe(Effect.provide(harness.layer));

      assert.equal(harness.generatePromptSuggestion.mock.calls.length, 0);
      assert.equal(harness.recorded.length, 0);
    }),
  );

  it.effect("drops stale suggestions if a newer run started before generation finished", () =>
    Effect.gen(function* () {
      const harness = makeHarness({
        runsSequence: [
          [makeRun({ id: run1Id, ordinal: 1, status: "completed" })],
          [
            makeRun({ id: run1Id, ordinal: 1, status: "completed" }),
            makeRun({ id: run2Id, ordinal: 2, status: "running" }),
          ],
        ],
      });

      yield* Effect.gen(function* () {
        const service = yield* PromptSuggestionService.PromptSuggestionService;
        yield* service.generateForRun({
          threadId,
          runId: run1Id,
          driver: ProviderDriverKind.make("grok"),
        });
      }).pipe(Effect.provide(harness.layer));

      assert.equal(harness.generatePromptSuggestion.mock.calls.length, 1);
      assert.equal(harness.recorded.length, 0);
    }),
  );

  it.effect("degrades silently when text generation fails", () =>
    Effect.gen(function* () {
      const harness = makeHarness({
        generatePromptSuggestion: () =>
          Effect.fail(
            new TextGenerationError({
              operation: "generatePromptSuggestion",
              detail: "model unavailable",
            }),
          ),
      });

      yield* Effect.gen(function* () {
        const service = yield* PromptSuggestionService.PromptSuggestionService;
        yield* service.generateForRun({
          threadId,
          runId: run1Id,
          driver: ProviderDriverKind.make("grok"),
        });
      }).pipe(Effect.provide(harness.layer));

      assert.equal(harness.generatePromptSuggestion.mock.calls.length, 1);
      assert.equal(harness.recorded.length, 0);
    }),
  );
});
