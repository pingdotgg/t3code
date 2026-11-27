import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2Command,
  type OrchestrationV2ImportedHistory,
} from "@t3tools/contracts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Effect from "effect/Effect";

import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const driver = ProviderDriverKind.make("codex");
const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "test-model" };
const adapter: ProviderAdapter.ProviderAdapterV2["Service"] = {
  instanceId,
  driver,
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
  openSession: () => Effect.die("Execution is paused after dispatch for handoff inspection"),
};
const layer = ProviderReplayHarness.layerWithRegistry(
  { name: "imported-history" },
  ProviderAdapterRegistry.layerFromAdapters([adapter]),
  { runEffectWorker: false },
);

const laptop = EnvironmentId.make("laptop");
const laptopThreadId = ThreadId.make("laptop-thread");

const importedHistory: OrchestrationV2ImportedHistory = {
  messages: [
    {
      role: "user",
      text: "Remember the code word PELICAN.",
      createdAt: "2026-11-01T10:00:00.000Z",
    },
    { role: "assistant", text: "Noted: PELICAN.", createdAt: "2026-11-01T10:00:05.000Z" },
  ],
  omittedCount: 3,
  source: { environmentId: laptop, threadId: laptopThreadId, title: "Code word", label: "Laptop" },
};

type ThreadCreateCommand = Extract<OrchestrationV2Command, { readonly type: "thread.create" }>;

function plainCreateCommand(threadId: ThreadId): ThreadCreateCommand {
  return {
    type: "thread.create",
    commandId: CommandId.make(`${threadId}:create`),
    threadId,
    projectId: ProjectId.make("imported-history-project"),
    title: "Code word",
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdBy: "system",
    creationSource: "server",
  };
}

function createCommand(
  threadId: ThreadId,
  extra: Partial<ThreadCreateCommand> = {},
): ThreadCreateCommand {
  return { ...plainCreateCommand(threadId), importedHistory, ...extra };
}

it.effect("a thread created with imported history holds its messages in order", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const threadId = ThreadId.make("imported-history-thread");
    yield* orchestrator.dispatch(createCommand(threadId));

    const projection = yield* orchestrator.getThreadProjection(threadId);
    assert.equal(projection.thread.historyOrigin, "v1_import");
    assert.deepEqual(
      projection.messages.map((message) => ({ role: message.role, text: message.text })),
      [
        { role: "user", text: "Remember the code word PELICAN." },
        { role: "assistant", text: "Noted: PELICAN." },
      ],
    );
    assert.deepEqual(
      projection.turnItems.map((item) => [item.type, item.runId]),
      [
        ["system_notice", null],
        ["user_message", null],
        ["assistant_message", null],
      ],
    );
    const notice = projection.turnItems[0];
    assert.include(notice?.type === "system_notice" ? notice.message : "", "3 earlier messages");
  }).pipe(Effect.provide(layer)),
);

it.effect("the first turn on an imported thread hands the history to the provider", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const threadId = ThreadId.make("imported-history-first-turn");
    yield* orchestrator.dispatch(createCommand(threadId));
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("imported-history-first-turn:send"),
      threadId,
      messageId: MessageId.make("imported-history-first-turn:send"),
      text: "What was the code word?",
      attachments: [],
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "web",
    });

    const projection = yield* orchestrator.getThreadProjection(threadId);
    const handoff = projection.contextHandoffs[0];
    assert.lengthOf(projection.contextHandoffs, 1);
    assert.equal(handoff?.strategy, "manual_context");
    assert.equal(handoff?.targetRunId, projection.runs.at(-1)?.id);
    assert.deepEqual(
      handoff?.history?.messages.map((message) => [message.role, message.text]),
      [
        ["user", "Remember the code word PELICAN."],
        ["assistant", "Noted: PELICAN."],
      ],
    );
  }).pipe(Effect.provide(layer)),
);

it.effect("rejects imported history sent with an imported native thread", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const threadId = ThreadId.make("imported-history-conflict");
    const error = yield* orchestrator
      .dispatch(
        createCommand(threadId, {
          importedNativeThread: {
            ref: { driver, nativeId: "native-session", strength: "strong" },
          },
        }),
      )
      .pipe(Effect.flip);

    assert.include(String(error.cause), "Imported history cannot come with a native thread");
    const missing = yield* orchestrator.getThreadProjection(threadId).pipe(Effect.flip);
    assert.isDefined(missing);
  }).pipe(Effect.provide(layer)),
);

const createAndReadContinuedFrom = Effect.fn("createAndReadContinuedFrom")(function* (
  command: ThreadCreateCommand,
) {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  yield* orchestrator.dispatch(command);
  const projection = yield* orchestrator.getThreadProjection(command.threadId);
  const shell = yield* orchestrator.getThreadShell(command.threadId);
  return {
    thread: projection.thread.continuedFrom ?? null,
    shell: shell?.continuedFrom ?? null,
  };
});

it.effect("a thread created with imported history shows where it continued from", () =>
  Effect.gen(function* () {
    const continuedFrom = {
      environmentId: laptop,
      threadId: laptopThreadId,
      title: "Code word",
      label: "Laptop",
    };

    const read = yield* createAndReadContinuedFrom(
      createCommand(ThreadId.make("imported-history-continued-from")),
    );

    assert.deepEqual(read, { thread: continuedFrom, shell: continuedFrom });
  }).pipe(Effect.provide(layer)),
);

it.effect("an older sender with no label shows its environment id as the label", () =>
  Effect.gen(function* () {
    const continuedFrom = {
      environmentId: laptop,
      threadId: laptopThreadId,
      title: "Code word",
      label: "laptop",
    };

    const read = yield* createAndReadContinuedFrom(
      createCommand(ThreadId.make("imported-history-no-label"), {
        importedHistory: {
          ...importedHistory,
          source: { environmentId: laptop, threadId: laptopThreadId, title: "Code word" },
        },
      }),
    );

    assert.deepEqual(read, { thread: continuedFrom, shell: continuedFrom });
  }).pipe(Effect.provide(layer)),
);

it.effect("a thread created without imported history continued from nowhere", () =>
  Effect.gen(function* () {
    const read = yield* createAndReadContinuedFrom(
      plainCreateCommand(ThreadId.make("plain-thread")),
    );

    assert.deepEqual(read, { thread: null, shell: null });
  }).pipe(Effect.provide(layer)),
);
