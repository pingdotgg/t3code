import * as Presign from "@distilled.cloud/aws/Presign";
import * as PgClient from "@effect/sql-pg/PgClient";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

export const BootstrapDatabase = Alchemy.Action(
  "BootstrapDatabase",
  Effect.fn(function* (input: { endpoint: string; roleArn: string; version: string }) {
    const token = yield* Presign.presignUrl({
      method: "GET",
      url: `https://${input.endpoint}/?Action=DbConnectAdmin`,
      service: "dsql",
      expiresIn: 900,
    });
    yield* Effect.gen(function* () {
      const sql = yield* PgClient.PgClient;
      // DSQL requires separate autocommit statements for catalog changes.
      yield* sql`CREATE SCHEMA IF NOT EXISTS app`;
      const roles = yield* sql`SELECT rolname FROM pg_roles WHERE rolname = 'app_user'`;
      if (roles.length === 0) {
        yield* sql`CREATE ROLE app_user WITH LOGIN`;
      }
      yield* sql`CREATE TABLE IF NOT EXISTS app.todos (
        id uuid PRIMARY KEY,
        text text NOT NULL,
        done boolean NOT NULL DEFAULT false,
        created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`;
      yield* sql`GRANT USAGE ON SCHEMA app TO app_user`;
      yield* sql`GRANT SELECT, INSERT, UPDATE, DELETE ON app.todos TO app_user`;
      const mappings = yield* sql`SELECT arn FROM sys.iam_pg_role_mappings
        WHERE pg_role_name = 'app_user' AND arn = ${input.roleArn}`;
      if (mappings.length === 0) {
        yield* sql.unsafe(`AWS IAM GRANT app_user TO '${input.roleArn.replaceAll("'", "''")}'`);
      }
    }).pipe(
      Effect.provide(
        PgClient.layer({
          host: input.endpoint,
          port: 5432,
          database: "postgres",
          username: "admin",
          password: Redacted.make(token.slice("https://".length)),
          ssl: { rejectUnauthorized: true, servername: input.endpoint },
        }),
      ),
    );
    return input.version;
  }),
);
