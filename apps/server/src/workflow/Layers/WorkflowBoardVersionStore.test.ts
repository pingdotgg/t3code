import { BoardId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { MigrationsLive } from "../../persistence/Migrations.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { WorkflowBoardVersionStore } from "../Services/WorkflowBoardVersionStore.ts";
import { WorkflowBoardVersionStoreLive } from "./WorkflowBoardVersionStore.ts";

const storeLayer = it.layer(
  WorkflowBoardVersionStoreLive.pipe(
    Layer.provideMerge(MigrationsLive),
    Layer.provideMerge(SqlitePersistenceMemory),
  ),
);

storeLayer("WorkflowBoardVersionStore", (it) => {
  it.effect("dedups only consecutive hashes and keeps A-B-A versions distinct", () =>
    Effect.gen(function* () {
      const store = yield* WorkflowBoardVersionStore;
      const boardId = BoardId.make("board-history");
      const otherBoardId = BoardId.make("board-history-other");

      yield* store.record({
        boardId,
        versionHash: "hash-a",
        contentJson: '{"name":"A"}\n',
        source: "create",
      });
      yield* store.record({
        boardId,
        versionHash: "hash-a",
        contentJson: '{"name":"A"}\n',
        source: "save",
      });
      yield* store.record({
        boardId,
        versionHash: "hash-b",
        contentJson: '{"name":"B"}\n',
        source: "save",
      });
      yield* store.record({
        boardId: otherBoardId,
        versionHash: "hash-other",
        contentJson: '{"name":"other"}\n',
        source: "create",
      });
      yield* store.record({
        boardId,
        versionHash: "hash-a",
        contentJson: '{"name":"A"}\n',
        source: "revert",
      });

      const versions = yield* store.list(boardId);
      assert.equal(versions.length, 3);
      assert.deepEqual(
        versions.map((version) => version.versionHash),
        ["hash-a", "hash-b", "hash-a"],
      );
      assert.deepEqual(
        versions.map((version) => version.source),
        ["revert", "save", "create"],
      );
      assert.deepEqual(new Set(versions.map((version) => version.versionId)).size, versions.length);
      assert.isTrue(versions.every((version) => version.createdAt.length > 0));

      const newest = versions[0];
      assert.isDefined(newest);
      const loaded = yield* store.get(boardId, newest.versionId);
      assert.deepEqual(loaded, {
        versionId: newest.versionId,
        versionHash: "hash-a",
        contentJson: '{"name":"A"}\n',
        source: "revert",
        createdAt: newest.createdAt,
      });

      const wrongBoard = yield* store.get(otherBoardId, newest.versionId);
      assert.isNull(wrongBoard);

      yield* store.deleteForBoard(boardId);
      assert.deepEqual(yield* store.list(boardId), []);
      assert.equal((yield* store.list(otherBoardId)).length, 1);
    }),
  );
});
