import * as AWS from "alchemy/AWS";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Client } from "pg";
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
    ): Effect.Effect<ReadonlyArray<Row>, SqlError>;
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

    const connect = yield* AWS.RDS.Connect.bind(database.cluster, {
      secret: database.secret,
      subnetIds: vpc.privateSubnetIds,
      securityGroupIds: [databaseSecurityGroup.groupId],
    });

    return Database.of({
      query: <Row extends Record<string, unknown>>(
        statement: string,
        values: ReadonlyArray<unknown> = [],
      ): Effect.Effect<ReadonlyArray<Row>, SqlError> =>
        connect.pipe(
          Effect.catch((cause) =>
            Effect.fail(
              new SqlError({
                message: "Failed to resolve Aurora connection settings",
                cause,
              }),
            ),
          ),
          Effect.flatMap((connection: AWS.RDS.ConnectionInfo) =>
            Effect.tryPromise({
              try: async () => {
                const client = new Client({
                  host: connection.host,
                  port: connection.port,
                  database: connection.database,
                  user: connection.username,
                  password: connection.password,
                  // Example-only SSL posture for private Aurora connections.
                  ssl: connection.ssl
                    ? { rejectUnauthorized: false }
                    : undefined,
                });

                await client.connect();
                try {
                  const result = await client.query<Row>({
                    text: statement,
                    values: [...values],
                  });
                  return result.rows as ReadonlyArray<Row>;
                } finally {
                  await client.end();
                }
              },
              catch: (cause) =>
                new SqlError({
                  message: `Failed to execute SQL statement: ${statement}`,
                  cause,
                }),
            }),
          ),
        ),
    });
  }),
);
