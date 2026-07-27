import * as Keyspaces from "@/AWS/Keyspaces";
import * as Lambda from "@/AWS/Lambda";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "restore-handler.ts");

export class KeyspacesRestoreTestFunction extends Lambda.Function<Lambda.Function>()(
  "KeyspacesRestoreTestFunction",
) {}

export default KeyspacesRestoreTestFunction.make(
  {
    main,
    url: true,
    timeout: Duration.seconds(60),
  },
  Effect.gen(function* () {
    const keyspace = yield* Keyspaces.Keyspace("RestoreKs", {
      keyspaceName: "alchemy_restore_test_ks",
    });
    const table = yield* Keyspaces.Table("Orders", {
      keyspaceName: keyspace.keyspaceName,
      tableName: "orders",
      columns: [
        { name: "id", type: "uuid" },
        { name: "total", type: "int" },
      ],
      partitionKeys: ["id"],
      pointInTimeRecovery: true,
    });

    const restore = yield* Keyspaces.RestoreTable(table, keyspace);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const pathname = new URL(request.originalUrl).pathname;

        // Restore the source table's continuous backup (current time) into a
        // new table of the same keyspace. RestoreTable is asynchronous — the
        // response carries the new table's ARN while it is RESTORING; the
        // test deletes it out-of-band.
        if (request.method === "POST" && pathname === "/restore") {
          const result = yield* restore({
            targetTableName: "orders_restored",
          }).pipe(
            Effect.map((response) => ({
              restoredTableARN: response.restoredTableARN,
            })),
            Effect.catch((error) =>
              Effect.succeed({ error: error._tag } as const),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        return yield* HttpServerResponse.json(
          { error: "Not found", method: request.method, pathname },
          { status: 404 },
        );
      }).pipe(Effect.orDie),
    };
  }).pipe(Effect.provide(Keyspaces.RestoreTableHttp)),
);
