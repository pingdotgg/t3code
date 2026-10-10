import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Alchemy from "@/index.ts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import type {
  CallbackRow,
  Column,
  Delivery,
  LegacyRow,
  MigrationProbe,
  SchemaObject,
  SchemaVersion,
  Snapshot,
} from "./types.ts";

export class UpgradeObject extends Cloudflare.DurableObject<UpgradeObject>()(
  "UpgradeObject",
  Effect.gen(function* () {
    const state = yield* Cloudflare.DurableObjectState;
    const storage = state.storage;

    return Effect.gen(function* () {
      const constructors = (yield* storage.get<string[]>("constructors")) ?? [];
      yield* storage.put("constructors", [...constructors, "v2"]);

      const record = Effect.fn(function* (delivery: Delivery) {
        const deliveries = (yield* storage.get<Delivery[]>("deliveries")) ?? [];
        yield* storage.put("deliveries", [...deliveries, delivery]);
      });
      const onArchive = yield* Alchemy.makeCallback(
        "archive",
        Effect.fn(function* (payload: { value: string }) {
          yield* record({
            version: "v2",
            channel: "callback",
            id: payload.value,
            payload,
          });
        }),
      );

      const snapshot = Effect.fn(
        function* (migrate: boolean) {
          if (migrate) yield* Cloudflare.listEvents;
          const schema = yield* (yield* storage.sql.exec<SchemaObject>(
            "SELECT name, type, sql FROM sqlite_master WHERE name LIKE 'alchemy_%' OR name LIKE 'idx_alchemy_%' ORDER BY name",
          )).toArray();
          const tables = schema
            .filter((row) => row.type === "table")
            .map((row) => row.name);
          const schemaRows = tables.includes("alchemy_alarm_schema")
            ? yield* (yield* storage.sql.exec<SchemaVersion>(
                "SELECT id, version FROM alchemy_alarm_schema ORDER BY id",
              )).toArray()
            : [];
          const result: Snapshot = {
            schema,
            schemaRows,
            schemaVersion: schemaRows[0]?.version ?? null,
            version: "v2",
            id: yield* Effect.sync(() => state.id.toString()),
            marker: (yield* storage.get<string>("marker")) ?? null,
            constructors: (yield* storage.get<string[]>("constructors")) ?? [],
            legacyRows: yield* (yield* storage.sql.exec<LegacyRow>(
              "SELECT id, run_at, repeat_ms, payload FROM alchemy_scheduled_events ORDER BY id",
            )).toArray(),
            legacyColumns: yield* (yield* storage.sql.exec<Column>(
              "SELECT name, type, \"notnull\", pk FROM pragma_table_info('alchemy_scheduled_events') ORDER BY cid",
            )).toArray(),
            callbacks: tables.includes("alchemy_alarm_callbacks")
              ? yield* (yield* storage.sql.exec<CallbackRow>(
                  "SELECT callback, id, version, run_at, payload FROM alchemy_alarm_callbacks ORDER BY callback, id",
                )).toArray()
              : [],
            tables,
            alarm: yield* storage.getAlarm(),
            deliveries: (yield* storage.get<Delivery[]>("deliveries")) ?? [],
          };
          return result;
        },
        Effect.provideService(Cloudflare.DurableObjectState, state),
      );

      return {
        // V1 Workers can still reach the upgraded object during edge rollout.
        snapshot: () => snapshot(true),
        reconstruct: () =>
          state.abort("alarm upgrade reconstruction", { retryAlarm: false }),
        probe: Effect.fn(
          function* (kind: "future" | "rollback") {
            if (kind === "future") {
              yield* Cloudflare.listEvents;
              yield* onArchive.schedule("future-preserved", {
                after: "5 minutes",
                payload: { value: "future-preserved" },
              });
              yield* storage.sql.exec(
                "UPDATE alchemy_alarm_schema SET version = 2 WHERE id = 1",
              );
            } else {
              // Fail after the migration has created its first index and callback table.
              yield* storage.sql.exec(
                "DROP INDEX idx_alchemy_scheduled_events_run_at",
              );
              yield* storage.sql.exec(
                "CREATE TABLE idx_alchemy_alarm_callbacks_run_at (value TEXT)",
              );
            }
            const before = yield* snapshot(false);
            const exit = yield* Effect.exit(Cloudflare.listEvents);
            let failure: MigrationProbe["failure"] = null;
            if (Exit.isFailure(exit)) {
              const error = Cause.squash(exit.cause);
              failure =
                error instanceof Cloudflare.UnsupportedAlarmSchemaVersion
                  ? {
                      tag: error._tag,
                      message: Cause.pretty(exit.cause),
                      version: error.version,
                      supportedVersion: error.supportedVersion,
                    }
                  : {
                      tag: error instanceof Error ? error.name : "Defect",
                      message: Cause.pretty(exit.cause),
                      version: null,
                      supportedVersion: null,
                    };
            }
            const after = yield* snapshot(false);
            let retryBefore: Snapshot | null = null;
            let recovered: Snapshot | null = null;
            if (kind === "rollback") {
              yield* storage.sql.exec(
                "DROP TABLE idx_alchemy_alarm_callbacks_run_at",
              );
              yield* storage.sql.exec(`
              CREATE TABLE alchemy_alarm_schema (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                version INTEGER NOT NULL
              );
              INSERT INTO alchemy_alarm_schema (id, version) VALUES (1, 0);
            `);
              retryBefore = yield* snapshot(false);
              recovered = yield* snapshot(true);
            }
            const result: MigrationProbe = {
              before,
              after,
              failure,
              retryBefore,
              recovered,
            };
            return result;
          },
          Effect.provideService(Cloudflare.DurableObjectState, state),
        ),
        alarm: Effect.fn(function* () {
          const events = yield* Cloudflare.processScheduledEvents.pipe(
            Effect.provideService(Cloudflare.DurableObjectState, state),
          );
          for (const event of events) {
            yield* record({
              version: "v2",
              channel: "legacy",
              id: event.id,
              payload: event.payload,
            });
          }
        }),
        execute: Effect.fn(
          function* (action: string) {
            if (action === "callback-first") {
              yield* onArchive.schedule("pending", {
                after: "1 minute",
                payload: { value: "canceled-callback" },
              });
            } else if (action === "cancel-legacy") {
              yield* Cloudflare.cancelEvent("legacy-cancel");
            } else if (action === "cancel-callback") {
              yield* onArchive.cancel("pending");
            } else if (action === "release") {
              // Keep the migrated payloads and intervals; only bring their due times forward.
              const at = yield* Effect.sync(() => new Date(Date.now() + 1_000));
              yield* storage.sql.exec(
                "UPDATE alchemy_scheduled_events SET run_at = ?",
                at.getTime(),
              );
              yield* onArchive.schedule("delivered", {
                at,
                payload: { value: "new-callback" },
              });
            } else if (action === "only-callback") {
              yield* onArchive.schedule("survivor", {
                after: "2 seconds",
                payload: { value: "callback-survivor" },
              });
              for (const event of yield* Cloudflare.listEvents) {
                yield* Cloudflare.cancelEvent(event.id);
              }
            } else if (action === "only-legacy") {
              const at = yield* Effect.sync(() => new Date(Date.now() + 2_000));
              yield* Cloudflare.scheduleEvent("legacy-survivor", at, {
                value: "legacy-survivor",
              });
              yield* onArchive.schedule("canceled", {
                after: "1 second",
                payload: { value: "must-not-fire" },
              });
              yield* onArchive.cancel("canceled");
            } else if (action !== "snapshot") {
              return yield* Effect.die(new Error(`Unknown action: ${action}`));
            }
            return yield* snapshot(true);
          },
          Effect.provideService(Cloudflare.DurableObjectState, state),
        ),
      };
    });
  }),
) {}

