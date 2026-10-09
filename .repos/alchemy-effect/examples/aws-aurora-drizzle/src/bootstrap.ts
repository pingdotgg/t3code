import * as Alchemy from "alchemy";
import * as AWS from "alchemy/AWS";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { database } from "./database.ts";

// One atomic, replay-safe initial migration. Application roles never own DDL.
const initialMigration = `DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_iam') THEN
    CREATE ROLE app_iam LOGIN;
  END IF;
  GRANT rds_iam TO app_iam;
  REVOKE CREATE ON SCHEMA public FROM PUBLIC;
  CREATE TABLE IF NOT EXISTS public.todos (
    id uuid PRIMARY KEY,
    title text NOT NULL,
    done boolean NOT NULL DEFAULT false
  );
  GRANT CONNECT ON DATABASE app TO app_iam;
  GRANT USAGE ON SCHEMA public TO app_iam;
  GRANT SELECT, INSERT, UPDATE, DELETE ON public.todos TO app_iam;
END $$`;

export const bootstrap = Effect.gen(function* () {
  const db = yield* database;
  const Bootstrap = Alchemy.Action(
    "BootstrapDatabase",
    Effect.gen(function* () {
      const execute = yield* AWS.RDSData.ExecuteStatement(db.cluster, {
        secret: db.secret,
        database: "app",
      });
      return Effect.fn(function* (input: { writer: string; sql: string }) {
        yield* execute({ sql: input.sql }).pipe(
          Effect.retry({
            while: (error) =>
              error._tag === "DatabaseUnavailableException" ||
              error._tag === "DatabaseResumingException",
            schedule: Schedule.spaced("5 seconds"),
            times: 8,
          }),
        );
        return "1";
      });
    }).pipe(Effect.provide(AWS.RDSData.ExecuteStatementHttp)),
  );
  return yield* Bootstrap({
    writer: db.writer.dbInstanceArn,
    sql: initialMigration,
  });
});
