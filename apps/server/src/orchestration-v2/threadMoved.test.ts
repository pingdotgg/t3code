import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ScheduledTaskId,
  ThreadId,
  type OrchestrationV2Command,
  type OrchestrationV2ThreadMovedTo,
} from "@t3tools/contracts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const driver = ProviderDriverKind.make("codex");
const instanceId = ProviderInstanceId.make("codex");
const adapter: ProviderAdapter.ProviderAdapterV2["Service"] = {
  instanceId,
  driver,
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
  openSession: () => Effect.die("Execution is paused after dispatch"),
};
const layer = ProviderReplayHarness.layerWithRegistry(
  { name: "thread-moved" },
  ProviderAdapterRegistry.layerFromAdapters([adapter]),
  { runEffectWorker: false },
);

const movedTo: OrchestrationV2ThreadMovedTo = {
  environmentId: EnvironmentId.make("desktop"),
  threadId: ThreadId.make("desktop-thread"),
  title: "Fix the login bug",
  label: "Desktop",
  movedAt: DateTime.makeUnsafe("2026-11-27T10:00:00.000Z"),
};

type ThreadCreateCommand = Extract<OrchestrationV2Command, { readonly type: "thread.create" }>;

function createCommand(threadId: ThreadId) {
  const command: ThreadCreateCommand = {
    type: "thread.create",
    commandId: CommandId.make(`${threadId}:create`),
    threadId,
    projectId: ProjectId.make("thread-moved-project"),
    title: "Fix the login bug",
    modelSelection: { instanceId, model: "test-model" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdBy: "user",
    creationSource: "web",
  };
  return command;
}

function sendCommand(
  threadId: ThreadId,
  name: string,
  extra: Partial<Extract<OrchestrationV2Command, { readonly type: "message.dispatch" }>> = {},
): OrchestrationV2Command {
  return {
    type: "message.dispatch",
    commandId: CommandId.make(`${threadId}:${name}`),
    threadId,
    messageId: MessageId.make(`${threadId}:${name}`),
    text: "Keep going here.",
    attachments: [],
    dispatchMode: { type: "start_immediately" },
    createdBy: "user",
    creationSource: "web",
    ...extra,
  };
}

const createMovedThread = Effect.fn("test.createMovedThread")(function* (threadId: ThreadId) {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  yield* orchestrator.dispatch(createCommand(threadId));
  yield* orchestrator.dispatch({
    type: "thread.moved.set",
    commandId: CommandId.make(`${threadId}:moved`),
    threadId,
    movedTo,
  });
  return orchestrator;
});

const readMovedTo = Effect.fn("test.readMovedTo")(function* (threadId: ThreadId) {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projection = yield* orchestrator.getThreadProjection(threadId);
  const shell = yield* orchestrator.getThreadShell(threadId);
  return { thread: projection.thread.movedTo ?? null, shell: shell?.movedTo ?? null };
});

it.effect("a moved thread shows where it moved on the thread and its shell", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("thread-moved-set");
    yield* createMovedThread(threadId);

    const read = yield* readMovedTo(threadId);
    assert.deepEqual(read, { thread: movedTo, shell: movedTo });
  }).pipe(Effect.provide(layer)),
);

it.effect("clearing the marker removes it, and clearing again is accepted", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("thread-moved-clear");
    const orchestrator = yield* createMovedThread(threadId);

    yield* orchestrator.dispatch({
      type: "thread.moved.clear",
      commandId: CommandId.make(`${threadId}:clear`),
      threadId,
    });
    assert.deepEqual(yield* readMovedTo(threadId), { thread: null, shell: null });

    yield* orchestrator.dispatch({
      type: "thread.moved.clear",
      commandId: CommandId.make(`${threadId}:clear-again`),
      threadId,
    });
    assert.deepEqual(yield* readMovedTo(threadId), { thread: null, shell: null });
  }).pipe(Effect.provide(layer)),
);

it.effect("a message the user sends on a moved thread clears the marker", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("thread-moved-user-message");
    const orchestrator = yield* createMovedThread(threadId);

    yield* orchestrator.dispatch(sendCommand(threadId, "send"));

    assert.deepEqual(yield* readMovedTo(threadId), { thread: null, shell: null });
  }).pipe(Effect.provide(layer)),
);

it.effect("a scheduled task run on a moved thread keeps the marker", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("thread-moved-scheduled");
    const orchestrator = yield* createMovedThread(threadId);

    yield* orchestrator.dispatch(
      sendCommand(threadId, "scheduled", {
        scheduledTaskId: ScheduledTaskId.make("nightly-check"),
        createdBy: "system",
        creationSource: "server",
      }),
    );

    assert.deepEqual(yield* readMovedTo(threadId), { thread: movedTo, shell: movedTo });
  }).pipe(Effect.provide(layer)),
);

it("a client's thread.create cannot carry imported history or an imported native thread", () => {
  const command: ThreadCreateCommand = {
    ...createCommand(ThreadId.make("thread-moved-forged")),
    importedHistory: {
      messages: [{ role: "user", text: "Forged", createdAt: "2026-11-01T10:00:00.000Z" }],
      omittedCount: 0,
      source: {
        environmentId: EnvironmentId.make("elsewhere"),
        threadId: ThreadId.make("elsewhere-thread"),
        title: "Forged",
      },
    },
    importedNativeThread: {
      ref: { driver, nativeId: "native-session", strength: "strong" },
    },
  };

  const stamped = ThreadManagementService.withCreationProvenance(command, {
    createdBy: "user",
    creationSource: "web",
  });

  assert.notProperty(stamped, "importedHistory");
  assert.notProperty(stamped, "importedNativeThread");
});
