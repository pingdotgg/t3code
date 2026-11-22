import {
  BotDraft,
  BotDraftChange,
  BotError,
  BotGrant,
  type BotConfiguration,
  type BotSetGrantInput,
  type CommandId,
  type ScheduledTaskId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

type DraftRow = {
  readonly id: string;
  readonly authorThreadId: string;
  readonly authorRevision: number;
  readonly changeJson: string;
  readonly decision: string | null;
  readonly grantSource: string | null;
  readonly activatedId: string | null;
};

export class BotDraftStore extends Context.Service<
  BotDraftStore,
  {
    readonly save: (draft: BotDraft) => Effect.Effect<BotDraft, BotError>;
    readonly findPending: (id: CommandId) => Effect.Effect<BotDraft | undefined, BotError>;
    readonly resolve: (
      id: CommandId,
      decision: "approved" | "rejected",
      activation?: { readonly source: BotGrant["source"] | "owner" | "self"; readonly id: string },
    ) => Effect.Effect<void, BotError>;
    readonly subscribe: () => Stream.Stream<typeof BotConfiguration.Type, BotError>;
    readonly automationOwner: (
      id: string,
      author: BotDraft["authorThreadId"],
      resource: BotGrant["resource"],
    ) => Effect.Effect<BotDraft | undefined, BotError>;
    readonly taskHeldByRevocation: (taskId: ScheduledTaskId) => Effect.Effect<boolean, BotError>;
    readonly allows: (grant: BotGrant) => Effect.Effect<boolean, BotError>;
    readonly setGrant: (input: typeof BotSetGrantInput.Type) => Effect.Effect<void, BotError>;
    readonly activatedUnder: (grant: BotGrant) => Effect.Effect<ReadonlyArray<string>, BotError>;
  }
>()("t3/bots/BotDraftStore") {}

const draftJson = Schema.fromJsonString(BotDraftChange);
const decodeChange = Schema.decodeEffect(draftJson);
const encodeChange = Schema.encodeEffect(draftJson);
const decodeDraft = Schema.decodeUnknownEffect(BotDraft);
const decodeGrants = Schema.decodeUnknownEffect(Schema.Array(BotGrant));
const unavailable = (cause: unknown) => new BotError({ reason: "unavailable", cause });

const decodeRow = Effect.fn("BotDraftStore.decodeRow")(function* ({
  changeJson,
  decision,
  grantSource,
  activatedId,
  ...row
}: DraftRow) {
  const change = yield* decodeChange(changeJson);
  return yield* decodeDraft({
    ...row,
    change,
    ...(decision === null ? {} : { decision }),
    ...(grantSource === null ? {} : { authorization: grantSource }),
    ...(activatedId === null ? {} : { activatedId }),
  });
});

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const changes = yield* PubSub.sliding<void>(1);
  const notify = PubSub.publish(changes, undefined);
  const select = sql`
    SELECT id, author_thread_id AS "authorThreadId", author_revision AS "authorRevision",
           change_json AS "changeJson", decision, grant_source AS "grantSource", activated_id AS "activatedId" FROM bot_drafts
  `;

  const list = Effect.fn("BotDraftStore.list")(function* () {
    const drafts =
      yield* sql<DraftRow>`${select} ORDER BY decision IS NOT NULL, rowid DESC LIMIT 200`.pipe(
        Effect.flatMap((rows) => Effect.forEach(rows, decodeRow)),
      );
    const grants = yield* sql`
      SELECT thread_id AS "threadId", resource, source FROM bot_activation_grants
      ORDER BY thread_id, resource, source
    `.pipe(Effect.flatMap(decodeGrants));
    return { drafts, grants };
  }, Effect.mapError(unavailable));

  const findPending = Effect.fn("BotDraftStore.findPending")(function* (id: CommandId) {
    return yield* sql<DraftRow>`${select} WHERE id = ${id} AND decision IS NULL`.pipe(
      Effect.flatMap((rows) => (rows[0] === undefined ? Effect.undefined : decodeRow(rows[0]))),
      Effect.mapError(unavailable),
    );
  });

  const save = Effect.fn("BotDraftStore.save")(function* (draft: BotDraft) {
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const change = yield* encodeChange(draft.change);
          yield* sql`
        INSERT INTO bot_drafts (id, author_thread_id, author_revision, change_json)
        VALUES (${draft.id}, ${draft.authorThreadId}, ${draft.authorRevision}, ${change})
        ON CONFLICT (id) DO NOTHING
      `;
          const [row] = yield* sql<DraftRow>`${select} WHERE id = ${draft.id}`;
          return row === undefined ? draft : yield* decodeRow(row);
        }),
      )
      .pipe(
        Effect.mapError(unavailable),
        Effect.tap(() => notify),
      );
  });

  const resolve = Effect.fn("BotDraftStore.resolve")(function* (
    id: CommandId,
    decision: "approved" | "rejected",
    activation?: { readonly source: BotGrant["source"] | "owner" | "self"; readonly id: string },
  ) {
    yield* sql`
      UPDATE bot_drafts
      SET decision = ${decision}, grant_source = ${activation?.source ?? null}, activated_id = ${activation?.id ?? null}
      WHERE id = ${id} AND decision IS NULL
    `.pipe(
      Effect.mapError(unavailable),
      Effect.tap(() => notify),
    );
  });

  const allows = Effect.fn("BotDraftStore.allows")(function* (grant: BotGrant) {
    const rows = yield* sql`
      SELECT 1 FROM bot_activation_grants
      WHERE thread_id = ${grant.threadId} AND resource = ${grant.resource} AND source = ${grant.source}
    `.pipe(Effect.mapError(unavailable));
    return rows.length !== 0;
  });

  const setGrant = Effect.fn("BotDraftStore.setGrant")(function* (
    input: typeof BotSetGrantInput.Type,
  ) {
    yield* (
      input.enabled
        ? sql`
          INSERT INTO bot_activation_grants (thread_id, resource, source)
          VALUES (${input.threadId}, ${input.resource}, ${input.source}) ON CONFLICT DO NOTHING
        `
        : sql`
          DELETE FROM bot_activation_grants
          WHERE thread_id = ${input.threadId} AND resource = ${input.resource} AND source = ${input.source}
        `
    ).pipe(
      Effect.mapError(unavailable),
      Effect.tap(() => notify),
    );
  });

  const automationOwner = Effect.fn("BotDraftStore.automationOwner")(function* (
    id: string,
    author: BotDraft["authorThreadId"],
    resource: BotGrant["resource"],
  ) {
    const [row] = yield* sql<DraftRow>`
      ${select} WHERE activated_id = ${id} AND author_thread_id = ${author}
        AND json_extract(change_json, '$.type') = ${resource}
      ORDER BY rowid DESC LIMIT 1
    `;
    return row === undefined ? undefined : yield* decodeRow(row);
  }, Effect.mapError(unavailable));

  const taskHeldByRevocation = Effect.fn("BotDraftStore.taskHeldByRevocation")(function* (
    taskId: ScheduledTaskId,
  ) {
    const [row] = yield* sql<{ readonly held: number }>`
      SELECT draft.grant_source IN ('direct', 'scheduled', 'handoff', 'webhook') AND NOT EXISTS (
        SELECT 1 FROM bot_activation_grants AS grant
        WHERE grant.thread_id = draft.author_thread_id AND grant.source = draft.grant_source
          AND grant.resource = json_extract(draft.change_json, '$.type')
      ) AS held
      FROM bot_drafts AS draft
      INNER JOIN scheduled_tasks AS task ON task.task_id = draft.activated_id
      WHERE draft.activated_id = ${taskId} AND task.enabled = 0
        AND json_extract(draft.change_json, '$.type') IN ('schedule', 'hook')
      ORDER BY draft.rowid DESC LIMIT 1
    `.pipe(Effect.mapError(unavailable));
    return row?.held === 1;
  });

  const activatedUnder = Effect.fn("BotDraftStore.activatedUnder")(function* (grant: BotGrant) {
    const rows = yield* sql<{ readonly activated_id: string }>`
      SELECT DISTINCT activated_id FROM bot_drafts AS draft
      WHERE rowid = (SELECT MAX(rowid) FROM bot_drafts AS recent
        WHERE recent.activated_id = draft.activated_id AND recent.author_thread_id = draft.author_thread_id
          AND json_extract(recent.change_json, '$.type') = json_extract(draft.change_json, '$.type'))
        AND author_thread_id = ${grant.threadId} AND grant_source = ${grant.source}
        AND json_extract(change_json, '$.type') = ${grant.resource} AND activated_id IS NOT NULL
    `.pipe(Effect.mapError(unavailable));
    return rows.map((row) => row.activated_id);
  });

  return BotDraftStore.of({
    allows,
    setGrant,
    taskHeldByRevocation,
    activatedUnder,
    automationOwner,
    findPending,
    save,
    resolve,
    subscribe: () =>
      Stream.unwrap(
        Effect.gen(function* () {
          const subscription = yield* PubSub.subscribe(changes);
          return Stream.concat(
            Stream.fromEffect(list()),
            Stream.fromSubscription(subscription).pipe(Stream.mapEffect(list)),
          );
        }),
      ),
  });
});

export const layer = Layer.effect(BotDraftStore, make);
