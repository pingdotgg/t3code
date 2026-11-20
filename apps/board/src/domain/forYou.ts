import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";

export const FOR_YOU_KINDS = [
  "merge_approval",
  "question",
  "ticket_draft",
  "gate",
  "read",
  "resume",
] as const;
export type ForYouKind = (typeof FOR_YOU_KINDS)[number];

export const FOR_YOU_STATUSES = ["open", "held", "resolved"] as const;
export type ForYouStatus = (typeof FOR_YOU_STATUSES)[number];

/** The six conditions the XEO workflow sets before a merge, in the order a card lists them. */
export const MERGE_CONDITIONS = [
  { key: "ci_green", label: "CI green on the head" },
  { key: "reviews_fixed", label: "Independent reviews, introduced findings fixed" },
  { key: "delta_rereviewed", label: "Fix-round delta re-reviewed" },
  { key: "readmes_pass", label: "Touched READMEs pass" },
  { key: "parent_ready", label: "Parent merged or ready, with a merge-order note" },
  { key: "smoke_named", label: "Smoke evidence named" },
] as const;

// The orchestrator writes this file by hand, and a field it does not know yet is left out or null.
const optional = <S extends Schema.Top>(schema: S) => Schema.optionalKey(Schema.NullOr(schema));

const Condition = Schema.Struct({
  met: Schema.Boolean,
  /** The files or links that show the condition holds. */
  evidence: optional(Schema.Array(Schema.String)),
  note: optional(Schema.String),
});
export type MergeCondition = typeof Condition.Type;

const Conditions = Schema.Struct({
  ci_green: Condition,
  reviews_fixed: Condition,
  delta_rereviewed: Condition,
  readmes_pass: Condition,
  parent_ready: Condition,
  smoke_named: Condition,
});

const base = {
  id: Schema.String.check(Schema.isNonEmpty()),
  title: Schema.String,
  body: Schema.String,
  status: Schema.Literals(FOR_YOU_STATUSES),
  createdAt: Schema.String,
  /** What the orchestrator did with the user's answer, in a few words. */
  resolution: optional(Schema.String),
};

const MergeApproval = Schema.Struct({
  ...base,
  kind: Schema.Literal("merge_approval"),
  /** The key of the ticket that is ready to merge. */
  ticket: optional(Schema.String),
  conditions: Conditions,
});
const Question = Schema.Struct({
  ...base,
  kind: Schema.Literal("question"),
  options: optional(Schema.Array(Schema.String)),
});
const Plain = Schema.Struct({
  ...base,
  kind: Schema.Literals(["ticket_draft", "gate", "read", "resume"]),
});

export const ForYouItem = Schema.Union([MergeApproval, Question, Plain]);
export type ForYouItem = typeof ForYouItem.Type;

/** A later line for an item that only moves it on: a new status, and what was done. */
const ItemUpdate = Schema.Struct({
  id: Schema.String,
  status: Schema.Literals(FOR_YOU_STATUSES),
  resolution: optional(Schema.String),
});

const Line = Schema.fromJsonString(Schema.Struct({ id: Schema.String }));
const decodeLine = Schema.decodeUnknownOption(Line);
const decodeItem = Schema.decodeUnknownResult(Schema.fromJsonString(ForYouItem));
const decodeUpdate = Schema.decodeUnknownOption(Schema.fromJsonString(ItemUpdate));
const formatIssues = SchemaIssue.makeFormatterStandardSchemaV1();

/** An approval or a secret a thread in the board's family waits on. */
export interface EngineRequest {
  readonly kind: "approval" | "secret";
  /** The runtime request's id, which for a secret is its turn item's id. */
  readonly id: string;
  readonly threadId: string;
  readonly threadTitle: string;
  readonly createdAt: string;
}

export type ForYouCard =
  | { readonly origin: "file"; readonly id: string; readonly item: ForYouItem }
  | { readonly origin: "engine"; readonly id: string; readonly request: EngineRequest };

export interface ForYouProblem {
  /** The line of `foryou.jsonl`, counted from 1. */
  readonly line: number;
  readonly message: string;
}

export interface ForYouList {
  readonly cards: ReadonlyArray<ForYouCard>;
  readonly problems: ReadonlyArray<ForYouProblem>;
}