export default class AlarmUpgradeWorker extends Cloudflare.Worker<AlarmUpgradeWorker>()(
  "AlarmUpgradeWorker",
  { main: import.meta.url },
  Effect.gen(function* () {
    const objects = yield* UpgradeObject;
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const expectedVersion = request.headers["x-alarm-worker-version"];
        if (expectedVersion !== undefined && expectedVersion !== "v2") {
          return HttpServerResponse.text("Alarm worker version mismatch", {
            status: 409,
            headers: { "x-alarm-worker-version": "v2" },
          });
        }
        const url = new URL(request.url, "http://localhost");
        const action = url.pathname.slice(1);
        const object = objects.getByName(
          url.searchParams.get("name") ?? "persisted-object",
        );
        if (request.method !== "POST" && action !== "snapshot") {
          return HttpServerResponse.text("Method Not Allowed", { status: 405 });
        }
        if (action === "reconstruct") {
          const aborted = yield* object.reconstruct().pipe(
            Effect.catchCause((cause) => {
              // The method declares no application errors, but aborting the
              // object rejects its RPC transport with RpcCallError.
              const error = Cause.squash(cause);
              if (
                error instanceof Cloudflare.RpcCallError &&
                error.cause instanceof Error &&
                error.cause.message.includes("alarm upgrade reconstruction")
              )
                return Effect.succeed(true);
              return Effect.failCause(cause);
            }),
          );
          return yield* HttpServerResponse.json({ aborted });
        }
        if (action === "migration-future" || action === "migration-rollback") {
          const probe = yield* object
            .probe(action === "migration-future" ? "future" : "rollback")
            .pipe(Effect.orDie);
          return yield* HttpServerResponse.json(probe);
        }
        const snapshot = yield* object.execute(action).pipe(Effect.orDie);
        return yield* HttpServerResponse.json(snapshot);
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.succeed(
            HttpServerResponse.text(Cause.pretty(cause), { status: 500 }),
          ),
        ),
      ),
    };
  }),
) {}
