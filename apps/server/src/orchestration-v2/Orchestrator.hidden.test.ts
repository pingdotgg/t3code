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
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.1-codex" };
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process needed for thread state controls"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const layerDatabase = SqlitePersistence.layerMemory;
const layerTest = Layer.mergeAll(
  layerDatabase,
  ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "hidden-threads" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  ),
);

const createThread = (threadId: ThreadId, hidden?: boolean) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    return yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`create:${threadId}`),
      threadId,
      projectId: ProjectId.make("project:hidden"),
      title: "Hidden thread",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      ...(hidden === undefined ? {} : { hidden }),
      createdBy: "user",
      creationSource: "web",
    });
  });

it.effect("hides and unhides a thread, trading places with its pin", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const threadId = ThreadId.make("thread:hide-toggle");
    yield* createThread(threadId);
    yield* orchestrator.dispatch({
      type: "thread.pin",
      commandId: CommandId.make("pin-before-hide"),
      threadId,
    });

    yield* orchestrator.dispatch({
      type: "thread.hidden.set",
      commandId: CommandId.make("hide"),
      threadId,
      hidden: true,
    });
    const hidden = yield* projections.getThreadShell(threadId);
    assert.ok(hidden);
    assert.ok(hidden.hiddenAt != null);
    assert.equal(hidden.pinnedAt, null);

    yield* orchestrator.dispatch({
      type: "thread.pin",
      commandId: CommandId.make("pin-hidden"),
      threadId,
    });
    const pinned = yield* projections.getThreadShell(threadId);
    assert.ok(pinned);
    assert.equal(pinned.hiddenAt, null);
    assert.ok(pinned.pinnedAt != null);

    yield* orchestrator.dispatch({
      type: "thread.hidden.set",
      commandId: CommandId.make("hide-again"),
      threadId,
      hidden: true,
    });
    yield* orchestrator.dispatch({
      type: "thread.hidden.set",
      commandId: CommandId.make("unhide"),
      threadId,
      hidden: false,
    });
    const visible = yield* projections.getThreadProjection(threadId);
    assert.equal(visible.thread.hiddenAt, null);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("creates a thread hidden when asked", () =>
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const threadId = ThreadId.make("thread:created-hidden");
    yield* createThread(threadId, true);
    const shell = yield* projections.getThreadShell(threadId);
    assert.ok(shell);
    assert.ok(shell.hiddenAt != null);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("rejects hiding an archived thread", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const threadId = ThreadId.make("thread:archived-hide");
    yield* createThread(threadId);
    yield* orchestrator.dispatch({
      type: "thread.archive",
      commandId: CommandId.make("archive"),
      threadId,
    });
    const result = yield* Effect.exit(
      orchestrator.dispatch({
        type: "thread.hidden.set",
        commandId: CommandId.make("hide-archived"),
        threadId,
        hidden: true,
      }),
    );
    assert.equal(result._tag, "Failure");
  }).pipe(Effect.provide(layerTest)),
);
