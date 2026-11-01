import * as Neon from "alchemy/Neon";
import * as SQL from "alchemy/SQL/Postgres";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { resources } from "./resources.ts";

export default class Events extends Neon.Function<Events>()(
  "Events",
  Effect.gen(function* () {
    const { branch } = yield* resources;
    return { branch, main: import.meta.url };
  }),
  Effect.gen(function* () {
    const { branch } = yield* resources;
    const connection = yield* Neon.Connect(branch);
    const sql = yield* SQL.Postgres({ url: connection.connectionString });
    yield* Neon.CronEventSource("Nightly", { cron: "0 2 * * *" }, (event) =>
      Effect.gen(function* () {
        // Redelivery of the same invocation cannot create a second journal entry.
        yield* sql`INSERT INTO scheduled_runs (invocation_id)
          VALUES (${event.invocationId}) ON CONFLICT DO NOTHING`;
      }),
    );
  }).pipe(
    Effect.provide(Layer.mergeAll(Neon.ConnectHttp, Neon.CronEventSourceHttp)),
  ),
) {}
