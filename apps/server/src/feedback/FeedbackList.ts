// `t3 feedback list` reads the local table directly, as `t3 environment list` reads links, so the
// list needs no agent tool. SQLite allows this read beside a running server.
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as Settings from "../serverSettings.ts";
import {
  FeedbackOffError,
  type FeedbackReport,
  FeedbackStorageError,
  FeedbackTrace,
} from "./FeedbackReport.ts";

const LIST_LIMIT = 50;
const decodeTrace = Schema.decodeUnknownEffect(Schema.NullOr(Schema.fromJsonString(FeedbackTrace)));

/** The most recent reports saved on this machine, newest first, exactly as stored. */
export const listFeedbackReports = Effect.gen(function* () {
  const settings = yield* Settings.ServerSettingsService;
  const sql = yield* SqlClient.SqlClient;
  const { agentFeedback } = yield* settings.getSettings.pipe(
    Effect.mapError((cause) => new FeedbackStorageError({ cause })),
  );
  if (agentFeedback.mode === "off") return yield* new FeedbackOffError({});
  const rows = yield* sql<
    Omit<FeedbackReport, "sent" | "userRequested" | "trace"> & {
      readonly sent: number;
      readonly userRequested: number;
      readonly trace: string | null;
    }
  >`
    SELECT id, thread_id AS "threadId", created_at AS "createdAt", kind, subject,
      expected, actual, workaround, user_requested AS "userRequested", trace, source, sent
    FROM agent_feedback ORDER BY rowid DESC LIMIT ${LIST_LIMIT}`.pipe(
    Effect.mapError((cause) => new FeedbackStorageError({ cause })),
  );
  return yield* Effect.forEach(rows, (row) =>
    decodeTrace(row.trace).pipe(
      Effect.mapError((cause) => new FeedbackStorageError({ cause })),
      Effect.map((trace): FeedbackReport => ({
        ...row,
        trace,
        userRequested: row.userRequested === 1,
        sent: row.sent === 1,
      })),
    ),
  );
}).pipe(Effect.withSpan("FeedbackList.listFeedbackReports"));
