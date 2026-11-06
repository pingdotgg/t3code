import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentId } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as OpenShellFleetStore from "./OpenShellFleetStore.ts";
import * as Sqlite from "../persistence/Sqlite.ts";

const workerRow = {
  environmentId: EnvironmentId.make("environment-worker-1"),
  state: "ready" as const,
  workerClass: "ephemeral" as const,
  label: "Worker One",
  sandboxName: "t3-worker-7f3a",
  sandboxId: "sandbox-1",
  expiresAt: 1_800_000_000_000,
};

const drain = {
  drainId: "drain:environment-worker-1:1",
  threads: { total: 2, acked: 1, failed: 0 },
  worktrees: { total: 1, acked: 0, failed: 0 },
  startedAt: 1_700_000_000_000,
  finishedAt: null,
};

const storeLayer = <E>(database: Layer.Layer<SqlClient.SqlClient, E, never>) =>
  OpenShellFleetStore.layer.pipe(Layer.provideMerge(database));

describe("OpenShellFleetStore", () => {
  it.effect("keeps one row per environment across state and drain updates", () =>
    Effect.gen(function* () {
      const store = yield* OpenShellFleetStore.OpenShellFleetStore;
      const created = yield* store.upsert(workerRow);
      assert.equal(created.state, "ready");
      assert.isNull(created.drain);
      assert.equal(created.expiresAt, workerRow.expiresAt);
      assert.isTrue(DateTime.isDateTime(created.updatedAt));

      const draining = yield* store.setState(workerRow.environmentId, "draining");
      assert.equal(Option.getOrThrow(draining).state, "draining");

      const withDrain = yield* store.setDrain(workerRow.environmentId, drain);
      assert.deepEqual(Option.getOrThrow(withDrain).drain, drain);

      // The drain clears once every item acked and the deletion settled.
      const deleted = yield* store.setState(workerRow.environmentId, "deleting");
      assert.equal(Option.getOrThrow(deleted).state, "deleting");
      const cleared = yield* store.setDrain(workerRow.environmentId, null);
      assert.isNull(Option.getOrThrow(cleared).drain);

      assert.equal((yield* store.list).length, 1);
      assert.isTrue(yield* store.remove(workerRow.environmentId));
      assert.isTrue(Option.isNone(yield* store.get(workerRow.environmentId)));
      assert.isFalse(yield* store.remove(workerRow.environmentId));
    }).pipe(Effect.provide(storeLayer(Sqlite.layerMemory))),
  );

  it.effect("a failed drain keeps its last error with the row", () =>
    Effect.gen(function* () {
      const store = yield* OpenShellFleetStore.OpenShellFleetStore;
      yield* store.upsert(workerRow);
      const failed = yield* store.setState(
        workerRow.environmentId,
        "failed",
        "drain_timeout: 1 worktree unacked",
      );
      assert.equal(Option.getOrThrow(failed).lastError, "drain_timeout: 1 worktree unacked");
      // Nothing lost outranks cleanup: a failed row is never interrupted-by-restart.
      assert.deepEqual(yield* store.interrupted, []);
    }).pipe(Effect.provide(storeLayer(Sqlite.layerMemory))),
  );

  it.effect("reports rows a restart interrupted, and only those", () =>
    Effect.gen(function* () {
      const store = yield* OpenShellFleetStore.OpenShellFleetStore;
      yield* store.upsert(workerRow);
      yield* store.upsert({
        ...workerRow,
        environmentId: EnvironmentId.make("environment-worker-2"),
        state: "draining" as const,
        label: "Worker Two",
      });
      const interrupted = yield* store.interrupted;
      assert.deepEqual(
        interrupted.map((row) => row.environmentId),
        [EnvironmentId.make("environment-worker-2")],
      );
      assert.equal(interrupted[0]?.state, "draining");
    }).pipe(Effect.provide(storeLayer(Sqlite.layerMemory))),
  );

  it.effect("state survives a restart of the managing instance", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectory({ prefix: "t3-fleet-store-" });
      const dbPath = path.join(dir, "statev2.sqlite");
      const database = Sqlite.layerFromPath(dbPath).pipe(
        Layer.provide(NodeServices.layer),
        Layer.fresh,
      );

      // One instance writes and exits.
      yield* Effect.gen(function* () {
        const store = yield* OpenShellFleetStore.OpenShellFleetStore;
        yield* store.upsert(workerRow);
        yield* store.setState(workerRow.environmentId, "draining");
        yield* store.setDrain(workerRow.environmentId, drain);
      }).pipe(Effect.provide(storeLayer(database)));

      // The next instance reads the rows back at startup.
      yield* Effect.gen(function* () {
        const store = yield* OpenShellFleetStore.OpenShellFleetStore;
        const recovered = Option.getOrThrow(yield* store.get(workerRow.environmentId));
        assert.equal(recovered.state, "draining");
        assert.deepEqual(recovered.drain, drain);
        assert.deepEqual(
          (yield* store.interrupted).map((row) => row.environmentId),
          [workerRow.environmentId],
        );
      }).pipe(Effect.provide(storeLayer(database)));

      yield* fs.remove(dir, { recursive: true });
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
