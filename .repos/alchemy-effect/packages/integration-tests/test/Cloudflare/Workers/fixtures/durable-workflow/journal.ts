import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import { Journal } from "../../../../Workflows/conformance/journal.ts";

/** One run's journal, in a Durable Object named after the run. */
export class JournalObject extends Cloudflare.DurableObject<JournalObject>()(
  "DurableWorkflowJournal",
  Effect.gen(function* () {
    const state = yield* Cloudflare.DurableObjectState;
    return Effect.gen(function* () {
      yield* state.storage.sql.exec(
        "CREATE TABLE IF NOT EXISTS entries (seq INTEGER PRIMARY KEY AUTOINCREMENT, entry TEXT NOT NULL)",
      );
      return {
        append: (entry: string) =>
          state.storage.sql
            .exec("INSERT INTO entries (entry) VALUES (?)", entry)
            .pipe(Effect.asVoid),
        list: () =>
          state.storage.sql.exec<{ entry: string }>("SELECT entry FROM entries ORDER BY seq").pipe(
            Effect.flatMap((cursor) => cursor.toArray()),
            Effect.map((rows) => rows.map((row) => row.entry)),
          ),
      };
    });
  }),
) {}

// Right after a deploy, a call to the journal can fail in transit.
const inTransit = Effect.retry({ schedule: Schedule.spaced("500 millis"), times: 20 });

/** The conformance journal over `JournalObject`. */
export const JournalLive = Layer.effect(
  Journal,
  Effect.gen(function* () {
    const journals = yield* JournalObject;
    return {
      append: (id, entry) => journals.getByName(id).append(entry).pipe(inTransit, Effect.orDie),
      list: (id) => journals.getByName(id).list().pipe(inTransit, Effect.orDie),
    };
  }),
);
