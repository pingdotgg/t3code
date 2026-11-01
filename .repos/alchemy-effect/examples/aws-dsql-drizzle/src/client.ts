import * as AWS from "alchemy/AWS";
import * as Drizzle from "alchemy/Drizzle/Postgres";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { Database } from "./database.ts";

export const connectDatabase = Effect.gen(function* () {
  const cluster = yield* Database;
  const connect = yield* AWS.DSQL.Connect(cluster, { username: "app_user" });
  return yield* Drizzle.Postgres(
    connect.pipe(
      Effect.map((connection) => {
        const url = new URL(Redacted.value(connection.url));
        url.searchParams.set("sslmode", "verify-full");
        return Redacted.make(url.toString());
      }),
    ),
  );
});