/** The part of a thread's shell row that says what it waits on. */
export interface RequestRow {
  readonly id: string;
  readonly title: string;
  readonly pendingRuntimeRequest: {
    readonly id: string;
    readonly kind: string;
    readonly createdAt: DateTime.Utc;
    readonly userOnly?: boolean | undefined;
  } | null;
}

/**
 * What the family waits on from the user: an approval, or a question only the user can answer,
 * which is how the engine marks a secret. Any other question goes to the orchestrator that woke.
 */
export function engineRequestsOf(rows: ReadonlyArray<RequestRow>): ReadonlyArray<EngineRequest> {
  return rows.flatMap((row): EngineRequest[] => {
    const request = row.pendingRuntimeRequest;
    if (request === null) return [];
    if (request.kind === "auth_refresh" || request.kind === "dynamic_tool_call") return [];
    if (request.kind === "user_input" && request.userOnly !== true) return [];
    return [
      {
        kind: request.kind === "user_input" ? "secret" : "approval",
        id: request.id,
        threadId: row.id,
        threadTitle: row.title,
        createdAt: DateTime.formatIso(request.createdAt),
      },
    ];
  });
}

const STATUS_RANK = { open: 0, held: 1, resolved: 2 } as const satisfies Record<
  ForYouStatus,
  number
>;
const statusOf = (card: ForYouCard): ForYouStatus =>
  card.origin === "engine" ? "open" : card.item.status;
const createdAtOf = (card: ForYouCard): number => {
  const time = Date.parse(card.origin === "engine" ? card.request.createdAt : card.item.createdAt);
  return Number.isNaN(time) ? 0 : time;
};

/**
 * The file's items, where the latest line for an id wins, then the engine's requests, with a
 * repeated id dropped. Open cards come first, then held, then resolved, each oldest first.
 */
export function mergeForYou(
  fileText: string | null,
  requests: ReadonlyArray<EngineRequest>,
): ForYouList {
  const problems: ForYouProblem[] = [];
  const items = new Map<string, ForYouItem>();
  (fileText ?? "").split("\n").forEach((text, index) => {
    if (text.trim() === "") return;
    const line = index + 1;
    const known = Option.flatMap(decodeLine(text), ({ id }) => Option.fromNullishOr(items.get(id)));
    const full = decodeItem(text);
    if (Result.isSuccess(full)) {
      items.set(full.success.id, full.success);
      return;
    }
    const update = Option.isSome(known) ? decodeUpdate(text) : Option.none();
    if (Option.isSome(known) && Option.isSome(update)) {
      const { id, status, resolution } = update.value;
      items.set(id, {
        ...known.value,
        status,
        ...(resolution === undefined ? {} : { resolution }),
      });
      return;
    }
    problems.push({
      line,
      message: formatIssues(full.failure.issue)
        .issues.map(
          (issue) => `${issue.path?.length ? `${issue.path.join(".")} ` : ""}${issue.message}`,
        )
        .join("; "),
    });
  });

  const cards: ForYouCard[] = [...items.values()].map((item) => ({
    origin: "file",
    id: item.id,
    item,
  }));
  for (const request of requests) {
    if (!cards.some((card) => card.id === request.id)) {
      cards.push({ origin: "engine", id: request.id, request });
    }
  }
  return {
    cards: cards
      .map((card, order) => ({ card, order }))
      .toSorted(
        (a, b) =>
          STATUS_RANK[statusOf(a.card)] - STATUS_RANK[statusOf(b.card)] ||
          createdAtOf(a.card) - createdAtOf(b.card) ||
          a.order - b.order,
      )
      .map(({ card }) => card),
    problems,
  };
}

/** The cards waiting on the user now. Held and resolved ones do not count. */
export const openCards = (cards: ReadonlyArray<ForYouCard>): ReadonlyArray<ForYouCard> =>
  cards.filter((card) => statusOf(card) === "open");

/** What the user chose on a card, which `forYouMessage` words for the orchestrator. */
export type ForYouAnswer =
  | { readonly type: "choice"; readonly choice: "approve" | "hold" | "resume" | "read" }
  | { readonly type: "text"; readonly text: string };

/** The message that answers a `foryou.jsonl` item. The brief names this format to the orchestrator. */
export const forYouMessage = (id: string, answer: ForYouAnswer): string =>
  `For you item ${id}: ${answer.type === "choice" ? answer.choice : `answer: ${answer.text}`}`;

