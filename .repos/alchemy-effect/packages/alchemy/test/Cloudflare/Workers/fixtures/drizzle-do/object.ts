import * as Cloudflare from "@/Cloudflare";
import * as Drizzle from "@/Drizzle/Cloudflare.ts";
import type { RuntimeContext } from "@/RuntimeContext.ts";
import * as Cause from "effect/Cause";
import { sql } from "drizzle-orm";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Scheduler from "effect/Scheduler";
// The exact artifacts `drizzle-kit generate` emits for
// `driver: "durable-sqlite"` — a `migrations.js` that imports each
// migration's `.sql` file as a text module. Bare `.sql` imports resolve
// via the bundler's default text module types (see Bundle.ts), the same
// way Wrangler's `Text` rules handle them.
import migrations from "./drizzle/migrations.js";
import { posts, relations, users } from "./schema.ts";

class TransactionMarker extends Context.Service<TransactionMarker, string>()(
  "DrizzleTransactionMarker",
) {}

export class DrizzleClockObject extends Cloudflare.DurableObject<DrizzleClockObject>()(
  "DrizzleClockObject",
  Effect.succeed(Effect.succeed({ wait: () => Effect.sleep("100 millis") })),
) {}

export class DrizzleUsersObject extends Cloudflare.DurableObject<DrizzleUsersObject>()(
  "DrizzleUsersObject",
  Effect.gen(function* () {
    const clocks = yield* DrizzleClockObject;
    return Effect.gen(function* () {
      const state = yield* Cloudflare.DurableObjectState;
      // Opens drizzle over this instance's SQLite storage — with the
      // relational schema — and applies the generated migrations before
      // any request touches the db.
      const db = yield* Drizzle.DurableObject({ migrations, relations });

      return {
        clockName: () => Effect.sync(() => state.id.toString()),
        sqliteClock: () =>
          clocks.getByName(state.id.toString()).wait().pipe(Effect.as("ready")),
        sqliteGate: (view: boolean) =>
          Effect.gen(function* () {
            const context = yield* Effect.context<RuntimeContext>();
            const clock = clocks.getByName(state.id.toString());
            // Native timers must be registered in the real enclosing input gate.
            return yield* Effect.promise(() =>
              state.raw.blockConcurrencyWhile(() => {
                let outerRan = false;
                let finished = false;
                let finishedBeforeClear: boolean | undefined;
                let release: Promise<void> | undefined;
                const outer = setTimeout(() => {
                  outerRan = true;
                }, 0);
                return Effect.runPromise(
                  Effect.gen(function* () {
                    const original = db.$client;
                    const client = view
                      ? original.withoutTransforms()
                      : original;
                    const callerScheduler = yield* Scheduler.Scheduler;
                    const enteredAfterOuter = yield* client.withTransaction(
                      Effect.gen(function* () {
                        const enteredAfterOuter = outerRan;
                        // The independent DO completion can clear a blocked parent timer.
                        yield* Effect.sync(() => {
                          release = Effect.runPromise(
                            clock.wait().pipe(Effect.provideContext(context)),
                          ).then(() => {
                            finishedBeforeClear = finished;
                            clearTimeout(outer);
                          });
                        });
                        yield* client`SELECT 1`;
                        yield* Effect.yieldNow;
                        return enteredAfterOuter;
                      }),
                    );
                    const restoredScheduler = yield* Scheduler.Scheduler;
                    return {
                      enteredAfterOuter,
                      sameTransaction:
                        client.withTransaction === original.withTransaction,
                      samePermit: client.reserve === original.reserve,
                      sameTransactionContext:
                        client.transactionService ===
                        original.transactionService,
                      restoredScheduler: restoredScheduler === callerScheduler,
                    };
                  }).pipe(Effect.provideContext(context)),
                )
                  .then((value) => {
                    finished = true;
                    return release?.then(() => ({
                      ...value,
                      finishedBeforeClear,
                    }));
                  })
                  .finally(() => clearTimeout(outer));
              }),
            );
          }),
        sqliteRollback: () =>
          Effect.gen(function* () {
            const client = db.$client;
            const view = client.withoutTransforms();
            const finalized: string[] = [];
            const callerScope = yield* Effect.scope;
            const scopedBody = (value: string) =>
              Effect.gen(function* () {
                const marker = yield* TransactionMarker;
                const scope = yield* Effect.scope;
                yield* Effect.addFinalizer(() =>
                  Effect.sync(() => {
                    finalized.push(
                      `${marker}:${value}:${scope !== callerScope}`,
                    );
                  }),
                );
                yield* db.insert(users).values({ name: value });
              });
            const failed = yield* client
              .withTransaction(
                scopedBody("failed").pipe(
                  Effect.andThen(Effect.fail("rollback")),
                  Effect.scoped,
                ),
              )
              .pipe(Effect.exit);
            const defect = yield* client
              .withTransaction(
                scopedBody("defect").pipe(
                  Effect.andThen(Effect.die("rollback defect")),
                  Effect.scoped,
                ),
              )
              .pipe(Effect.exit);
            const started = yield* Deferred.make<void>();
            const release = yield* Deferred.make<void>();
            const writer = yield* Effect.forkChild(
              client.withTransaction(
                scopedBody("interrupted").pipe(
                  Effect.andThen(Deferred.succeed(started, undefined)),
                  Effect.andThen(Deferred.await(release)),
                  Effect.scoped,
                ),
              ),
            );
            yield* Deferred.await(started);
            const reader = yield* Effect.forkChild(
              view`SELECT name FROM users`,
              { startImmediately: true },
            );
            const waitingForPermit = yield* Effect.sync(
              () => reader.pollUnsafe() === undefined,
            );
            yield* Fiber.interrupt(writer);
            const interrupted = yield* Fiber.await(writer);
            const rowsAfterRollback = yield* Fiber.join(reader);
            yield* view.withTransaction(
              scopedBody("committed").pipe(Effect.scoped),
            );
            const finalRows = yield* view`SELECT name FROM users`;
            return {
              failed:
                Exit.isFailure(failed) &&
                failed.cause.reasons.some(
                  (reason) =>
                    Cause.isFailReason(reason) && reason.error === "rollback",
                ),
              defect:
                Exit.isFailure(defect) &&
                defect.cause.reasons.some(
                  (reason) =>
                    Cause.isDieReason(reason) &&
                    reason.defect === "rollback defect",
                ),
              interrupted:
                Exit.isFailure(interrupted) &&
                Cause.hasInterruptsOnly(interrupted.cause),
              waitingForPermit,
              rowsAfterRollback,
              finalRows,
              finalized,
              callerScopePreserved:
                (yield* Effect.scope) === callerScope &&
                callerScope.state._tag !== "Closed",
            };
          }).pipe(Effect.provideService(TransactionMarker, "caller")),
        addUser: (name: string) =>
          db
            .insert(users)
            .values({ name })
            .returning()
            .pipe(Effect.map((rows) => rows[0]!.id)),
        addPost: (userId: number, title: string) =>
          db.insert(posts).values({ userId, title }).pipe(Effect.asVoid),
        listUsers: () =>
          db
            .select()
            .from(users)
            .pipe(Effect.map((rows) => rows.map((row) => row.name))),
        // Relational query through the `relations` config — proves the
        // schema/relationships flow through Drizzle.DurableObject's types.
        listUsersWithPosts: () =>
          db.query.users.findMany({ with: { posts: true } }).pipe(
            Effect.map((rows) =>
              rows.map((row) => ({
                name: row.name,
                posts: row.posts.map((post) => post.title),
              })),
            ),
          ),
        // A deliberately failing query, recovered with a typed catch —
        // proves per-operation errors are tagged and catchable.
        queryMissingTable: () =>
          Effect.gen(function* () {
            return yield* db.run(sql`SELECT * FROM missing_table`).pipe(
              Effect.as("unexpected success"),
              Effect.catchTag("EffectDrizzleQueryError", (error) =>
                Effect.succeed(`caught:${error._tag}`),
              ),
            );
          }),
      };
    });
  }),
) {}
