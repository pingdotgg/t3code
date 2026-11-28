import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import {
  type CommandId,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ThreadImportService from "./ThreadImportService.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

// A thread handed off from another environment arrives with its conversation as run-less
// imported history, which the orchestrator hands to the first run here. The run itself is
// the orchestrator's; this covers what the import writes and that a retry writes nothing.

const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" };
const source = {
  environmentId: EnvironmentId.make("environment:laptop"),
  threadId: ThreadId.make("thread:on-the-laptop"),
  handoffId: "handoff-1",
};
const history = [
  {
    role: "user" as const,
    text: "Find why the login test flakes.",
    createdAt: "2026-10-06T10:00:00.000Z",
  },
  {
    role: "assistant" as const,
    text: "The session cookie races the redirect.",
    createdAt: "2026-10-06T10:01:00.000Z",
  },
];
const request = {
  source,
  projectId: ProjectId.make("project:box"),
  title: "Flaky login test",
  modelSelection,
  runtimeMode: "full-access" as const,
  interactionMode: "default" as const,
  linkOrigin: { sessionId: "session-laptop", label: "T3 Code · Laptop" },
  messages: history,
  continuationPrompt: "Carry on from where you stopped on the laptop.",
};

const stores = Layer.mergeAll(EventStore.layer, ProjectionStore.layer).pipe(
  Layer.provideMerge(SqlitePersistence.layerMemory),
);

const layerFor = (dispatched: Ref.Ref<ReadonlyArray<CommandId>>) =>
  ThreadImportService.layer.pipe(
    Layer.provide(
      Layer.unwrap(
        Effect.gen(function* () {
          const projections = yield* ProjectionStore.ProjectionStoreV2;
          return Layer.mock(ThreadManagement.ThreadManagementService)({
            getThreadShell: (threadId) => projections.getThreadShell(threadId).pipe(Effect.orDie),
            dispatch: (command) =>
              Ref.update(dispatched, (seen) => [...seen, command.commandId]).pipe(
                Effect.as({} as never),
              ),
            getThreadRecords: () =>
              Effect.succeed({ runs: [{ id: RunId.make("run:continued") }] } as never),
          });
        }),
      ),
    ),
    Layer.provide(EventSink.layer),
    Layer.provideMerge(stores),
    Layer.provide(NodeCrypto.layer),
  );

it.effect("an import writes the conversation as imported history, once", () =>
  Effect.gen(function* () {
    const dispatched = yield* Ref.make<ReadonlyArray<CommandId>>([]);
    yield* Effect.gen(function* () {
      const imports = yield* ThreadImportService.ThreadImportService;
      const projections = yield* ProjectionStore.ProjectionStoreV2;

      const first = yield* imports.importThread(request);
      assert.isTrue(first.created);
      assert.equal(first.runId, RunId.make("run:continued"));
      const projection = yield* projections.getThreadProjection(first.threadId);
      assert.equal(projection.thread.historyOrigin, "v1_import");
      assert.deepEqual(projection.thread.linkOrigin, request.linkOrigin);
      assert.deepEqual(
        projection.messages.map((message) => [message.role, message.text, message.runId]),
        history.map((message) => [message.role, message.text, null]),
      );

      // A retry returns the same thread, writes nothing, and replays the same command.
      const retried = yield* imports.importThread(request);
      assert.deepEqual(retried, { ...first, created: false });
      const after = yield* projections.getThreadProjection(first.threadId);
      assert.equal(after.messages.length, history.length);
      const commands = yield* Ref.get(dispatched);
      assert.equal(commands.length, 2);
      assert.equal(commands[0], commands[1]);

      // Landing in another project is refused, not silently moved.
      const moved = yield* imports
        .importThread({ ...request, projectId: ProjectId.make("project:other") })
        .pipe(Effect.flip);
      assert.equal(moved._tag, "ThreadImportProjectMismatchError");

      // Another handoff of the same source thread is a new thread; without a prompt, no run.
      const again = yield* imports.importThread({
        ...request,
        source: { ...source, handoffId: "handoff-2" },
        continuationPrompt: undefined,
      });
      assert.notEqual(again.threadId, first.threadId);
      assert.isNull(again.runId);
      assert.equal((yield* Ref.get(dispatched)).length, 2);
    }).pipe(Effect.provide(layerFor(dispatched)));
  }),
);
