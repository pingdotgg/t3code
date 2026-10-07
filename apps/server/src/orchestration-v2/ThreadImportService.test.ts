import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ThreadImportService from "./ThreadImportService.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import { type CapturedTurn, makeCapturingCodexAdapter } from "./testkit/CapturingCodexAdapter.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";

// A thread moved here from another environment arrives with its conversation.
// Its first run here gets that history as a context handoff, so the agent
// picks up where it left off, and a retried import changes nothing.

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
    text: "EARLIER_FINDING: the session cookie races the redirect.",
    createdAt: "2026-10-06T10:01:00.000Z",
  },
];
const continuation = "Carry on from where you stopped on the laptop.";

const layerFor = (workspace: string, captured: Ref.Ref<ReadonlyArray<CapturedTurn>>) => {
  const layerDatabase = SqlitePersistence.layerMemory;
  const layerStores = Layer.mergeAll(
    layerDatabase,
    EventStore.layer.pipe(Layer.provideMerge(layerDatabase)),
    ProjectionStore.layer.pipe(Layer.provideMerge(layerDatabase)),
  );
  const layerOrchestrator = ProviderReplayHarness.layerWithRegistry(
    {
      name: "thread-import",
      runtimePolicyOverride: {
        cwd: workspace,
        approvalPolicy: "never",
        sandboxPolicy: { type: "readOnly", access: { type: "fullAccess" }, networkAccess: false },
      },
    },
    ProviderAdapterRegistry.layerSingle(
      makeCapturingCodexAdapter(captured, { response: "Picked it up.", modelSelection }),
    ),
    { databaseLayer: layerDatabase },
  );
  const layerThreads = ThreadManagement.layer.pipe(Layer.provideMerge(layerOrchestrator));
  return ThreadImportService.layer.pipe(
    Layer.provideMerge(layerThreads),
    Layer.provideMerge(EventSink.layer.pipe(Layer.provide(layerStores))),
    Layer.provideMerge(layerStores),
    Layer.provide(NodeCrypto.layer),
  );
};

const waitForIdle = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    for (let attempt = 0; attempt < 1_000; attempt += 1) {
      const projection: OrchestrationV2ThreadProjection =
        yield* orchestrator.getThreadProjection(threadId);
      if (
        projection.runs.length > 0 &&
        projection.runs.every(
          (run) => !["queued", "starting", "running", "waiting"].includes(run.status),
        )
      ) {
        return projection;
      }
      yield* Effect.sleep("5 millis");
    }
    return yield* Effect.die(new Error("The imported thread never went idle."));
  });

it.live(
  "an imported thread's first run continues with its history, and re-importing is a no-op",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const workspace = yield* checkpointWorkspace("thread-import");
        const captured = yield* Ref.make<ReadonlyArray<CapturedTurn>>([]);
        yield* Effect.gen(function* () {
          const imports = yield* ThreadImportService.ThreadImportService;
          const request = {
            source,
            projectId: ProjectId.make("project:box"),
            title: "Flaky login test",
            modelSelection,
            runtimeMode: "full-access" as const,
            interactionMode: "default" as const,
            linkOrigin: { sessionId: "session-laptop", label: "T3 Code · Laptop" },
            messages: history,
            continuationPrompt: continuation,
          };
          const first = yield* imports.importThread(request);
          assert.isTrue(first.created);
          const projection = yield* waitForIdle(first.threadId);

          // The history is there, before the first run, and marked as imported.
          assert.equal(projection.thread.historyOrigin, "v1_import");
          assert.deepEqual(projection.thread.linkOrigin, request.linkOrigin);
          const runless = projection.messages.filter((message) => message.runId === null);
          assert.deepEqual(
            runless.map((message) => [message.role, message.text]),
            history.map((message) => [message.role, message.text]),
          );
          // The first run got the history as context, then the continuation.
          assert.equal(projection.contextHandoffs.length, 1);
          const turns = yield* Ref.get(captured);
          assert.equal(turns.length, 1);
          assert.include(turns[0]!.text, "Context handoff (manual_context):");
          assert.include(turns[0]!.text, "EARLIER_FINDING");
          assert.include(turns[0]!.text, `User message:\n${continuation}`);

          // Retrying the same import creates nothing and runs nothing new.
          const retried = yield* imports.importThread(request);
          assert.deepEqual(retried, { ...first, created: false });
          const after = yield* Orchestrator.OrchestratorV2.pipe(
            Effect.flatMap((orchestrator) => orchestrator.getThreadProjection(first.threadId)),
          );
          assert.equal(after.messages.length, projection.messages.length);
          assert.equal(after.runs.length, 1);
          assert.equal((yield* Ref.get(captured)).length, 1);

          // A different handoff of the same source thread is a new thread.
          const again = yield* imports.importThread({
            ...request,
            source: { ...source, handoffId: "handoff-2" },
            continuationPrompt: undefined,
          });
          assert.notEqual(again.threadId, first.threadId);
          assert.isNull(again.runId);
        }).pipe(Effect.provide(layerFor(workspace, captured)));
      }),
    ),
);
