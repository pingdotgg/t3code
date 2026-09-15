import { it, assert } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderInstanceId, RuntimeTaskId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { makeSqlitePersistenceLive } from "../../persistence/Layers/Sqlite.ts";
import { recordCodexChildUsage } from "./codexChildUsage.ts";

it.layer(NodeServices.layer)("Codex child usage", (it) => {
  it.effect("deduplicates replay after reopening the database and isolates child identities", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "codex-child-usage-" });
      const database = makeSqlitePersistenceLive(`${directory}/state.sqlite`).pipe(
        Layer.provide(NodeServices.layer),
      );
      const input = {
        threadId: ThreadId.make("parent"),
        instanceId: ProviderInstanceId.make("codex"),
        taskId: RuntimeTaskId.make("child"),
        childTurnId: "turn-1",
        toolItemId: "tool-1",
      };
      // Each call closes its SQLite connection, so no process-local state can carry the count.
      const record = (patch: Partial<Parameters<typeof recordCodexChildUsage>[1]> = {}) =>
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          return yield* recordCodexChildUsage(sql, { ...input, ...patch });
        }).pipe(Effect.provide(database));

      assert.deepEqual(
        yield* record({ usage: { totalTokens: 100, inputTokens: 80, outputTokens: 20 } }),
        {
          totalTokens: 100,
          inputTokens: 80,
          outputTokens: 20,
          toolUses: 1,
        },
      );
      assert.deepEqual(yield* record(), {
        totalTokens: 100,
        inputTokens: 80,
        outputTokens: 20,
        toolUses: 1,
      });
      assert.deepEqual(yield* record({ childTurnId: "turn-2", usage: { totalTokens: 50 } }), {
        totalTokens: 100,
        inputTokens: 80,
        outputTokens: 20,
        toolUses: 2,
      });
      for (const patch of [
        { taskId: RuntimeTaskId.make("other-child") },
        { threadId: ThreadId.make("other-parent") },
        { instanceId: ProviderInstanceId.make("other-instance") },
      ]) {
        assert.deepEqual(yield* record(patch), { totalTokens: 0, toolUses: 1 });
      }
    }),
  );
});
