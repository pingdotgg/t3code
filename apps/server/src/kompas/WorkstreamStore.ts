import {
  type KompasError,
  ModelSelection,
  ThreadId,
  type WorkstreamDecision,
  type WorkstreamLibraryItem,
  type WorkstreamSuggestion,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { KompasDatabase, kompasError, storageError } from "./KompasDatabase.ts";

const WorkstreamFields = Schema.Struct({
  title: Schema.String,
  goal: Schema.String,
  instructions: Schema.String,
  threadModel: Schema.NullOr(ModelSelection),
  maxParallelThreads: Schema.Number,
  askBeforeStart: Schema.Boolean,
});
export type WorkstreamFields = typeof WorkstreamFields.Type;

export interface StoredWorkstream extends WorkstreamFields {
  readonly id: string;
  readonly coordinatorThreadId: ThreadId;
  readonly createdAt: string;
}

const Ask = Schema.Struct({
  title: Schema.optionalKey(Schema.String),
  task: Schema.optionalKey(Schema.String),
  question: Schema.optionalKey(Schema.String),
  options: Schema.optionalKey(Schema.Array(Schema.String)),
});

/** `suggestion` and `decision` wait for the user; a `grant` is an approved, not yet started thread. */
type AskKind = "suggestion" | "decision" | "grant";

export class WorkstreamStore extends Context.Service<
  WorkstreamStore,
  {
    readonly list: Effect.Effect<ReadonlyArray<StoredWorkstream>, KompasError>;
    readonly get: (id: string) => Effect.Effect<StoredWorkstream, KompasError>;
    readonly byCoordinator: (
      threadId: ThreadId,
    ) => Effect.Effect<StoredWorkstream | undefined, KompasError>;
    readonly create: (
      input: WorkstreamFields & { readonly coordinatorThreadId: ThreadId },
    ) => Effect.Effect<StoredWorkstream, KompasError>;
    readonly update: (
      id: string,
      fields: WorkstreamFields,
    ) => Effect.Effect<void, KompasError>;
    readonly remove: (id: string) => Effect.Effect<void, KompasError>;
    readonly library: (
      workstreamId: string,
    ) => Effect.Effect<ReadonlyArray<WorkstreamLibraryItem>, KompasError>;
    readonly addLibraryItem: (
      input: Pick<WorkstreamLibraryItem, "kind" | "title" | "content" | "threadId"> & {
        readonly workstreamId: string;
      },
    ) => Effect.Effect<WorkstreamLibraryItem, KompasError>;
    readonly removeLibraryItem: (id: string) => Effect.Effect<void, KompasError>;
    readonly resolvedThreads: (
      workstreamId: string,
    ) => Effect.Effect<ReadonlySet<string>, KompasError>;
    readonly setResolved: (input: {
      readonly workstreamId: string;
      readonly threadId: ThreadId;
      readonly resolved: boolean;
    }) => Effect.Effect<void, KompasError>;
    readonly addSuggestions: (
      workstreamId: string,
      suggestions: ReadonlyArray<{ readonly title: string; readonly task: string }>,
    ) => Effect.Effect<void, KompasError>;
    readonly addDecision: (
      workstreamId: string,
      decision: { readonly question: string; readonly options: ReadonlyArray<string> },
    ) => Effect.Effect<void, KompasError>;
    readonly asks: (workstreamId: string) => Effect.Effect<
      {
        readonly suggestions: ReadonlyArray<WorkstreamSuggestion>;
        readonly decisions: ReadonlyArray<WorkstreamDecision>;
      },
      KompasError
    >;
    /** Removes the ask and returns it, so one answer is delivered once. */
    readonly takeAsk: (
      id: string,
      kind: "suggestion" | "decision",
    ) => Effect.Effect<
      {
        readonly workstreamId: string;
        readonly title: string;
        readonly task: string;
        readonly question: string;
      },
      KompasError
    >;
    readonly addGrant: (workstreamId: string, title: string) => Effect.Effect<void, KompasError>;
    /** True when an approval was waiting, which this start used up. */
    readonly takeGrant: (workstreamId: string) => Effect.Effect<boolean, KompasError>;
  }
>()("t3/kompas/WorkstreamStore") {}

interface WorkstreamRow {
  readonly workstream_id: string;
  readonly coordinator_thread_id: string;
  readonly workstream_json: string;
  readonly created_at: string;
}

const decodeFields = Schema.decodeUnknownEffect(Schema.fromJsonString(WorkstreamFields));
const encodeFields = Schema.encodeSync(Schema.fromJsonString(WorkstreamFields));
const decodeAsk = Schema.decodeUnknownEffect(Schema.fromJsonString(Ask));
const encodeAsk = Schema.encodeSync(Schema.fromJsonString(Ask));

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const database = yield* KompasDatabase;
  const changed = <A, E>(effect: Effect.Effect<A, E>) =>
    effect.pipe(Effect.mapError(storageError), Effect.tap(() => database.notifyChanged));

  const toWorkstream = Effect.fnUntraced(function* (row: WorkstreamRow) {
    const fields = yield* decodeFields(row.workstream_json).pipe(Effect.mapError(storageError));
    return {
      ...fields,
      id: row.workstream_id,
      coordinatorThreadId: ThreadId.make(row.coordinator_thread_id),
      createdAt: row.created_at,
    } satisfies StoredWorkstream;
  });

  const list = sql<WorkstreamRow>`SELECT * FROM kompas_workstreams ORDER BY created_at DESC`.pipe(
    Effect.mapError(storageError),
    Effect.flatMap((rows) => Effect.forEach(rows, toWorkstream)),
    Effect.withSpan("WorkstreamStore.list"),
  );

  const get = Effect.fn("WorkstreamStore.get")(function* (id: string) {
    const found = (yield* list).find((workstream) => workstream.id === id);
    return found ?? (yield* kompasError("not-found", "This project no longer exists."));
  });

  const byCoordinator = Effect.fn("WorkstreamStore.byCoordinator")(function* (threadId: ThreadId) {
    const rows = yield* sql<WorkstreamRow>`
      SELECT * FROM kompas_workstreams WHERE coordinator_thread_id = ${threadId}
    `.pipe(Effect.mapError(storageError));
    return rows[0] === undefined ? undefined : yield* toWorkstream(rows[0]);
  });

  const create: WorkstreamStore["Service"]["create"] = Effect.fn("WorkstreamStore.create")(
    function* ({ coordinatorThreadId, ...fields }) {
      const id = yield* database.newId;
      const createdAt = yield* database.now;
      yield* changed(sql`
        INSERT INTO kompas_workstreams
          (workstream_id, coordinator_thread_id, workstream_json, created_at)
        VALUES (${id}, ${coordinatorThreadId}, ${encodeFields(fields)}, ${createdAt})
      `);
      return { ...fields, id, coordinatorThreadId, createdAt };
    },
  );

  const update: WorkstreamStore["Service"]["update"] = Effect.fn("WorkstreamStore.update")(
    function* (id, fields) {
      yield* changed(sql`
        UPDATE kompas_workstreams SET workstream_json = ${encodeFields(fields)}
        WHERE workstream_id = ${id}
      `);
    },
  );

  const remove = Effect.fn("WorkstreamStore.remove")(function* (id: string) {
    yield* changed(sql`DELETE FROM kompas_workstreams WHERE workstream_id = ${id}`);
  });

  const library = Effect.fn("WorkstreamStore.library")(function* (workstreamId: string) {
    const rows = yield* sql<{
      readonly item_id: string;
      readonly kind: WorkstreamLibraryItem["kind"];
      readonly title: string;
      readonly content: string;
      readonly thread_id: string | null;
      readonly created_at: string;
    }>`
      SELECT * FROM kompas_library_items WHERE workstream_id = ${workstreamId}
      ORDER BY created_at DESC
    `.pipe(Effect.mapError(storageError));
    return rows.map(
      (row): WorkstreamLibraryItem => ({
        id: row.item_id,
        kind: row.kind,
        title: row.title,
        content: row.content,
        threadId: row.thread_id === null ? null : ThreadId.make(row.thread_id),
        createdAt: row.created_at,
      }),
    );
  });

  const addLibraryItem: WorkstreamStore["Service"]["addLibraryItem"] = Effect.fn(
    "WorkstreamStore.addLibraryItem",
  )(function* ({ workstreamId, ...item }) {
    const id = yield* database.newId;
    const createdAt = yield* database.now;
    yield* changed(sql`
      INSERT INTO kompas_library_items
        (item_id, workstream_id, kind, title, content, thread_id, created_at)
      VALUES (
        ${id}, ${workstreamId}, ${item.kind}, ${item.title}, ${item.content}, ${item.threadId},
        ${createdAt}
      )
    `);
    return { ...item, id, createdAt };
  });

  const removeLibraryItem = Effect.fn("WorkstreamStore.removeLibraryItem")(function* (id: string) {
    yield* changed(sql`DELETE FROM kompas_library_items WHERE item_id = ${id}`);
  });

  const resolvedThreads = Effect.fn("WorkstreamStore.resolvedThreads")(function* (
    workstreamId: string,
  ) {
    const rows = yield* sql<{ readonly thread_id: string }>`
      SELECT thread_id FROM kompas_workstream_resolved WHERE workstream_id = ${workstreamId}
    `.pipe(Effect.mapError(storageError));
    return new Set(rows.map((row) => row.thread_id));
  });

  const setResolved: WorkstreamStore["Service"]["setResolved"] = Effect.fn(
    "WorkstreamStore.setResolved",
  )(function* (input) {
    yield* changed(
      input.resolved
        ? sql`
            INSERT OR IGNORE INTO kompas_workstream_resolved (workstream_id, thread_id)
            VALUES (${input.workstreamId}, ${input.threadId})
          `
        : sql`
            DELETE FROM kompas_workstream_resolved
            WHERE workstream_id = ${input.workstreamId} AND thread_id = ${input.threadId}
          `,
    );
  });

  const addAsk = Effect.fn("WorkstreamStore.addAsk")(function* (
    workstreamId: string,
    kind: AskKind,
    ask: typeof Ask.Type,
  ) {
    const id = yield* database.newId;
    const createdAt = yield* database.now;
    yield* changed(sql`
      INSERT INTO kompas_workstream_asks (ask_id, workstream_id, kind, ask_json, created_at)
      VALUES (${id}, ${workstreamId}, ${kind}, ${encodeAsk(ask)}, ${createdAt})
    `);
  });

  interface AskRow {
    readonly ask_id: string;
    readonly workstream_id: string;
    readonly kind: AskKind;
    readonly ask_json: string;
    readonly created_at: string;
  }

  const asks = Effect.fn("WorkstreamStore.asks")(function* (workstreamId: string) {
    const rows = yield* sql<AskRow>`
      SELECT * FROM kompas_workstream_asks
      WHERE workstream_id = ${workstreamId} AND kind <> 'grant' ORDER BY created_at
    `.pipe(Effect.mapError(storageError));
    const decoded = yield* Effect.forEach(rows, (row) =>
      decodeAsk(row.ask_json).pipe(
        Effect.mapError(storageError),
        Effect.map((ask) => ({ row, ask })),
      ),
    );
    return {
      suggestions: decoded
        .filter(({ row }) => row.kind === "suggestion")
        .map(({ row, ask }) => ({
          id: row.ask_id,
          title: ask.title ?? "",
          task: ask.task ?? "",
          createdAt: row.created_at,
        })),
      decisions: decoded
        .filter(({ row }) => row.kind === "decision")
        .map(({ row, ask }) => ({
          id: row.ask_id,
          question: ask.question ?? "",
          options: ask.options ?? [],
          createdAt: row.created_at,
        })),
    };
  });

  const takeAsk: WorkstreamStore["Service"]["takeAsk"] = Effect.fn("WorkstreamStore.takeAsk")(
    function* (id, kind) {
      const rows = yield* sql<AskRow>`
        DELETE FROM kompas_workstream_asks WHERE ask_id = ${id} AND kind = ${kind} RETURNING *
      `.pipe(Effect.mapError(storageError));
      const row = rows[0];
      if (row === undefined) return yield* kompasError("not-found", "This was already answered.");
      yield* database.notifyChanged;
      const ask = yield* decodeAsk(row.ask_json).pipe(Effect.mapError(storageError));
      return {
        workstreamId: row.workstream_id,
        title: ask.title ?? "",
        task: ask.task ?? "",
        question: ask.question ?? "",
      };
    },
  );

  const takeGrant = Effect.fn("WorkstreamStore.takeGrant")(function* (workstreamId: string) {
    const rows = yield* sql`
      DELETE FROM kompas_workstream_asks WHERE ask_id = (
        SELECT ask_id FROM kompas_workstream_asks
        WHERE workstream_id = ${workstreamId} AND kind = 'grant' ORDER BY created_at LIMIT 1
      ) RETURNING ask_id
    `.pipe(Effect.mapError(storageError));
    return rows.length > 0;
  });

  return WorkstreamStore.of({
    list,
    get,
    byCoordinator,
    create,
    update,
    remove,
    library,
    addLibraryItem,
    removeLibraryItem,
    resolvedThreads,
    setResolved,
    addSuggestions: Effect.fn("WorkstreamStore.addSuggestions")((workstreamId, suggestions) =>
      Effect.forEach(suggestions, (suggestion) => addAsk(workstreamId, "suggestion", suggestion), {
        discard: true,
      }),
    ),
    addDecision: Effect.fn("WorkstreamStore.addDecision")((workstreamId, decision) =>
      addAsk(workstreamId, "decision", decision),
    ),
    asks,
    takeAsk,
    addGrant: Effect.fn("WorkstreamStore.addGrant")((workstreamId, title) =>
      addAsk(workstreamId, "grant", { title }),
    ),
    takeGrant,
  });
});

export const layer = Layer.effect(WorkstreamStore, make);
