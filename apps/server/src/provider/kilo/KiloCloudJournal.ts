import {
  OrchestrationV2ProviderThread,
  OrchestrationV2ProviderTurn,
  PositiveInt,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { CloudBinding } from "./KiloCloudWebClient.ts";

export const CloudIntent = Schema.Struct({
  revision: Schema.Number,
  accountId: Schema.NonEmptyString,
  repository: Schema.NonEmptyString,
  branch: Schema.NonEmptyString,
  operationKey: Schema.NonEmptyString,
  messageId: Schema.NonEmptyString,
  payloadHash: Schema.NonEmptyString,
  policyHash: Schema.NonEmptyString,
  binding: Schema.NullOr(CloudBinding),
  prepared: Schema.NullOr(
    Schema.Struct({
      cloudAgentSessionId: Schema.NonEmptyString,
      kiloSessionId: Schema.NonEmptyString,
    }),
  ),
  // Absent on older records: their admission remains uncertain. Only a durable
  // preflight marker proves that the paid request has not reached execute.
  submissionPhase: Schema.optional(Schema.Literals(["preflight", "post_attempted"])),
  state: Schema.Literals([
    "admission_unknown",
    "active",
    "awaiting_result",
    "completed",
    "failed",
    "interrupted",
  ]),
  remoteState: Schema.optional(
    Schema.Literals(["queued", "running", "completed", "failed", "interrupted"]),
  ),
  resultStatus: Schema.optional(
    Schema.Literals(["awaiting_result", "available", "unavailable", "cancelled"]),
  ),
  resultRecovery: Schema.optional(
    Schema.Struct({
      deadlineMs: Schema.Number,
      nextAttemptMs: Schema.Number,
      attempts: Schema.Number,
      cursor: Schema.NullOr(Schema.String),
      seenCursors: Schema.Array(Schema.String),
      completeReplySeen: Schema.optional(Schema.Boolean),
      incompleteReplySeen: Schema.optional(Schema.Boolean),
    }),
  ),
  admissionRecoveryPaused: Schema.optional(Schema.Boolean),
  admissionRecoveryFailures: Schema.optional(Schema.Number),
  interruptRequested: Schema.Boolean,
  answeredRequestIds: Schema.Array(Schema.String),
  providerThread: OrchestrationV2ProviderThread,
  providerTurn: OrchestrationV2ProviderTurn,
  runOrdinal: PositiveInt,
});
export type CloudIntent = typeof CloudIntent.Type;
export class CloudJournalError extends Schema.TaggedError<CloudJournalError>()(
  "CloudJournalError",
  {
    operation: Schema.Literals(["read", "write"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {}
const codec = Schema.fromJsonString(Schema.toCodecJson(CloudIntent));
const encode = Schema.encodeEffect(codec);
const decode = Schema.decodeUnknownEffect(codec);

/** A FULL-synchronous SQLite commit precedes paid admission. This also serializes
 * old/new drivers during settings reload and works without platform-specific
 * directory fsync. Records contain correlations, never credentials or prompts.
 */
export const make = Effect.fn("KiloCloudJournal.make")(function* (directory: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs
    .makeDirectory(directory, { recursive: true, mode: 0o700 })
    .pipe(Effect.mapError((cause) => new CloudJournalError({ operation: "write", cause })));
  const filename = path.join(directory, "intents.sqlite");
  const context = yield* Layer.build(NodeSqliteClient.layer({ filename })).pipe(
    Effect.mapError((cause) => new CloudJournalError({ operation: "write", cause })),
  );
  const sql = Context.get(context, SqlClient.SqlClient);
  yield* fs
    .chmod(filename, 0o600)
    .pipe(Effect.mapError((cause) => new CloudJournalError({ operation: "write", cause })));
  yield* Effect.gen(function* () {
    yield* sql`PRAGMA busy_timeout = 5000`;
    yield* sql`PRAGMA synchronous = FULL`;
    yield* sql`CREATE TABLE IF NOT EXISTS intents (operation_key TEXT PRIMARY KEY, thread_id TEXT NOT NULL, state TEXT NOT NULL, body TEXT NOT NULL)`;
    yield* sql`CREATE INDEX IF NOT EXISTS cloud_intents_thread ON intents(thread_id)`;
    yield* sql`CREATE UNIQUE INDEX IF NOT EXISTS one_active_cloud_intent_v2 ON intents(thread_id) WHERE state IN ('active', 'admission_unknown', 'awaiting_result')`;
  }).pipe(Effect.mapError((cause) => new CloudJournalError({ operation: "write", cause })));
  const read = Effect.gen(function* () {
    const rows = yield* sql<{ body: string }>`SELECT body FROM intents ORDER BY rowid`;
    return yield* Effect.forEach(rows, (row) => decode(row.body));
  }).pipe(Effect.mapError((cause) => new CloudJournalError({ operation: "read", cause })));
  return {
    read,
    readThread: (threadId: string) =>
      Effect.gen(function* () {
        const rows = yield* sql<{
          body: string;
        }>`SELECT body FROM intents WHERE thread_id = ${threadId} ORDER BY rowid`;
        return yield* Effect.forEach(rows, (row) => decode(row.body));
      }).pipe(Effect.mapError((cause) => new CloudJournalError({ operation: "read", cause }))),
    reserve: (intent: CloudIntent) =>
      Effect.gen(function* () {
        const body = yield* encode(intent);
        const rows =
          yield* sql`INSERT INTO intents (operation_key, thread_id, state, body) VALUES (${intent.operationKey}, ${intent.providerThread.id}, ${intent.state}, ${body}) ON CONFLICT DO NOTHING RETURNING operation_key`;
        return rows.length === 1;
      }).pipe(Effect.mapError((cause) => new CloudJournalError({ operation: "write", cause }))),
    save: (intent: CloudIntent) =>
      Effect.gen(function* () {
        const rows = yield* sql<{
          body: string;
        }>`SELECT body FROM intents WHERE operation_key = ${intent.operationKey}`;
        const row = rows[0];
        if (!row) return yield* new CloudJournalError({ operation: "write" });
        const prior = yield* decode(row.body);
        if (
          prior.revision !== intent.revision ||
          prior.accountId !== intent.accountId ||
          prior.repository !== intent.repository ||
          prior.branch !== intent.branch ||
          prior.messageId !== intent.messageId ||
          prior.payloadHash !== intent.payloadHash ||
          prior.policyHash !== intent.policyHash ||
          (intent.submissionPhase === "preflight" && prior.submissionPhase !== "preflight") ||
          prior.providerThread.id !== intent.providerThread.id ||
          prior.providerTurn.id !== intent.providerTurn.id ||
          (["completed", "failed", "interrupted"].includes(prior.state) &&
            prior.state !== intent.state)
        )
          return yield* new CloudJournalError({ operation: "write" });
        const next = { ...intent, revision: intent.revision + 1 };
        const body = yield* encode(next);
        const updated =
          yield* sql`UPDATE intents SET state = ${intent.state}, body = ${body} WHERE operation_key = ${intent.operationKey} AND body = ${row.body} RETURNING operation_key`;
        if (updated.length !== 1) return yield* new CloudJournalError({ operation: "write" });
        return next;
      }).pipe(Effect.mapError((cause) => new CloudJournalError({ operation: "write", cause }))),
  };
});
