import { CommandId, IssueAutomationAction, NonNegativeInt, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { PersistenceSqlError } from "./Errors.ts";

/**
 * What issue status automation last saw for a thread: each linked issue's status, and an action
 * decided on a change that still waits for the thread to go idle.
 */
const Observation = Schema.Struct({
  threadId: ThreadId,
  /** The rules and links the statuses belong to; a different one starts a new baseline. */
  fingerprint: Schema.String,
  statuses: Schema.Record(Schema.String, Schema.NullOr(Schema.String)),
  pending: Schema.NullOr(
    Schema.Struct({
      commandId: CommandId,
      action: Schema.Union([IssueAutomationAction, Schema.Literal("unchanged")]),
      revision: NonNegativeInt,
    }),
  ),
});
export type Observation = typeof Observation.Type;
const decodeObservation = Schema.decodeEffect(Schema.fromJsonString(Observation));
const encodeObservation = Schema.encodeEffect(Schema.fromJsonString(Observation));

export class IssueThreadAutomation extends Context.Service<
  IssueThreadAutomation,
  {
    readonly list: Effect.Effect<ReadonlyMap<ThreadId, Observation>, PersistenceSqlError>;
    readonly save: (observation: Observation) => Effect.Effect<void, PersistenceSqlError>;
    /** Forgets every thread not listed. */
    readonly prune: (
      threadIds: ReadonlyArray<ThreadId>,
    ) => Effect.Effect<void, PersistenceSqlError>;
  }
>()("t3/persistence/IssueThreadAutomation") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const list = Effect.gen(function* () {
    const rows = yield* sql<{
      payload_json: string;
    }>`SELECT payload_json FROM issue_thread_automation`;
    const observations = yield* Effect.forEach(rows, (row) => decodeObservation(row.payload_json));
    return new Map(observations.map((observation) => [observation.threadId, observation]));
  }).pipe(
    Effect.mapError(
      (cause) => new PersistenceSqlError({ operation: "listIssueThreadAutomation", cause }),
    ),
  );
  const save = Effect.fn("IssueThreadAutomation.save")(
    function* (observation: Observation) {
      const payload = yield* encodeObservation(observation);
      yield* sql`
        INSERT INTO issue_thread_automation (thread_id, payload_json)
        VALUES (${observation.threadId}, ${payload})
        ON CONFLICT (thread_id) DO UPDATE SET payload_json = excluded.payload_json
      `;
    },
    Effect.mapError(
      (cause) => new PersistenceSqlError({ operation: "saveIssueThreadAutomation", cause }),
    ),
  );
  const prune = Effect.fn("IssueThreadAutomation.prune")(
    function* (threadIds: ReadonlyArray<ThreadId>) {
      yield* threadIds.length === 0
        ? sql`DELETE FROM issue_thread_automation`
        : sql`DELETE FROM issue_thread_automation WHERE thread_id NOT IN ${sql.in(threadIds)}`;
    },
    Effect.mapError(
      (cause) => new PersistenceSqlError({ operation: "pruneIssueThreadAutomation", cause }),
    ),
  );
  return IssueThreadAutomation.of({ list, save, prune });
});

export const layer = Layer.effect(IssueThreadAutomation, make);
