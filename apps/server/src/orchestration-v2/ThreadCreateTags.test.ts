import { assert, it } from "@effect/vitest";
import {
  CommandId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const instanceId = ProviderInstanceId.make("codex");
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process needed to create a thread"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const layerDatabase = SqlitePersistence.layerMemory;
const layerTest = Layer.mergeAll(
  layerDatabase,
  ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
  EffectOutbox.layer.pipe(Layer.provide(layerDatabase)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "thread-create-tags" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  ),
);

const create = (id: string, tags?: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const threadId = ThreadId.make(`thread:${id}`);
    const result = yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`create-${id}`),
      threadId,
      projectId: ProjectId.make("project:thread-create-tags"),
      title: "Foldered",
      modelSelection: { instanceId, model: "gpt-5.1-codex" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
      ...(tags === undefined ? {} : { tags }),
    });
    const shell = yield* (yield* ProjectionStore.ProjectionStoreV2).getThreadShell(threadId);
    return { types: result.storedEvents.map((stored) => stored.event.type), tags: shell?.tags };
  });

it.layer(layerTest)("thread.create with tags", (it) => {
  it.effect("creates the thread already in its folders, in the one created event", () =>
    Effect.gen(function* () {
      const created = yield* create("tagged", ["work", "later", "work"]);
      assert.deepEqual(created.types, ["thread.created"]);
      assert.deepEqual(created.tags, ["work", "later"]);
    }),
  );

  it.effect.each([
    ["absent", undefined],
    ["empty", []],
  ] as const)("creates an untagged thread when tags are %s", ([id, tags]) =>
    Effect.gen(function* () {
      const created = yield* create(id, tags);
      assert.deepEqual(created.types, ["thread.created"]);
      assert.deepEqual(created.tags ?? [], []);
    }),
  );
});
