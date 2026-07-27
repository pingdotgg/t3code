import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Drizzle from "@/Drizzle/index.ts";
import { eq } from "drizzle-orm";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Hyperdrive } from "./db.ts";
import { relations, Widgets } from "./schema.ts";

/**
 * Regression guard for the ExecutionContext-in-Workflow fix
 * (https://github.com/alchemy-run/alchemy/pull/515).
 *
 * `Drizzle.Postgres` resolves its pool through `ExecutionContext`, which
 * `WorkflowBridge.run` now provides per run and `task` threads into each
 * step. Without the fix the query inside a `task` dies on the missing
 * service and the run goes `errored`.
 *
 * Two steps — an upsert then a read-back — also prove the per-run pool is
 * reused across steps rather than rebuilt.
 */
export default class DrizzleWorkflow extends Cloudflare.Workflow<DrizzleWorkflow>()(
  "DrizzleWorkflow",
  Effect.gen(function* () {
    // `proxyChain` defers the connect to the first query, so the pool opens
    // inside a step — where `ExecutionContext` is provided — not here at init.
    const conn = yield* Cloudflare.Hyperdrive.Connect(Hyperdrive);
    const db = yield* Drizzle.Postgres(conn.connectionString, { relations });

    return Effect.fn(function* (input: { id: number; name: string }) {
      const inserted = yield* Cloudflare.Workflows.task(
        "insert-widget",
        Effect.gen(function* () {
          const [row] = yield* db
            .insert(Widgets)
            .values({ id: input.id, name: input.name })
            .onConflictDoUpdate({
              target: Widgets.id,
              set: { name: input.name },
            })
            .returning();
          return row;
        }).pipe(Effect.orDie),
      );

      yield* Cloudflare.Workflows.sleep("settle", "1 second");

      const rows = yield* Cloudflare.Workflows.task(
        "select-widget",
        Effect.gen(function* () {
          return yield* db
            .select()
            .from(Widgets)
            .where(eq(Widgets.id, input.id));
        }).pipe(Effect.orDie),
      );

      // Step results are JSON-serialized by Cloudflare — return plain rows.
      return { inserted, rowCount: rows.length, widget: rows[0] ?? null };
    });
  }).pipe(Effect.provide(Layer.mergeAll(Cloudflare.Hyperdrive.ConnectBinding))),
) {}