/** What the card is doing: waiting, answered and waiting on the orchestrator's record, or done. */
export type CardState = "open" | "sent" | "held" | "resolved";

/** A card the user answered this session, with what they chose and the status it had then. */
export interface SentCard {
  readonly card: ForYouCard;
  readonly choice: string;
  readonly status: ForYouStatus;
}

export interface CardView {
  readonly card: ForYouCard;
  readonly state: CardState;
  /** The choice behind `sent`, or the orchestrator's `resolution` once resolved. */
  readonly detail: string | null;
}

/**
 * A card is sent from the click until the file's status moves off the one it had then. An engine
 * request is sent until the engine drops it, and a dropped secret stays as a resolved card, so the
 * user sees it was saved. A dropped approval leaves, because its agent runs again.
 */
export function cardViews(
  cards: ReadonlyArray<ForYouCard>,
  sent: ReadonlyMap<string, SentCard>,
): ReadonlyArray<CardView> {
  const views = cards.map((card): CardView => {
    const record = sent.get(card.id);
    if (card.origin === "engine") {
      return record === undefined
        ? { card, state: "open", detail: null }
        : { card, state: "sent", detail: record.choice };
    }
    const { status, resolution } = card.item;
    if (status === "resolved") return { card, state: "resolved", detail: resolution ?? null };
    if (record?.status === status) return { card, state: "sent", detail: record.choice };
    return { card, state: status, detail: resolution ?? null };
  });
  const present = new Set(cards.map((card) => card.id));
  for (const [id, record] of sent) {
    const { card } = record;
    if (!present.has(id) && card.origin === "engine" && card.request.kind === "secret") {
      views.push({ card, state: "resolved", detail: record.choice });
    }
  }
  return views;
}

/** A card's headline: the orchestrator's title for an item, and the asking thread for an engine request. */
export const cardTitle = (card: ForYouCard): string => {
  if (card.origin === "file") return card.item.title;
  const { kind, threadTitle } = card.request;
  return kind === "approval"
    ? `${threadTitle} needs your approval`
    : `${threadTitle} needs a secret`;
};

export interface BoardOpenItems {
  readonly projectId: string;
  readonly folder: string;
  readonly boardId: string;
  readonly boardName: string;
  /** False until the board's files have been read once, so items that were already there do not toast. */
  readonly loaded: boolean;
  readonly open: ReadonlyArray<{ readonly id: string; readonly title: string }>;
}

export interface ForYouToast {
  readonly id: string;
  readonly projectId: string;
  readonly folder: string;
  readonly boardId: string;
  readonly boardName: string;
  readonly cardId: string;
  readonly title: string;
}

const MAX_TOASTS = 4;

export const NO_TOASTS: ToastState = { seen: new Map(), toasts: [] };

export interface ToastState {
  /** Every item id a board has shown, so an item that comes back is not announced twice. */
  readonly seen: ReadonlyMap<string, ReadonlySet<string>>;
  readonly toasts: ReadonlyArray<ForYouToast>;
}

/**
 * The toasts after `boards` changed: one for each open item a board did not have before. A board's
 * first read only records what is there, so items that were waiting when the app opened stay quiet.
 */
export function nextToasts(
  previous: ToastState,
  boards: ReadonlyArray<BoardOpenItems>,
): ToastState {
  const seen = new Map(previous.seen);
  const fresh: ForYouToast[] = [];
  for (const board of boards) {
    if (!board.loaded) continue;
    const known = seen.get(board.boardId);
    if (known !== undefined) {
      for (const item of board.open) {
        if (known.has(item.id)) continue;
        fresh.push({
          id: `${board.boardId}/${item.id}`,
          projectId: board.projectId,
          folder: board.folder,
          boardId: board.boardId,
          boardName: board.boardName,
          cardId: item.id,
          title: item.title,
        });
      }
    }
    seen.set(board.boardId, new Set([...(known ?? []), ...board.open.map((item) => item.id)]));
  }
  return fresh.length === 0
    ? { seen, toasts: previous.toasts }
    : { seen, toasts: [...previous.toasts, ...fresh].slice(-MAX_TOASTS) };
}
