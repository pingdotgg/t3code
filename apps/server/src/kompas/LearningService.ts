import {
  type Card,
  type Deck,
  type KompasError,
  type ReviewRating,
  type StudyStats,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type { Fragment } from "effect/sql/Statement";
import { type Card as FsrsCard, createEmptyCard, fsrs, type Grade, Rating } from "ts-fsrs";

import { KompasDatabase, kompasError, storageError } from "./KompasDatabase.ts";

export interface NewCard {
  readonly front: string;
  readonly back: string;
  readonly hint?: string | null | undefined;
  readonly tags?: ReadonlyArray<string> | undefined;
}

export class LearningService extends Context.Service<
  LearningService,
  {
    readonly decks: Effect.Effect<ReadonlyArray<Deck>, KompasError>;
    readonly getDeck: (id: string) => Effect.Effect<Deck, KompasError>;
    readonly createDeck: (input: {
      readonly title: string;
      readonly cards: ReadonlyArray<NewCard>;
      readonly threadId: ThreadId | null;
    }) => Effect.Effect<Deck, KompasError>;
    readonly renameDeck: (input: {
      readonly id: string;
      readonly title: string;
    }) => Effect.Effect<void, KompasError>;
    readonly removeDeck: (id: string) => Effect.Effect<void, KompasError>;
    readonly addCards: (input: {
      readonly deckId: string;
      readonly cards: ReadonlyArray<NewCard>;
      readonly threadId: ThreadId | null;
    }) => Effect.Effect<Deck, KompasError>;
    readonly cards: (input: {
      readonly deckId?: string | undefined;
      readonly dueOnly: boolean;
    }) => Effect.Effect<ReadonlyArray<Card>, KompasError>;
    readonly getCard: (id: string) => Effect.Effect<Card, KompasError>;
    readonly editCard: (input: {
      readonly id: string;
      readonly front: string;
      readonly back: string;
      readonly hint: string | null;
    }) => Effect.Effect<Card, KompasError>;
    readonly removeCard: (id: string) => Effect.Effect<void, KompasError>;
    readonly review: (input: {
      readonly id: string;
      readonly rating: ReviewRating;
      /** The reviews of the card the rating was made on. Fails when it has had another since. */
      readonly reviewCount?: number | undefined;
    }) => Effect.Effect<Card, KompasError>;
    readonly stats: Effect.Effect<StudyStats, KompasError>;
    readonly exportCsv: (
      deckId: string,
    ) => Effect.Effect<{ readonly fileName: string; readonly csv: string }, KompasError>;
    readonly recordQuiz: (input: {
      readonly title: string;
      readonly correct: number;
      readonly total: number;
      readonly threadId: ThreadId;
    }) => Effect.Effect<void, KompasError>;
  }
>()("t3/kompas/LearningService") {}

const FsrsState = Schema.Struct({
  due: Schema.String,
  stability: Schema.Number,
  difficulty: Schema.Number,
  elapsed_days: Schema.Number,
  scheduled_days: Schema.Number,
  learning_steps: Schema.Number,
  reps: Schema.Number,
  lapses: Schema.Number,
  state: Schema.Literals([0, 1, 2, 3]),
  last_review: Schema.NullOr(Schema.String),
});
const decodeFsrs = Schema.decodeUnknownEffect(Schema.fromJsonString(FsrsState));
const encodeFsrs = Schema.encodeSync(Schema.fromJsonString(FsrsState));
const encodeTags = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));
const decodeTags = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Array(Schema.String)));

const serializeFsrs = (card: FsrsCard) =>
  encodeFsrs({
    due: card.due.toISOString(),
    stability: card.stability,
    difficulty: card.difficulty,
    elapsed_days: card.elapsed_days,
    scheduled_days: card.scheduled_days,
    learning_steps: card.learning_steps,
    reps: card.reps,
    lapses: card.lapses,
    state: card.state,
    last_review: card.last_review?.toISOString() ?? null,
  });

const toDate = (iso: string) => DateTime.toDateUtc(DateTime.makeUnsafe(iso));

const fromState = ({ due, last_review, ...state }: typeof FsrsState.Type): FsrsCard => ({
  ...state,
  due: toDate(due),
  ...(last_review === null ? {} : { last_review: toDate(last_review) }),
});

