import * as AWS from "@alchemy.run/aws";
import * as SQL from "@alchemy.run/sql/Postgres";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Network } from "./Network.ts";

export class SqlError extends Data.TaggedError("SqlError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class Database extends Context.Service<
  Database,
  {
    query<Row extends Record<string, unknown> = Record<string, unknown>>(
      statement: string,
      values?: ReadonlyArray<unknown>,
    ): Effect.Effect<ReadonlyArray<Row>, SqlError, RuntimeContext>;
  }
>()("Sql") {}

export const DatabaseAurora = Layer.effect(
  Database,
  Effect.gen(function* () {
    const { vpc, databaseSecurityGroup } = yield* Network;
    const database = yield* AWS.RDS.Aurora("Database", {
      subnetIds: vpc.privateSubnetIds,
      securityGroupIds: [databaseSecurityGroup.groupId],
    });

    const connect = yield* AWS.RDS.Connect(database.cluster, {
      secret: database.secret,
      subnetIds: vpc.privateSubnetIds,
      securityGroupIds: [databaseSecurityGroup.groupId],
    });

    // `Connect` resolves credentials per invocation; the pool opens on the
    // first query and closes when the invocation settles.
    const sql = yield* SQL.Postgres({
      url: connect.pipe(Effect.map((connection) => connection.url)),
    });

    return Database.of({
      query: <Row extends Record<string, unknown>>(
        statement: string,
        values: ReadonlyArray<unknown> = [],
      ) =>
        sql.unsafe<Row>(statement, values).pipe(
          Effect.mapError(
            (cause) =>
              new SqlError({
                message: `Failed to execute SQL statement: ${statement}`,
                cause,
              }),
          ),
        ),
    });
  }),
);
