import { assert, it } from "@effect/vitest";
import { EventId, PluginId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as PluginThreadStatuses from "./PluginThreadStatuses.ts";
import { makePluginActivation } from "./PluginApi.ts";

const layer = PluginThreadStatuses.layer.pipe(
  Layer.provideMerge(ProjectionStore.layer),
  Layer.provide(SqlitePersistence.layerMemory),
);
const threadId = ThreadId.make("thread:plugin-status");
const pluginId = PluginId.make("machine-label");
const otherId = PluginId.make("other-label");

const createThread = Effect.gen(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const now = DateTime.makeUnsafe("2026-11-10T12:00:00Z");
  const providerInstanceId = ProviderInstanceId.make("replay");
  yield* projections.apply({
    id: EventId.make("event:plugin-status:thread-created"),
    type: "thread.created",
    threadId,
    occurredAt: now,
    payload: {
      id: threadId,
      projectId: ProjectId.make("project:plugin-status"),
      title: "Plugin status",
      providerInstanceId,
      modelSelection: { instanceId: providerInstanceId, model: "replay" },
      runtimeMode: "full-access",
      interactionMode: "default",
      createdBy: "user",
      creationSource: "web",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: null,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    },
  });
});

it.layer(layer)("PluginThreadStatuses", (it) => {
  it.effect("replaces and clears keyed statuses without changing another plugin's entries", () =>
    Effect.gen(function* () {
      yield* createThread;
      const statuses = yield* PluginThreadStatuses.PluginThreadStatuses;
      const { controller: deactivated } = makePluginActivation();
      const owner = { pluginId, pluginName: "Machine label", deactivated: deactivated.signal };
      const pull = yield* Stream.toPull(statuses.subscribe(threadId));
      assert.deepStrictEqual(yield* pull, [{ plugins: [] }]);
      yield* statuses.set(owner, { threadId, key: "host", text: "Laptop" });
      assert.deepStrictEqual(yield* pull, [
        {
          plugins: [
            { pluginId, pluginName: "Machine label", statuses: [{ key: "host", text: "Laptop" }] },
          ],
        },
      ]);
      yield* statuses.set(owner, { threadId, key: "host", text: "Desktop" });
      yield* statuses.set(
        { ...owner, pluginId: otherId, pluginName: "Other" },
        { threadId, key: "host", text: "Other machine" },
      );
      yield* statuses.clear(owner, { threadId, key: "host" });
      const remaining = yield* pull;
      assert.deepStrictEqual(remaining, [
        {
          plugins: [
            {
              pluginId: otherId,
              pluginName: "Other",
              statuses: [{ key: "host", text: "Other machine" }],
            },
          ],
        },
      ]);
      yield* statuses.clearPlugin(otherId);
      assert.deepStrictEqual(yield* pull, [{ plugins: [] }]);
      deactivated.abort();
      const late = yield* statuses
        .set(owner, { threadId, key: "host", text: "Late" })
        .pipe(Effect.flip);
      assert.strictEqual(late._tag, "PluginThreadStatusError");
    }).pipe(Effect.scoped),
  );

  it.effect("refuses a status whose thread lookup finishes after deactivation", () =>
    Effect.gen(function* () {
      yield* createThread;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const reached = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const { controller: deactivated } = makePluginActivation();
      yield* Effect.gen(function* () {
        const statuses = yield* PluginThreadStatuses.PluginThreadStatuses;
        const setting = yield* statuses
          .set(
            { pluginId, pluginName: "Machine label", deactivated: deactivated.signal },
            { threadId, key: "host", text: "Late" },
          )
          .pipe(Effect.flip, Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(reached);
        deactivated.abort();
        yield* statuses.clearPlugin(pluginId);
        yield* Deferred.succeed(release, undefined);
        assert.strictEqual((yield* Fiber.join(setting))._tag, "PluginThreadStatusError");
        const pull = yield* Stream.toPull(statuses.subscribe(threadId));
        assert.deepStrictEqual(yield* pull, [{ plugins: [] }]);
      }).pipe(
        Effect.provide(
          Layer.fresh(PluginThreadStatuses.layer).pipe(
            Layer.provide(
              Layer.succeed(ProjectionStore.ProjectionStoreV2, {
                ...projections,
                getThread: (id) =>
                  Effect.gen(function* () {
                    yield* Deferred.succeed(reached, undefined);
                    yield* Deferred.await(release);
                    return yield* projections.getThread(id);
                  }),
              }),
            ),
          ),
        ),
      );
    }).pipe(Effect.scoped),
  );

  it.effect("rejects unknown threads, invalid text and too many statuses", () =>
    Effect.gen(function* () {
      yield* createThread;
      const statuses = yield* PluginThreadStatuses.PluginThreadStatuses;
      const owner = {
        pluginId,
        pluginName: "Machine label",
        deactivated: makePluginActivation().controller.signal,
      };
      for (const input of [
        { threadId: "missing", key: "host", text: "Laptop" },
        { threadId, key: "", text: "Laptop" },
        { threadId, key: "host", text: "\n\t" },
        { threadId, key: "host", text: "x".repeat(201) },
        { threadId, key: "host", text: "first\u2028second" },
      ]) {
        assert.strictEqual(
          (yield* statuses.set(owner, input).pipe(Effect.flip))._tag,
          "PluginThreadStatusError",
        );
      }
      for (let index = 0; index < 8; index++) {
        yield* statuses.set(owner, { threadId, key: `key${index}`, text: "Status" });
      }
      assert.strictEqual(
        (yield* statuses
          .set(owner, { threadId, key: "overflow", text: "Too many" })
          .pipe(Effect.flip))._tag,
        "PluginThreadStatusError",
      );
      yield* statuses.clearPlugin(pluginId);
    }),
  );
});
