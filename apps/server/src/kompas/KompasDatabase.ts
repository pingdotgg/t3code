import type { KompasErrorReason } from "@t3tools/contracts";
import { KompasError } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

// Kompas keeps its own ledger: upstream owns the ids in `effect_sql_migrations`.
const migrations = Migrator.fromRecord({
  "1_Kompas": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      CREATE TABLE kompas_settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        settings_json TEXT NOT NULL
      )
    `;
    yield* sql`
      CREATE TABLE kompas_plugins (
        plugin_id TEXT PRIMARY KEY,
        plugin_json TEXT NOT NULL,
        tools_json TEXT NOT NULL DEFAULT '[]',
        needs_sign_in INTEGER NOT NULL DEFAULT 0,
        error TEXT,
        created_at TEXT NOT NULL
      )
    `;
    yield* sql`
      CREATE TABLE kompas_plugin_threads (
        plugin_id TEXT NOT NULL REFERENCES kompas_plugins(plugin_id) ON DELETE CASCADE,
        thread_id TEXT NOT NULL,
        enabled INTEGER NOT NULL,
        PRIMARY KEY (plugin_id, thread_id)
      )
    `;
    yield* sql`
      CREATE TABLE kompas_memory_entries (
        entry_id TEXT PRIMARY KEY,
        scope TEXT NOT NULL,
        text TEXT NOT NULL,
        status TEXT NOT NULL,
        replaces_id TEXT,
        model TEXT,
        thread_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `;
    yield* sql`
      CREATE TABLE kompas_decks (
        deck_id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        thread_id TEXT,
        created_at TEXT NOT NULL
      )
    `;
    yield* sql`
      CREATE TABLE kompas_cards (
        card_id TEXT PRIMARY KEY,
        deck_id TEXT NOT NULL REFERENCES kompas_decks(deck_id) ON DELETE CASCADE,
        front TEXT NOT NULL,
        back TEXT NOT NULL,
        hint TEXT,
        tags_json TEXT NOT NULL DEFAULT '[]',
        thread_id TEXT,
        fsrs_json TEXT NOT NULL,
        due TEXT NOT NULL,
        created_at TEXT NOT NULL
      )
    `;
    yield* sql`CREATE INDEX kompas_cards_deck_due_idx ON kompas_cards(deck_id, due)`;
    yield* sql`
      CREATE TABLE kompas_reviews (
        review_id TEXT PRIMARY KEY,
        card_id TEXT NOT NULL REFERENCES kompas_cards(card_id) ON DELETE CASCADE,
        rating TEXT NOT NULL,
        reviewed_at TEXT NOT NULL,
        fsrs_json TEXT NOT NULL
      )
    `;
    yield* sql`CREATE INDEX kompas_reviews_reviewed_at_idx ON kompas_reviews(reviewed_at)`;
    yield* sql`
      CREATE TABLE kompas_quiz_results (
        result_id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        correct INTEGER NOT NULL,
        total INTEGER NOT NULL,
        thread_id TEXT,
        created_at TEXT NOT NULL
      )
    `;
    yield* sql`
      CREATE TABLE kompas_workstreams (
        workstream_id TEXT PRIMARY KEY,
        coordinator_thread_id TEXT NOT NULL UNIQUE,
        workstream_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      )
    `;
    yield* sql`
      CREATE TABLE kompas_workstream_resolved (
        workstream_id TEXT NOT NULL
          REFERENCES kompas_workstreams(workstream_id) ON DELETE CASCADE,
        thread_id TEXT NOT NULL,
        PRIMARY KEY (workstream_id, thread_id)
      )
    `;
    yield* sql`
      CREATE TABLE kompas_library_items (
        item_id TEXT PRIMARY KEY,
        workstream_id TEXT NOT NULL
          REFERENCES kompas_workstreams(workstream_id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        thread_id TEXT,
        created_at TEXT NOT NULL
      )
    `;
    yield* sql`
      CREATE TABLE kompas_workstream_asks (
        ask_id TEXT PRIMARY KEY,
        workstream_id TEXT NOT NULL
          REFERENCES kompas_workstreams(workstream_id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        ask_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      )
    `;
  }),
});

/** Kompas tables plus the "something changed" signal every client subscription follows. */
export class KompasDatabase extends Context.Service<
  KompasDatabase,
  {
    readonly notifyChanged: Effect.Effect<void>;
    /** Emits once at once, then after every change. */
    readonly changes: Stream.Stream<void>;
    readonly newId: Effect.Effect<string>;
    readonly now: Effect.Effect<string>;
  }
>()("t3/kompas/KompasDatabase") {}

export const kompasError = (reason: KompasErrorReason, message: string, cause?: unknown) =>
  new KompasError({ reason, message, ...(cause === undefined ? {} : { cause }) });

export const storageError = (cause: unknown) =>
  kompasError("storage", "Could not read or save Kompas data.", cause);

const runMigrations = Migrator.make({});

const make = Effect.gen(function* () {
  yield* runMigrations({ loader: migrations, table: "kompas_migrations" });
  const random = yield* SecureRandom.SecureRandom;
  // Subscribers re-read everything, so a slow one needs only the newest signal.
  const changes = yield* PubSub.sliding<void>(1);
  return KompasDatabase.of({
    notifyChanged: PubSub.publish(changes, undefined).pipe(Effect.asVoid),
    changes: Stream.unwrap(
      Effect.map(PubSub.subscribe(changes), (subscription) =>
        Stream.concat(Stream.succeed<void>(undefined), Stream.fromSubscription(subscription)),
      ),
    ),
    newId: random.uuidV4().pipe(Effect.orDie),
    now: DateTime.now.pipe(Effect.map(DateTime.formatIso)),
  });
});

export const layer = Layer.effect(KompasDatabase, make);
