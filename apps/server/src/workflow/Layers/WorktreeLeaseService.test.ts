import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { MigrationsLive } from "../../persistence/Migrations.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { WorktreeLeaseService } from "../Services/WorktreeLeaseService.ts";
import { WorktreeLeaseServiceLive } from "./WorktreeLeaseService.ts";

const layer = it.layer(
  WorktreeLeaseServiceLive.pipe(
    Layer.provideMerge(MigrationsLive),
    Layer.provideMerge(SqlitePersistenceMemory),
  ),
);

layer("WorktreeLeaseService", (it) => {
  it.effect("acquire returns a monotonically increasing fence token", () =>
    Effect.gen(function* () {
      const lease = yield* WorktreeLeaseService;
      const a = yield* lease.acquire("wt-1", "step", "sr-1");
      yield* lease.release("wt-1", a.fenceToken);
      const b = yield* lease.acquire("wt-1", "step", "sr-2");

      assert.isAbove(b.fenceToken, a.fenceToken);
    }),
  );

  it.effect("validate rejects a stale token", () =>
    Effect.gen(function* () {
      const lease = yield* WorktreeLeaseService;
      const a = yield* lease.acquire("wt-2", "step", "sr-1");
      yield* lease.release("wt-2", a.fenceToken);
      yield* lease.acquire("wt-2", "step", "sr-2");
      const valid = yield* lease.isValid("wt-2", a.fenceToken);

      assert.equal(valid, false);
    }),
  );
});
