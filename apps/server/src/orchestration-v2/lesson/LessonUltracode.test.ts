import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "../Adapters/CodexAdapterV2.ts";
import * as Orchestrator from "../Orchestrator.ts";
import * as ProjectionStore from "../ProjectionStore.ts";
import * as ProviderAdapterRegistry from "../ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "../testkit/ProviderReplayHarness.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

const instanceId = ProviderInstanceId.make("claudeAgent");
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("claudeAgent"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process needed"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const layerDatabase = SqlitePersistence.layerMemory;
const layerTest = Layer.mergeAll(
  layerDatabase,
  ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "lesson-ultracode" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  ),
);

const ultracode = {
  instanceId,
  model: "claude-opus-5-5",
  options: [
    { id: "effort", value: "ultracode" },
    { id: "fastMode", value: false },
  ],
};
const capped = [
  { id: "effort", value: "xhigh" },
  { id: "fastMode", value: false },
  { id: "ultracode", value: false },
];

it.layer(layerTest)("lesson Ultracode cap", (it) => {
  it.effect("lessons never run at Ultracode, at creation or on a later send", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const threadId = ThreadId.make("thread:lesson-ultracode");
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("create:lesson-ultracode"),
        threadId,
        projectId: ProjectId.make("project:lesson-ultracode"),
        title: "Lesson",
        lesson: { topic: "CW2", depth: "deep", purpose: "outcome" },
        modelSelection: ultracode,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });
      assert.deepEqual((yield* projections.getThread(threadId)).modelSelection.options, capped);

      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("send:lesson-ultracode"),
        threadId,
        messageId: MessageId.make("message:lesson-ultracode"),
        text: "teach me",
        attachments: [],
        modelSelection: ultracode,
        dispatchMode: { type: "start_immediately" },
        createdBy: "user",
        creationSource: "web",
      });
      const { runs } = yield* projections.getThreadProjection(threadId);
      assert.deepEqual(runs.at(-1)?.modelSelection.options, capped);
    }),
  );
});