const GRADES: Record<ReviewRating, Grade> = {
  again: Rating.Again,
  hard: Rating.Hard,
  good: Rating.Good,
  easy: Rating.Easy,
};

const scheduler = fsrs({ enable_fuzz: false });

interface CardRow {
  readonly card_id: string;
  readonly deck_id: string;
  readonly deck_title: string;
  readonly front: string;
  readonly back: string;
  readonly hint: string | null;
  readonly tags_json: string;
  readonly thread_id: string | null;
  readonly fsrs_json: string;
}

interface DeckRow {
  readonly deck_id: string;
  readonly title: string;
  readonly thread_id: string | null;
  readonly card_count: number;
  readonly due_count: number;
  readonly created_at: string;
}

const csvField = (value: string) =>
  /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;

/** Days reviewed in a row ending today, or yesterday while today has none yet. */
export function streakOf(days: ReadonlySet<string>, today: string): number {
  const before = (day: string) =>
    DateTime.formatIsoDateUtc(DateTime.subtract(DateTime.makeUnsafe(day), { days: 1 }));
  let day = days.has(today) ? today : before(today);
  let streak = 0;
  while (days.has(day)) {
    streak += 1;
    day = before(day);
  }
  return streak;
}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const database = yield* KompasDatabase;
  const nowDate = Effect.map(DateTime.now, DateTime.toDateUtc);

  const toCard = Effect.fnUntraced(function* (row: CardRow, now: Date) {
    const state = fromState(yield* decodeFsrs(row.fsrs_json));
    const tags = yield* decodeTags(row.tags_json);
    const next = scheduler.repeat(state, now);
    return {
      id: row.card_id,
      deckId: row.deck_id,
      deckTitle: row.deck_title,
      front: row.front,
      back: row.back,
      hint: row.hint,
      tags,
      threadId: row.thread_id === null ? null : ThreadId.make(row.thread_id),
      due: state.due.toISOString(),
      reviewCount: state.reps,
      lapses: state.lapses,
      nextDue: {
        again: next[Rating.Again].card.due.toISOString(),
        hard: next[Rating.Hard].card.due.toISOString(),
        good: next[Rating.Good].card.due.toISOString(),
        easy: next[Rating.Easy].card.due.toISOString(),
      },
    } satisfies Card;
  }, Effect.mapError(storageError));

  const decksWhere = Effect.fn("LearningService.decks")(function* (id: string | null) {
    const now = yield* database.now;
    const rows = yield* sql<DeckRow>`
      SELECT decks.deck_id, decks.title, decks.thread_id, decks.created_at,
        COUNT(cards.card_id) AS card_count,
        COALESCE(SUM(cards.due <= ${now}), 0) AS due_count
      FROM kompas_decks AS decks
      LEFT JOIN kompas_cards AS cards ON cards.deck_id = decks.deck_id
      WHERE ${id} IS NULL OR decks.deck_id = ${id}
      GROUP BY decks.deck_id
      ORDER BY decks.created_at DESC
    `.pipe(Effect.mapError(storageError));
    return rows.map((row): Deck => ({
      id: row.deck_id,
      title: row.title,
      threadId: row.thread_id === null ? null : ThreadId.make(row.thread_id),
      cardCount: row.card_count,
      dueCount: row.due_count,
      createdAt: row.created_at,
    }));
  });

  const getDeck = Effect.fn("LearningService.getDeck")(function* (id: string) {
    const deck = (yield* decksWhere(id))[0];
    return deck ?? (yield* kompasError("not-found", "This deck no longer exists."));
  });

  const insertCards = Effect.fn("LearningService.insertCards")(function* (
    deckId: string,
    cards: ReadonlyArray<NewCard>,
    threadId: ThreadId | null,
  ) {
    const now = yield* nowDate;
    const createdAt = now.toISOString();
    const empty = createEmptyCard(now);
    const fsrsJson = serializeFsrs(empty);
    for (const card of cards) {
      const id = yield* database.newId;
      yield* sql`
        INSERT INTO kompas_cards
          (card_id, deck_id, front, back, hint, tags_json, thread_id, fsrs_json, due, created_at)
        VALUES (
          ${id}, ${deckId}, ${card.front}, ${card.back}, ${card.hint ?? null},
          ${encodeTags(card.tags ?? [])}, ${threadId}, ${fsrsJson}, ${createdAt}, ${createdAt}
        )
      `;
    }
  });

  const createDeck: LearningService["Service"]["createDeck"] = Effect.fn(
    "LearningService.createDeck",
  )(function* (input) {
    const id = yield* database.newId;
    const now = yield* database.now;
    yield* sql
      .withTransaction(
        Effect.gen(function* () {
          yield* sql`
            INSERT INTO kompas_decks (deck_id, title, thread_id, created_at)
            VALUES (${id}, ${input.title}, ${input.threadId}, ${now})
          `;
          yield* insertCards(id, input.cards, input.threadId);
        }),
      )
      .pipe(Effect.mapError(storageError));
    yield* database.notifyChanged;
    return yield* getDeck(id);
  });

  const renameDeck: LearningService["Service"]["renameDeck"] = Effect.fn(
    "LearningService.renameDeck",
  )(function* (input) {
    yield* sql`UPDATE kompas_decks SET title = ${input.title} WHERE deck_id = ${input.id}`.pipe(
      Effect.mapError(storageError),
    );
    yield* database.notifyChanged;
  });

  const removeDeck = Effect.fn("LearningService.removeDeck")(function* (id: string) {
    yield* sql`DELETE FROM kompas_decks WHERE deck_id = ${id}`.pipe(Effect.mapError(storageError));
    yield* database.notifyChanged;
  });

  const addCards: LearningService["Service"]["addCards"] = Effect.fn("LearningService.addCards")(
    function* (input) {
      yield* getDeck(input.deckId);
      yield* sql
        .withTransaction(insertCards(input.deckId, input.cards, input.threadId))
        .pipe(Effect.mapError(storageError));
      yield* database.notifyChanged;
      return yield* getDeck(input.deckId);
    },
  );

  const selectCards = (where: Fragment) => sql<CardRow>`
    SELECT cards.card_id, cards.deck_id, decks.title AS deck_title, cards.front, cards.back,
      cards.hint, cards.tags_json, cards.thread_id, cards.fsrs_json
    FROM kompas_cards AS cards
    INNER JOIN kompas_decks AS decks ON decks.deck_id = cards.deck_id
    WHERE ${where}
    ORDER BY cards.due, cards.created_at, cards.rowid
  `;

  const cards: LearningService["Service"]["cards"] = Effect.fn("LearningService.cards")(
    function* (input) {
      const now = yield* nowDate;
      const deckId = input.deckId ?? null;
      const rows = yield* selectCards(
        input.dueOnly
          ? sql`(${deckId} IS NULL OR cards.deck_id = ${deckId}) AND cards.due <= ${now.toISOString()}`
          : sql`(${deckId} IS NULL OR cards.deck_id = ${deckId})`,
      ).pipe(Effect.mapError(storageError));
      return yield* Effect.forEach(rows, (row) => toCard(row, now));
    },
  );

  const getRow = Effect.fn("LearningService.getRow")(function* (id: string) {
    const rows = yield* selectCards(sql`cards.card_id = ${id}`).pipe(Effect.mapError(storageError));
    return rows[0] ?? (yield* kompasError("not-found", "This card no longer exists."));
  });

  const getCard = Effect.fn("LearningService.getCard")(function* (id: string) {
    return yield* toCard(yield* getRow(id), yield* nowDate);
  });

  const editCard: LearningService["Service"]["editCard"] = Effect.fn("LearningService.editCard")(
    function* (input) {
      yield* getRow(input.id);
      yield* sql`
        UPDATE kompas_cards
        SET front = ${input.front}, back = ${input.back}, hint = ${input.hint}
        WHERE card_id = ${input.id}
      `.pipe(Effect.mapError(storageError));
      yield* database.notifyChanged;
      return yield* getCard(input.id);
    },
  );

  const removeCard = Effect.fn("LearningService.removeCard")(function* (id: string) {
    yield* sql`DELETE FROM kompas_cards WHERE card_id = ${id}`.pipe(Effect.mapError(storageError));
    yield* database.notifyChanged;
  });

  const review: LearningService["Service"]["review"] = Effect.fn("LearningService.review")(
    function* (input) {
      const now = yield* nowDate;
      const reviewId = yield* database.newId;
      // Read in the transaction too, or of two reviews at once the second undoes the first.
      const reviewed = yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const row = yield* getRow(input.id);
            const before = fromState(yield* decodeFsrs(row.fsrs_json));
            if (input.reviewCount !== undefined && input.reviewCount !== before.reps) {
              return yield* kompasError("invalid", "This card was already reviewed.");
            }
            const { card } = scheduler.next(before, now, GRADES[input.rating]);
            const fsrsJson = serializeFsrs(card);
            yield* sql`
              UPDATE kompas_cards SET fsrs_json = ${fsrsJson}, due = ${card.due.toISOString()}
              WHERE card_id = ${input.id}
            `;
            yield* sql`
              INSERT INTO kompas_reviews (review_id, card_id, rating, reviewed_at, fsrs_json)
              VALUES (${reviewId}, ${input.id}, ${input.rating}, ${now.toISOString()}, ${fsrsJson})
            `;
            return { ...row, fsrs_json: fsrsJson };
          }),
        )
        .pipe(
          Effect.catchTags({
            SqlError: (cause) => Effect.fail(storageError(cause)),
            SchemaError: (cause) => Effect.fail(storageError(cause)),
          }),
        );
      yield* database.notifyChanged;
      return yield* toCard(reviewed, now);
    },
  );

  const stats = Effect.gen(function* () {
    const now = yield* database.now;
    // The server's local day: reviews belong to the user's day, not to UTC's.
    const days = yield* sql<{
      readonly day: string;
      readonly today: string;
      readonly count: number;
    }>`
      SELECT date(reviewed_at, 'localtime') AS day, date('now', 'localtime') AS today,
        COUNT(*) AS count
      FROM kompas_reviews GROUP BY day
    `;
    const weakest = yield* sql<{
      readonly card_id: string;
      readonly deck_title: string;
      readonly front: string;
      readonly lapses: number;
    }>`
      SELECT cards.card_id, decks.title AS deck_title, cards.front,
        json_extract(cards.fsrs_json, '$.lapses') AS lapses
      FROM kompas_cards AS cards
      INNER JOIN kompas_decks AS decks ON decks.deck_id = cards.deck_id
      WHERE json_extract(cards.fsrs_json, '$.lapses') > 0
      ORDER BY lapses DESC, json_extract(cards.fsrs_json, '$.difficulty') DESC
      LIMIT 10
    `;
    const due = yield* sql<{ readonly count: number }>`
      SELECT COUNT(*) AS count FROM kompas_cards WHERE due <= ${now}
    `;
    const today = days[0]?.today ?? "";
    return {
      streakDays: streakOf(new Set(days.map(({ day }) => day)), today || now.slice(0, 10)),
      reviewsToday: days.find(({ day }) => day === today)?.count ?? 0,
      reviewsTotal: days.reduce((total, { count }) => total + count, 0),
      dueCount: due[0]?.count ?? 0,
      weakest: weakest.map((row) => ({
        cardId: row.card_id,
        deckTitle: row.deck_title,
        front: row.front,
        lapses: row.lapses,
      })),
    } satisfies StudyStats;
  }).pipe(Effect.mapError(storageError), Effect.withSpan("LearningService.stats"));

  const exportCsv = Effect.fn("LearningService.exportCsv")(function* (deckId: string) {
    const deck = yield* getDeck(deckId);
    const rows = (yield* cards({ deckId, dueOnly: false })).map((card) =>
      [card.front, card.back, card.hint ?? "", card.tags.join(" ")].map(csvField).join(","),
    );
    const name = deck.title.replace(/[\\/:*?"<>|\p{Cc}\s]+/gu, " ").trim() || "deck";
    return { fileName: `${name}.csv`, csv: ["front,back,hint,tags", ...rows].join("\r\n") };
  });

  const recordQuiz: LearningService["Service"]["recordQuiz"] = Effect.fn(
    "LearningService.recordQuiz",
  )(function* (input) {
    const id = yield* database.newId;
    const now = yield* database.now;
    yield* sql`
      INSERT INTO kompas_quiz_results (result_id, title, correct, total, thread_id, created_at)
      VALUES (${id}, ${input.title}, ${input.correct}, ${input.total}, ${input.threadId}, ${now})
    `.pipe(Effect.mapError(storageError));
  });

  return LearningService.of({
    decks: decksWhere(null),
    getDeck,
    createDeck,
    renameDeck,
    removeDeck,
    addCards,
    cards,
    getCard,
    editCard,
    removeCard,
    review,
    stats,
    exportCsv,
    recordQuiz,
  });
});

export const layer = Layer.effect(LearningService, make);
