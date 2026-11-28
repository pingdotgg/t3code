import {
  type MilestoneEvent,
  MilestoneId,
  type WorkflowCounts,
  WorkflowRun,
  type WorkflowRunReference,
  WorkflowRunStatus,
  type WorkflowRunSubject,
  WorkflowStep,
} from "@t3tools/contracts";
import { splitsSurrogatePair } from "@t3tools/shared/assistantCitations";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as MilestoneHub from "../milestones/MilestoneHub.ts";

export { WorkflowRun, WorkflowRunStatus, WorkflowStep };

/** Where a signal goes: one wait of one run, or whichever run of a workflow waits on a channel. */
export type SignalAddress =
  | { readonly runId: string; readonly wait: string }
  | { readonly workflow: string; readonly channel: string };

/**
 * Who sent a signal and when it was received, as the server saw it. A question's answer is stamped
 * with this and with nothing the signal's own value says about them.
 */
export interface SignalSender {
  readonly answeredBy?: string | undefined;
  readonly answeredBySession?: string | undefined;
  readonly answeredAt: string;
}

/** The run that invoked another, and the wait in it that hears how the other ended. */
export interface RunParent {
  readonly runId: string;
  readonly wait: string;
}

/** A run as lists show it: everything but what it was started with, which can be a whole payload. */
export interface RunSummaryRow {
  readonly run_id: string;
  readonly workflow: string;
  readonly idempotency_key: string;
  readonly version: number | bigint;
  readonly engine_tag: string;
  readonly title: string;
  /** The run's tags, as a JSON list of text. */
  readonly tags_json: string;
  /** What the run is about, as a `WorkflowRunSubject` in JSON; null when it declared nothing. */
  readonly subject_json: string | null;
  readonly status: WorkflowRunStatus;
  readonly detail: string | null;
  readonly result_json: string | null;
  readonly parent_run_id: string | null;
  readonly parent_wait: string | null;
  readonly pauses: number | bigint;
  /** Paused until a person resumes it, whatever the workflow's `resumeAfter` says. */
  readonly held: number | bigint;
  readonly started_at: string;
  readonly updated_at: string;
  readonly ended_at: string | null;
}
export interface RunRow extends RunSummaryRow {
  readonly input_json: string | null;
}
export interface StepRow {
  readonly name: string;
  readonly kind: WorkflowStep["kind"];
  readonly status: WorkflowStep["status"];
  readonly attempts: number | bigint;
  readonly detail: string | null;
  readonly thread_id: string | null;
  readonly environment_id: string | null;
  readonly result_json: string | null;
  readonly said: string | null;
  readonly started_at: string;
  readonly ended_at: string | null;
  /** For a step queued for a place, how many asked for one in its pool before it. */
  readonly ahead: number | bigint | null;
}
export interface WaitRow {
  readonly run_id: string;
  readonly name: string;
  readonly token: string;
  readonly schema_json: string;
  readonly request_json: string | null;
  readonly watch_json: string | null;
  readonly deadline: string | null;
  readonly opened_at: string;
  /** What it was woken with, once it has been. */
  readonly woke_json: string | null;
}

/** Something a run touched, as the one that touched it knows it. */
export interface ReferenceInput {
  readonly kind: string;
  readonly key: string;
  readonly address: Schema.Json;
  /** Empty when the toucher does not know it; a title already kept stays. */
  readonly title: string;
  readonly url?: string | null | undefined;
  readonly state?: string | null | undefined;
}
interface ReferenceRow {
  readonly kind: string;
  readonly key: string;
  readonly address_json: string;
  readonly title: string;
  readonly url: string | null;
  readonly state: string | null;
  readonly steps_json: string;
  readonly origin: WorkflowRunReference["origin"];
}

// Rows keep JSON as text. Everything stored was a JSON value when it was written.
export const jsonText = (value: Schema.Json): string => JSON.stringify(value);
export const jsonValue = (text: string): Schema.Json => JSON.parse(text) as Schema.Json;
/** A `subject_json` as this store wrote it. */
export const subjectOf = (text: string) => JSON.parse(text) as WorkflowRunSubject;

const now = Effect.map(DateTime.now, DateTime.formatIso);

type WorkflowMilestone = Extract<MilestoneEvent, { readonly workflowRunId: string }>;
/** What a workflow milestone says beyond its envelope and its run. */
type WorkflowMilestoneNews = WorkflowMilestone extends infer Event
  ? Event extends WorkflowMilestone
    ? Omit<
        Event,
        | "id"
        | "occurredAt"
        | "projectId"
        | "threadId"
        | "parentThreadId"
        | "actor"
        | "isSubagentChild"
        | "workflowRunId"
        | "workflow"
        | "runTitle"
        | "parentWorkflowRunId"
      >
    : never
  : never;
// A wake is one write away from its claim. A claim this old without its run moving had none.
const WAKE_REDONE_AFTER = Duration.seconds(30);
// Long enough for a sender's retries, short enough that the table stays small.
// Enough to read what a step said; the page that shows it is not a place for a whole report.
const STEP_RESULT_KEPT = 8_000;
const stepResultCut = (text: string) => {
  const end = splitsSurrogatePair(text, STEP_RESULT_KEPT) ? STEP_RESULT_KEPT - 1 : STEP_RESULT_KEPT;
  return `${text.slice(0, end)}…`;
};
const DETAIL_KEPT = 2_000;
export const detailCut = (text: string) =>
  text.length <= DETAIL_KEPT
    ? text
    : text.slice(0, splitsSurrogatePair(text, DETAIL_KEPT) ? DETAIL_KEPT - 1 : DETAIL_KEPT);
const SIGNAL_IDS_KEPT = Duration.days(7);
const REFERENCE_TITLE_KEPT = 300;
const SUBJECT_TITLE_KEPT = 200;
const subjectTitle = (title: string) =>
  title.slice(
    0,
    splitsSurrogatePair(title, SUBJECT_TITLE_KEPT) ? SUBJECT_TITLE_KEPT - 1 : SUBJECT_TITLE_KEPT,
  );
const idsKeptUntil = Effect.map(DateTime.now, (at) =>
  DateTime.formatIso(DateTime.addDuration(at, SIGNAL_IDS_KEPT)),
);
const senderText = (sender: SignalSender) =>
  jsonText({
    ...(sender.answeredBy === undefined ? {} : { answeredBy: sender.answeredBy }),
    ...(sender.answeredBySession === undefined
      ? {}
      : { answeredBySession: sender.answeredBySession }),
    answeredAt: sender.answeredAt,
  });
const senderOf = (text: string) => jsonValue(text) as unknown as SignalSender;
// A tuple, so no name or key can be read as part of the other.
const mailAddress = (address: SignalAddress) =>
  JSON.stringify(
    "runId" in address
      ? ["run", address.runId, address.wait]
      : ["key", address.workflow, address.channel],
  );
// Smallest string above every key starting with `prefix` in SQLite's UTF-8 byte order, or null when none exists.
const prefixUpperBound = (prefix: string): string | null => {
  const normalized = prefix.toWellFormed();
  for (let i = normalized.length; i > 0;) {
    const prev = normalized.charCodeAt(i - 1);
    const start = prev >= 0xdc00 && prev <= 0xdfff ? i - 2 : i - 1;
    const codePoint = normalized.codePointAt(start);
    if (codePoint !== undefined && codePoint < 0x10ffff) {
      const next = codePoint === 0xd7ff ? 0xe000 : codePoint + 1;
      return `${normalized.slice(0, start)}${String.fromCodePoint(next)}`;
    }
    i = start;
  }
  return null;
};

const RUN_LIST_LIMIT = 500;

export interface WorkflowRunListPage {
  readonly rows: ReadonlyArray<RunSummaryRow>;
  /** Older runs in this list (outside top-level skipped runs when unfiltered) were omitted at the limit. */
  readonly truncated: boolean;
  /** Older top-level skipped runs were omitted at their separate limit (only on unfiltered lists). */
  readonly skippedTruncated?: boolean | undefined;
}

interface RunsWhereFilter {
  readonly workflow?: string | undefined;
  readonly status?: WorkflowRunStatus | undefined;
  readonly keyPrefix?: string | undefined;
  /** Runs with an open question of this kind. */
  readonly kind?: string | undefined;
  /** Runs tagged with this. */
  readonly tag?: string | undefined;
  /** Runs about this: the subject's kind and key, or text that is its web address or key. */
  readonly subject?: { readonly kind: string; readonly key: string } | string | undefined;
  /** Only skipped runs no other run invoked (true), or only the rest (false). */
  readonly skippedTopLevel?: boolean | undefined;
}

export class WorkflowStore extends Context.Service<
  WorkflowStore,
  {
    readonly changes: PubSub.PubSub<string>;
    readonly runStarted: (run: {
      readonly runId: string;
      readonly workflow: string;
      readonly version: number;
      readonly engineTag: string;
      readonly idempotencyKey: string;
      readonly input: Schema.Json;
      readonly parent?: RunParent | undefined;
    }) => Effect.Effect<void>;
    readonly runStatus: (
      runId: string,
      status: "running" | "waiting",
      detail: string | null,
    ) => Effect.Effect<void>;
    /**
     * A wait or an agent of the run is over. The run is running again, unless another it started
     * side by side is still out, which it then waits on.
     */
    readonly runResumed: (runId: string) => Effect.Effect<void>;
    /** `held` unsaid keeps what the run had: a run put back to paused is still held. */
    readonly runPaused: (runId: string, detail: string, held?: boolean) => Effect.Effect<void>;
    /**
     * A paused run is running again. With `current`, only while that is still the pause: the
     * sweep's deadline was worked out from it. False when the run was not changed.
     */
    readonly runUnpaused: (
      runId: string,
      current?: { readonly pauses: number; readonly updatedAt: string },
    ) => Effect.Effect<boolean>;
    /** The person's resume has reached the engine, so the run no longer waits for one. */
    readonly runUnheld: (runId: string) => Effect.Effect<void>;
    readonly runEnded: (
      runId: string,
      status: "completed" | "stopped" | "skipped" | "cancelled",
      detail: string | null,
      result: Schema.Json,
    ) => Effect.Effect<boolean>;
    readonly runTitle: (runId: string, title: string) => Effect.Effect<void>;
    /** The run's tags from now on, in place of any it had. */
    readonly runTags: (runId: string, tags: ReadonlyArray<string>) => Effect.Effect<void>;
    /** What the run is about from now on, in place of anything it said before. */
    readonly runSubject: (runId: string, subject: ReferenceInput) => Effect.Effect<void>;
    /** Marks the step running and returns how many times it has now been started. */
    readonly stepStarted: (
      runId: string,
      name: string,
      kind: WorkflowStep["kind"],
    ) => Effect.Effect<number>;
    readonly stepEnded: (
      runId: string,
      name: string,
      status: "completed" | "failed",
      detail: string | null,
    ) => Effect.Effect<void>;
    readonly waitOpened: (wait: {
      readonly runId: string;
      readonly name: string;
      readonly workflow: string;
      readonly key: string | undefined;
      readonly token: string;
      readonly schemaJson: string;
      /** What a person is asked, when this wait is a question. */
      readonly requestJson: string | null;
      /** What the engine looks at to end this wait by itself. */
      readonly watchJson: string | null;
      readonly deadline: string | null;
    }) => Effect.Effect<void>;
    readonly waitClosed: (runId: string, name: string) => Effect.Effect<void>;
    /** The wait takes signals again, under a fresh wake: what woke it was not for it. */
    readonly waitReopened: (runId: string, name: string, token: string) => Effect.Effect<void>;
    /** Takes the wait for one signal. False when another signal already has it. */
    /**
     * Claims an open wait for one wake and keeps what it is woken with. False when something else
     * already claimed it. A signal's id is recorded with the claim, so a retry never claims twice.
     */
    readonly waitSignalled: (
      runId: string,
      name: string,
      woke: Schema.Json,
      signalId?: string,
    ) => Effect.Effect<boolean>;
    /** Waits claimed a while ago whose runs are still not past them: their wake is redone. */
    readonly waitsToWake: Effect.Effect<ReadonlyArray<WaitRow>>;
    /** The run's waits that were claimed and are still open, whose wakes a resume sends. */
    readonly waitsClaimed: (runId: string) => Effect.Effect<ReadonlyArray<WaitRow>>;
    /**
     * Hands one buffered signal to one wait, or to none: the claim and the removal happen
     * together. `gone` when the signal is expired or absent, `claimed` when the wait was already woken.
     */
    readonly mailDeliver: (
      signalId: string,
      runId: string,
      name: string,
      woke: Schema.Json,
    ) => Effect.Effect<"delivered" | "gone" | "claimed">;
    /** Runs that were not ended while the run that invoked them was cancelled. */
    readonly orphans: Effect.Effect<ReadonlyArray<RunRow>>;
    /** Runs ended before `before`, with no step still going, whose engine journal is still kept. */
    readonly prunable: (
      before: string,
      limit: number,
    ) => Effect.Effect<ReadonlyArray<{ readonly run_id: string; readonly engine_tag: string }>>;
    readonly enginePruned: (runId: string) => Effect.Effect<void>;
    /**
     * Deletes up to `limit` skipped top-level runs per call past each workflow's latest `kept`, once
     * their engine journal is gone, with their steps. A run that invoked others is kept.
     */
    readonly pruneSkipped: (kept: number, limit: number) => Effect.Effect<number>;
    /** Every run in this state, however many: the sweep must not miss old ones past a page. */
    readonly everyRun: (
      status: "running" | "waiting" | "paused",
    ) => Effect.Effect<ReadonlyArray<RunRow>>;
    /** What each run that has not ended is a run of, with no limit. */
    readonly unfinished: Effect.Effect<
      ReadonlyArray<{ readonly workflow: string; readonly version: number }>
    >;
    /** Whether a signal with this id already woke a wait. */
    readonly signalSeen: (signalId: string) => Effect.Effect<boolean>;
    /** Counts one more arrival at `name` in this run and returns the count. */
    readonly mark: (runId: string, name: string) => Effect.Effect<number>;
    /** The runs this one invoked that have not ended. */
    readonly children: (runId: string) => Effect.Effect<ReadonlyArray<RunRow>>;
    /** The steps a cancelled run left in flight are over: nothing will end them. */
    readonly stepsCancelled: (runId: string, except: string) => Effect.Effect<void>;
    /** Cancelled runs whose `onEnd` has not completed and may still be tried, with its tries. */
    readonly runsToEnd: (
      step: string,
      tries: number,
    ) => Effect.Effect<
      ReadonlyArray<
        RunRow & {
          readonly end_attempts: number | bigint | null;
          readonly end_ended_at: string | null;
        }
      >
    >;
    /** Cancelled runs with a step other than `except` still going: their cancel was cut short. */
    readonly cancelsCutShort: (except: string) => Effect.Effect<ReadonlyArray<RunRow>>;
    /** Ended runs whose parent still waits to hear of it. */
    readonly untold: Effect.Effect<ReadonlyArray<RunRow>>;
    readonly stepThread: (
      runId: string,
      name: string,
      threadId: string,
      environment: string | null,
      turnId: string,
    ) => Effect.Effect<void>;
    /** The threads of agent steps still running in this run, with each step's own turn. */
    readonly runningThreads: (runId: string) => Effect.Effect<
      ReadonlyArray<{
        readonly threadId: string;
        readonly environment?: string;
        readonly turnId?: string;
      }>
    >;
    readonly waitAt: (address: SignalAddress) => Effect.Effect<WaitRow | undefined>;
    /** Every open wait on `key`, in one workflow or in all of them. */
    readonly waitsOn: (
      key: string,
      workflow: string | undefined,
    ) => Effect.Effect<ReadonlyArray<WaitRow>>;
    readonly waitsPastDeadline: Effect.Effect<ReadonlyArray<WaitRow>>;
    readonly requests: Effect.Effect<ReadonlyArray<WaitRow>>;
    /** Open waits the engine ends by looking at something. */
    readonly watches: Effect.Effect<ReadonlyArray<WaitRow>>;
    /** The thread of the run's latest agent step, if it has had one. */
    readonly latestThread: (
      runId: string,
    ) => Effect.Effect<{ readonly threadId: string; readonly environmentId: string | null } | null>;
    readonly counts: Effect.Effect<WorkflowCounts>;
    /** Keep what a step produced for a person to read. A large value is kept as its start. */
    readonly stepResult: (
      runId: string,
      name: string,
      value: Schema.Json,
      /** What an agent said in closing, when its result is data and not that reply. */
      said?: string,
    ) => Effect.Effect<void>;
    /** Say something about a step that is under way, such as when its sleep ends. */
    readonly stepDetail: (runId: string, name: string, detail: string) => Effect.Effect<void>;
    readonly mailPut: (mail: {
      readonly signalId: string;
      readonly address: SignalAddress;
      readonly valueJson: string;
      readonly expiresAt: string;
      /** Kept beside the value, never in it: the wait that takes the signal may be a question. */
      readonly sender: SignalSender;
    }) => Effect.Effect<void>;
    /** The oldest signal kept for any of these addresses, but `passed`. It stays until `mailDelete`. */
    readonly mailNext: (
      addresses: ReadonlyArray<SignalAddress>,
      passed?: ReadonlySet<string>,
    ) => Effect.Effect<
      | {
          readonly signalId: string;
          readonly valueJson: string;
          readonly address: SignalAddress;
          /** Undefined for a signal kept before signals kept their sender. */
          readonly sender: SignalSender | undefined;
        }
      | undefined
    >;
    /** Who sent the kept signal and when it came. Undefined when none is kept, or it kept neither. */
    readonly mailSender: (signalId: string) => Effect.Effect<SignalSender | undefined>;
    readonly mailDelete: (signalId: string) => Effect.Effect<void>;
    readonly mailExpire: Effect.Effect<void>;
    readonly run: (runId: string) => Effect.Effect<RunRow | undefined>;
    /** The run a workflow was started as under `key`, of whichever version. */
    readonly runByKey: (workflow: string, key: string) => Effect.Effect<RunRow | undefined>;
    readonly runs: (status: WorkflowRunStatus | undefined) => Effect.Effect<WorkflowRunListPage>;
    /** Runs by what they are a run of and what they were started as, newest first. */
    readonly runsWhere: (filter: RunsWhereFilter) => Effect.Effect<ReadonlyArray<RunSummaryRow>>;
    /** `runsWhere`, saying whether older runs were left out at the limit. */
    readonly runsWherePage: (
      filter: RunsWhereFilter,
    ) => Effect.Effect<Omit<WorkflowRunListPage, "skippedTruncated">>;
    /**
     * Runs `runsWherePage` for ordinary runs and top-level skipped runs in one snapshot, each with
     * its own cap.
     */
    readonly runsWhereApart: (
      filter: Omit<RunsWhereFilter, "skippedTopLevel" | "status">,
    ) => Effect.Effect<{
      readonly normal: Omit<WorkflowRunListPage, "skippedTruncated">;
      readonly skipped: Omit<WorkflowRunListPage, "skippedTruncated">;
    }>;
    readonly triggerNext: (triggerId: string) => Effect.Effect<string | undefined>;
    readonly triggerSet: (triggerId: string, nextAt: string) => Effect.Effect<void>;
    /** Forgets every trigger but these, so one that comes back starts over. */
    readonly triggerIds: Effect.Effect<ReadonlyArray<string>>;
    readonly triggersKeep: (triggerIds: ReadonlyArray<string>) => Effect.Effect<void>;
    /** The hook's token: the one kept for it, or `fresh` from now on. */
    readonly hookToken: (hookId: string, fresh: string) => Effect.Effect<string>;
    readonly steps: (runId: string) => Effect.Effect<ReadonlyArray<StepRow>>;
    /** Whether the run's step of that name waits for a place in a pool. */
    readonly queuesForPlace: (runId: string, name: string) => Effect.Effect<boolean>;
    /**
     * Keep that the run touched something: from a step, or with no step from what started it. A
     * later touch of the same thing keeps what it knows that is new and adds its step.
     */
    readonly referenceNoted: (
      runId: string,
      step: string | null,
      reference: ReferenceInput,
    ) => Effect.Effect<void>;
    /** What the run touched, in the order it first did. */
    readonly references: (runId: string) => Effect.Effect<ReadonlyArray<WorkflowRunReference>>;
    /**
     * Queues the step `name` for a place in `pool`, once, and gives out the places that are free.
     * Says whether this one holds its place now, and which others were given.
     */
    readonly placeAsked: (place: {
      readonly runId: string;
      readonly name: string;
      readonly pool: string;
      readonly size: number;
    }) => Effect.Effect<{ readonly held: boolean; readonly given: ReadonlyArray<PlaceRow> }>;
    /** The step is done with its place. */
    readonly placeLeft: (runId: string, name: string) => Effect.Effect<void>;
    /**
     * A resumed run asks again for the places its pause gave up, ahead of the queue. True when it
     * has to wait for one: it is then marked waiting, and whoever gives it the last goes on with it.
     */
    readonly placesBack: (runId: string) => Effect.Effect<boolean>;
    /** Whether the run waits for places it gave up when it paused. */
    readonly placesReturning: (runId: string) => Effect.Effect<boolean>;
    /** Gives out the places that are free, in every pool, and returns the places given. */
    readonly placesGiven: Effect.Effect<ReadonlyArray<PlaceRow>>;
    /** Places given to a queued step whose wait is still not woken: a crash lost the wake. */
    readonly placesUnwoken: Effect.Effect<ReadonlyArray<PlaceRow>>;
  }
>()("t3/workflows/WorkflowStore") {}

/** A place in a pool as it was given: `state` is what it was before, `queued` or `returning`. */
export interface PlaceRow {
  readonly seq: number | bigint;
  readonly pool: string;
  readonly run_id: string;
  readonly name: string;
  readonly state: "queued" | "returning";
}

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const changes = yield* PubSub.unbounded<string>();
  // A write here is bookkeeping for a run the engine already journaled: failing it would park a
  // healthy run, so a database that cannot take it is a defect of the process instead.
  const write = <A, E>(runId: string, effect: Effect.Effect<A, E>) =>
    effect.pipe(Effect.orDie, Effect.andThen(PubSub.publish(changes, runId)), Effect.asVoid);
  const waitColumns = sql`run_id, name, token, schema_json, request_json, watch_json, deadline, opened_at, woke_json`;
  const summaryColumns = sql`run_id, workflow, idempotency_key, version, engine_tag, title, status, detail, result_json, parent_run_id, parent_wait, pauses, held, tags_json, subject_json, started_at, updated_at, ended_at`;

  /**
   * A run's subject is also among what it touched: when a touch learns that thing's title or web
   * address, the subject the lists show learns it too. A title it has is replaced only by another.
   */
  const subjectLearned = Effect.fn("WorkflowStore.subjectLearned")(function* (
    runId: string,
    reference: { readonly kind: string; readonly key: string },
    title: string,
    url: string | null,
  ) {
    const rows = yield* sql<{ readonly subject_json: string }>`
      SELECT subject_json FROM workflow_runs
      WHERE run_id = ${runId} AND subject_kind = ${reference.kind}
        AND subject_key = ${reference.key}
    `;
    const row = rows[0];
    if (row === undefined) return;
    const held = subjectOf(row.subject_json);
    const next = {
      ...held,
      title: title === "" ? held.title : subjectTitle(title),
      url: held.url ?? url,
    };
    if (next.title === held.title && next.url === held.url) return;
    yield* sql`
      UPDATE workflow_runs SET subject_url = ${next.url}, subject_json = ${jsonText(next)}
      WHERE run_id = ${runId}
    `;
  });

  const hub = yield* Effect.serviceOption(MilestoneHub.MilestoneHub);
  /** Tells the milestone hub of a transition this store just wrote, under an id stable for it. */
  const tell = Effect.fn("WorkflowStore.tell")(function* (
    runId: string,
    key: string,
    at: string,
    news: WorkflowMilestoneNews,
  ) {
    if (Option.isNone(hub)) return;
    const [run] = yield* sql<Pick<RunRow, "workflow" | "title" | "parent_run_id">>`
      SELECT workflow, title, parent_run_id FROM workflow_runs WHERE run_id = ${runId}
    `.pipe(Effect.orDie);
    if (run === undefined) return;
    yield* hub.value.publish({
      id: MilestoneId.make(`${news.type}:${key}`),
      occurredAt: at,
      projectId: null,
      threadId: null,
      parentThreadId: null,
      actor: { type: "system" },
      isSubagentChild: run.parent_run_id !== null,
      workflowRunId: runId,
      workflow: run.workflow,
      runTitle: run.title,
      parentWorkflowRunId: run.parent_run_id,
      ...news,
    } as WorkflowMilestone);
  });
  const questionTitle = (wait: Pick<WaitRow, "name" | "request_json">) => {
    const request = wait.request_json === null ? null : jsonValue(wait.request_json);
    const title =
      request !== null && typeof request === "object" && !Array.isArray(request)
        ? (request as { readonly title?: unknown }).title
        : undefined;
    return typeof title === "string" && title.trim() !== "" ? title : wait.name;
  };
  /** A question claimed by an answer or its timeout is resolved, whichever claimed it. */
  const questionClaimed = Effect.fn("WorkflowStore.questionClaimed")(function* (
    runId: string,
    name: string,
    woke: Schema.Json,
    at: string,
  ) {
    if (Option.isNone(hub)) return;
    const [wait] = yield* sql<Pick<WaitRow, "request_json" | "opened_at">>`
      SELECT request_json, opened_at FROM workflow_waits WHERE run_id = ${runId} AND name = ${name}
    `.pipe(Effect.orDie);
    if (wait === undefined || wait.request_json === null) return;
    const claim =
      woke !== null && typeof woke === "object"
        ? (woke as { readonly expired?: unknown; readonly withdrawn?: unknown })
        : {};
    yield* tell(runId, `${runId}:${name}:${wait.opened_at}`, at, {
      type: "workflow.input_resolved",
      step: name,
      resolution:
        claim.withdrawn !== undefined
          ? "withdrawn"
          : claim.expired === true
            ? "expired"
            : "answered",
    });
  });

  // A request goes in while the pool holds fewer than its limit and than the smallest limit of
  // those inside; queued ones in the order they asked, the first to wait holding back the rest.
  // A resumed run goes ahead of them and takes back all its places, in every pool, or none: a run
  // that is not going holds nothing. A paused run is passed over. Run inside a transaction.
  const give = Effect.gen(function* () {
    const places = yield* sql<
      Omit<PlaceRow, "state"> & {
        readonly state: PlaceRow["state"] | "held";
        readonly size: number | bigint;
        readonly paused: number | bigint;
      }
    >`
      SELECT p.seq, p.pool, p.size, p.run_id, p.name, p.state, r.status = 'paused' AS paused
      FROM workflow_pool_places p JOIN workflow_runs r ON r.run_id = p.run_id
      WHERE p.state != 'away' ORDER BY p.seq
    `;
    /** Per pool, how many places are held and the smallest limit among them. */
    const inside = new Map<string, { n: number; limit: number }>();
    const room = (pool: string, n: number, limit: number) => {
      const now = inside.get(pool);
      return (now?.n ?? 0) + n <= Math.min(now?.limit ?? Infinity, limit);
    };
    const enter = (pool: string, n: number, limit: number) => {
      const now = inside.get(pool);
      inside.set(pool, { n: (now?.n ?? 0) + n, limit: Math.min(now?.limit ?? Infinity, limit) });
    };
    /** The places each resumed run waits to take back, runs in the order they first asked. */
    const returning = new Map<string, Array<(typeof places)[number]>>();
    for (const place of places) {
      if (place.state === "held") enter(place.pool, 1, Number(place.size));
      if (place.state !== "returning" || Number(place.paused) === 1) continue;
      returning.set(place.run_id, [...(returning.get(place.run_id) ?? []), place]);
    }
    const given: Array<PlaceRow> = [];
    const take = (place: (typeof places)[number], state: PlaceRow["state"]) =>
      given.push({
        seq: place.seq,
        pool: place.pool,
        run_id: place.run_id,
        name: place.name,
        state,
      });
    /** Pools without room for a resumed run or a queued request, which let nobody behind in. */
    const closed = new Set<string>();
    for (const [runId, back] of returning) {
      const wants = new Map<string, { n: number; limit: number }>();
      for (const place of back) {
        const want = wants.get(place.pool);
        wants.set(place.pool, {
          n: (want?.n ?? 0) + 1,
          limit: Math.min(want?.limit ?? Infinity, Number(place.size)),
        });
      }
      const short = [...wants].filter(([pool, want]) => !room(pool, want.n, want.limit));
      if (short.length === 0 && [...wants.keys()].every((pool) => !closed.has(pool))) {
        for (const [pool, want] of wants) enter(pool, want.n, want.limit);
        for (const place of back) take(place, "returning");
        returning.delete(runId);
        continue;
      }
      for (const [pool] of short) closed.add(pool);
    }
    for (const place of places) {
      if (place.state !== "queued" || Number(place.paused) === 1) continue;
      // Its run waits to come back, and would hold this place without going on.
      if (returning.has(place.run_id) || closed.has(place.pool)) continue;
      if (!room(place.pool, 1, Number(place.size))) {
        closed.add(place.pool);
        continue;
      }
      enter(place.pool, 1, Number(place.size));
      take(place, "queued");
    }
    for (const place of given) {
      yield* sql`UPDATE workflow_pool_places SET state = 'held' WHERE seq = ${place.seq}`;
    }
    return given;
  });

  const runsWherePage: WorkflowStore["Service"]["runsWherePage"] = Effect.fn(
    "WorkflowStore.runsWherePage",
  )(function* (filter) {
    const prefix = filter.keyPrefix ?? null;
    const prefixEnd = prefix === null ? null : prefixUpperBound(prefix);
    // Only the filters given, so SQLite can use an index for them.
    const where = sql.and([
      ...(filter.workflow === undefined ? [] : [sql`workflow = ${filter.workflow}`]),
      ...(filter.status === undefined ? [] : [sql`status = ${filter.status}`]),
      // A range, not LIKE, which would read `%` and `_` in a key as patterns.
      ...(prefix === null ? [] : [sql`idempotency_key >= ${prefix}`]),
      ...(prefixEnd === null ? [] : [sql`idempotency_key < ${prefixEnd}`]),
      ...(filter.skippedTopLevel === undefined
        ? []
        : filter.skippedTopLevel
          ? [sql`status = 'skipped' AND parent_run_id IS NULL`]
          : [sql`NOT (status = 'skipped' AND parent_run_id IS NULL)`]),
      ...(filter.tag === undefined
        ? []
        : [
            sql`EXISTS (SELECT 1 FROM json_each(r.tags_json) WHERE json_each.value = ${filter.tag})`,
          ]),
      ...(filter.subject === undefined
        ? []
        : typeof filter.subject === "string"
          ? [sql`(subject_url = ${filter.subject} OR subject_key = ${filter.subject})`]
          : [sql`subject_kind = ${filter.subject.kind} AND subject_key = ${filter.subject.key}`]),
      ...(filter.kind === undefined
        ? []
        : [
            sql`EXISTS (
                SELECT 1 FROM workflow_waits w
                WHERE w.run_id = r.run_id AND w.signalled_at IS NULL AND w.request_json IS NOT NULL
                  AND json_extract(w.request_json, '$.kind') = ${filter.kind}
              )`,
          ]),
    ]);
    const rows = yield* sql<RunSummaryRow>`
        SELECT ${summaryColumns} FROM workflow_runs r
        WHERE ${where}
        ORDER BY started_at DESC, rowid DESC LIMIT ${RUN_LIST_LIMIT + 1}
      `;
    return {
      rows: rows.slice(0, RUN_LIST_LIMIT),
      truncated: rows.length > RUN_LIST_LIMIT,
    };
  }, Effect.orDie);

  return WorkflowStore.of({
    placeAsked: Effect.fn("WorkflowStore.placeAsked")(function* (place) {
      const asked = yield* sql
        .withTransaction(
          Effect.gen(function* () {
            yield* sql`
              INSERT INTO workflow_pool_places (pool, size, run_id, name, state)
              SELECT ${place.pool}, ${place.size}, ${place.runId}, ${place.name}, 'queued'
              FROM workflow_runs WHERE run_id = ${place.runId} AND ended_at IS NULL
              ON CONFLICT (run_id, name) DO NOTHING
            `;
            const given = yield* give;
            // Read back, so asking again after a crash knows a place it was already given.
            const [own] = yield* sql<{ readonly state: string }>`
              SELECT state FROM workflow_pool_places
              WHERE run_id = ${place.runId} AND name = ${place.name}
            `;
            return {
              held: own?.state === "held",
              given: given.filter(
                (other) => other.run_id !== place.runId || other.name !== place.name,
              ),
            };
          }),
        )
        .pipe(Effect.orDie);
      yield* PubSub.publish(changes, place.runId);
      return asked;
    }),
    placeLeft: Effect.fn("WorkflowStore.placeLeft")(function* (runId, name) {
      yield* write(
        runId,
        sql`DELETE FROM workflow_pool_places WHERE run_id = ${runId} AND name = ${name}`,
      );
    }),
    placesBack: Effect.fn("WorkflowStore.placesBack")(function* (runId) {
      const at = yield* now;
      const back = yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const rows = yield* sql<{ readonly pool: string }>`
              UPDATE workflow_pool_places SET state = 'returning'
              WHERE run_id = ${runId} AND state = 'away'
              RETURNING pool
            `;
            const first = rows[0];
            if (first === undefined) return false;
            yield* sql`
              UPDATE workflow_runs
              SET status = 'waiting', detail = ${`queue ${first.pool}`}, updated_at = ${at}
              WHERE run_id = ${runId} AND ended_at IS NULL AND status != 'paused'
            `;
            return true;
          }),
        )
        .pipe(Effect.orDie);
      yield* PubSub.publish(changes, runId);
      return back;
    }),
    placesReturning: Effect.fn("WorkflowStore.placesReturning")(function* (runId) {
      const rows = yield* sql`
        SELECT 1 FROM workflow_pool_places WHERE run_id = ${runId} AND state = 'returning' LIMIT 1
      `.pipe(Effect.orDie);
      return rows.length > 0;
    }),
    placesGiven: Effect.gen(function* () {
      const given = yield* sql.withTransaction(give).pipe(Effect.orDie);
      for (const place of given) yield* PubSub.publish(changes, place.run_id);
      return given;
    }),
    placesUnwoken: sql<PlaceRow>`
      SELECT p.seq, p.pool, p.run_id, p.name, 'queued' AS state
      FROM workflow_pool_places p
      JOIN workflow_waits w ON w.run_id = p.run_id AND w.name = p.name
      WHERE p.state = 'held' AND w.signalled_at IS NULL
    `.pipe(Effect.orDie),
    changes,
    runStarted: Effect.fn("WorkflowStore.runStarted")(function* (run) {
      const at = yield* now;
      // A start under a key that already has its run changes nothing, and tells nobody.
      const inserted = yield* sql`
          INSERT INTO workflow_runs (
            run_id, workflow, version, engine_tag, idempotency_key, title, status, input_json,
            parent_run_id, parent_wait, started_at, updated_at
          ) VALUES (
            ${run.runId}, ${run.workflow}, ${run.version}, ${run.engineTag},
            ${run.idempotencyKey}, ${`${run.workflow} ${run.idempotencyKey}`}, 'running',
            ${jsonText(run.input)}, ${run.parent?.runId ?? null}, ${run.parent?.wait ?? null},
            ${at}, ${at}
          )
          ON CONFLICT DO NOTHING
          RETURNING run_id
        `.pipe(Effect.orDie);
      if (inserted.length === 0) return;
      yield* PubSub.publish(changes, run.runId);
      yield* tell(run.runId, run.runId, at, { type: "workflow.run_started" });
    }),
    runStatus: Effect.fn("WorkflowStore.runStatus")(function* (runId, status, detail) {
      const at = yield* now;
      yield* write(
        runId,
        sql`
          UPDATE workflow_runs
          SET status = ${status}, detail = ${detail}, updated_at = ${at}
          WHERE run_id = ${runId} AND ended_at IS NULL AND status != 'paused'
        `,
      );
    }),
    runResumed: Effect.fn("WorkflowStore.runResumed")(function* (runId) {
      const at = yield* now;
      // One statement, so two of them ending at once cannot leave the run on one that has ended.
      yield* write(
        runId,
        sql`
          WITH out AS (
            SELECT CASE
                WHEN kind IN ('agent', 'sleep') THEN kind || ' ' || name
                WHEN kind = 'queue' THEN 'queue ' || COALESCE(detail, name)
                ELSE name
              END AS detail
            FROM workflow_steps
            WHERE run_id = ${runId} AND status = 'running'
              AND kind IN ('wait', 'ask', 'agent', 'sleep', 'queue')
            ORDER BY started_at, rowid LIMIT 1
          )
          UPDATE workflow_runs
          SET status = CASE WHEN EXISTS (SELECT 1 FROM out) THEN 'waiting' ELSE 'running' END,
              detail = (SELECT detail FROM out), updated_at = ${at}
          WHERE run_id = ${runId} AND ended_at IS NULL AND status != 'paused'
        `,
      );
    }),
    runPaused: Effect.fn("WorkflowStore.runPaused")(function* (runId, detail, held) {
      const at = yield* now;
      const reason = detailCut(detail);
      const paused = yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const rows = yield* sql`
              UPDATE workflow_runs
              SET status = 'paused', detail = ${reason}, pauses = pauses + 1,
                held = ${held === undefined ? sql`held` : held ? 1 : 0}, updated_at = ${at}
              WHERE run_id = ${runId} AND ended_at IS NULL AND status != 'paused'
              RETURNING run_id
            `;
            // Nothing of a paused run goes on, so the places it holds go to the next in line.
            if (rows.length > 0) {
              yield* sql`
                UPDATE workflow_pool_places SET state = 'away'
                WHERE run_id = ${runId} AND state = 'held'
              `;
            }
            return rows;
          }),
        )
        .pipe(Effect.orDie);
      yield* PubSub.publish(changes, runId);
      if (paused.length > 0) {
        yield* tell(runId, `${runId}:${at}`, at, { type: "workflow.run_paused", reason });
      }
    }),
    runUnpaused: Effect.fn("WorkflowStore.runUnpaused")(function* (runId, current) {
      const at = yield* now;
      const rows = yield* sql`
        UPDATE workflow_runs SET status = 'running', detail = NULL, updated_at = ${at}
        WHERE run_id = ${runId} AND ended_at IS NULL AND status = 'paused'
          AND (${current === undefined ? 1 : 0} = 1
            OR (pauses = ${current?.pauses ?? 0} AND updated_at = ${current?.updatedAt ?? ""}))
        RETURNING run_id
      `.pipe(Effect.orDie);
      yield* PubSub.publish(changes, runId);
      if (rows.length === 0) return false;
      yield* tell(runId, `${runId}:${at}`, at, { type: "workflow.run_resumed" });
      return true;
    }),
    runUnheld: Effect.fn("WorkflowStore.runUnheld")(function* (runId) {
      // A pause since then set its own `held`.
      yield* write(
        runId,
        sql`UPDATE workflow_runs SET held = 0 WHERE run_id = ${runId} AND status != 'paused'`,
      );
    }),
    runEnded: Effect.fn("WorkflowStore.runEnded")(function* (runId, status, detail, result) {
      const at = yield* now;
      const resultJson = jsonText(result);
      // False when another outcome was recorded first: the run ended some other way.
      const ended = yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const rows = yield* sql`
              UPDATE workflow_runs
              SET status = ${status}, detail = ${detail}, result_json = ${resultJson},
                  pauses = 0, updated_at = ${at}, ended_at = ${at},
                  -- Only a cancelled run's cleanup reads it again; a skipped one has nothing to undo.
                  input_json = CASE
                    WHEN ${status} = 'skipped' AND parent_run_id IS NULL THEN NULL
                    ELSE input_json
                  END
              WHERE run_id = ${runId} AND ended_at IS NULL
              RETURNING run_id
            `;
            const closed = yield* sql<Pick<WaitRow, "name" | "request_json" | "opened_at">>`
              DELETE FROM workflow_waits WHERE run_id = ${runId}
              RETURNING name, request_json, opened_at
            `;
            if (rows.length > 0) {
              yield* sql`DELETE FROM workflow_pool_places WHERE run_id = ${runId}`;
            }
            return { ended: rows.length > 0, closed };
          }),
        )
        .pipe(Effect.orDie);
      yield* PubSub.publish(changes, runId);
      if (!ended.ended) return false;
      for (const wait of ended.closed) {
        if (wait.request_json === null) continue;
        yield* tell(runId, `${runId}:${wait.name}:${wait.opened_at}`, at, {
          type: "workflow.input_resolved",
          step: wait.name,
          resolution: "cancelled",
        });
      }
      yield* tell(runId, runId, at, { type: "workflow.run_ended", outcome: status, detail });
      return true;
    }),
    runTitle: Effect.fn("WorkflowStore.runTitle")(function* (runId, title) {
      const kept = title.slice(0, splitsSurrogatePair(title, 200) ? 199 : 200);
      yield* write(runId, sql`UPDATE workflow_runs SET title = ${kept} WHERE run_id = ${runId}`);
    }),
    runTags: Effect.fn("WorkflowStore.runTags")(function* (runId, tags) {
      yield* write(
        runId,
        sql`UPDATE workflow_runs SET tags_json = ${jsonText([...tags])} WHERE run_id = ${runId}`,
      );
    }),
    runSubject: Effect.fn("WorkflowStore.runSubject")(function* (runId, subject) {
      // What a step already learned of it stands in for what the workflow did not say.
      const known = (yield* sql<{ readonly title: string; readonly url: string | null }>`
        SELECT title, url FROM workflow_run_references
        WHERE run_id = ${runId} AND kind = ${subject.kind} AND key = ${subject.key}
      `.pipe(Effect.orDie))[0];
      const kept = {
        kind: subject.kind,
        key: subject.key,
        address: subject.address,
        title: subjectTitle(subject.title === "" ? (known?.title ?? "") : subject.title),
        url: subject.url ?? known?.url ?? null,
      } satisfies WorkflowRunSubject;
      yield* write(
        runId,
        sql`
          UPDATE workflow_runs
          SET subject_kind = ${kept.kind}, subject_key = ${kept.key}, subject_url = ${kept.url},
            subject_json = ${jsonText(kept)}
          WHERE run_id = ${runId}
        `,
      );
    }),
    stepStarted: Effect.fn("WorkflowStore.stepStarted")(function* (runId, name, kind) {
      const at = yield* now;
      const rows = yield* sql<{ attempts: number | bigint }>`
        INSERT INTO workflow_steps (run_id, name, kind, status, attempts, started_at)
        VALUES (${runId}, ${name}, ${kind}, 'running', 1, ${at})
        ON CONFLICT (run_id, name) DO UPDATE
        SET status = 'running', attempts = attempts + 1, detail = NULL, ended_at = NULL,
            started_at = excluded.started_at
        RETURNING attempts
      `.pipe(Effect.orDie);
      yield* PubSub.publish(changes, runId);
      return Number(rows[0]?.attempts ?? 1);
    }),
    stepEnded: Effect.fn("WorkflowStore.stepEnded")(function* (runId, name, status, detail) {
      const at = yield* now;
      yield* write(
        runId,
        sql.withTransaction(
          Effect.andThen(
            sql`
              UPDATE workflow_steps
              SET status = ${status}, detail = ${detail === null ? null : detailCut(detail)}, ended_at = ${at}
              WHERE run_id = ${runId} AND name = ${name}
            `,
            // A step that finished is progress: the next pause is the first in a row again.
            status === "completed"
              ? // Not while paused: a step beside the one that failed is no progress past it.
                sql`
                  UPDATE workflow_runs SET pauses = 0
                  WHERE run_id = ${runId} AND ended_at IS NULL AND status != 'paused'
                `
              : Effect.void,
          ),
        ),
      );
    }),
    waitOpened: Effect.fn("WorkflowStore.waitOpened")(function* (wait) {
      const at = yield* now;
      const opened = yield* sql`
        INSERT INTO workflow_waits (
          run_id, name, workflow, token, key, schema_json, request_json, watch_json, deadline,
          opened_at
        ) SELECT
          ${wait.runId}, ${wait.name}, ${wait.workflow}, ${wait.token}, ${wait.key ?? null},
          ${wait.schemaJson}, ${wait.requestJson}, ${wait.watchJson}, ${wait.deadline}, ${at}
        FROM workflow_runs WHERE run_id = ${wait.runId} AND ended_at IS NULL
        ON CONFLICT (run_id, name) DO NOTHING
        RETURNING name
      `.pipe(Effect.orDie);
      if (opened.length === 0) return;
      yield* PubSub.publish(changes, wait.runId);
      if (wait.requestJson === null) return;
      yield* tell(wait.runId, `${wait.runId}:${wait.name}:${at}`, at, {
        type: "workflow.needs_input",
        step: wait.name,
        question: questionTitle({ name: wait.name, request_json: wait.requestJson }),
      });
    }),
    waitClosed: Effect.fn("WorkflowStore.waitClosed")(function* (runId, name) {
      yield* write(
        runId,
        sql`DELETE FROM workflow_waits WHERE run_id = ${runId} AND name = ${name}`,
      );
    }),
    waitReopened: Effect.fn("WorkflowStore.waitReopened")(function* (runId, name, token) {
      yield* write(
        runId,
        sql`
          UPDATE workflow_waits SET token = ${token}, signalled_at = NULL, woke_json = NULL
          WHERE run_id = ${runId} AND name = ${name}
        `,
      );
    }),
    waitSignalled: Effect.fn("WorkflowStore.waitSignalled")(
      function* (runId, name, woke, signalId) {
        const at = yield* now;
        const taken = yield* sql`
          UPDATE workflow_waits SET signalled_at = ${at}, woke_json = ${jsonText(woke)}
          WHERE run_id = ${runId} AND name = ${name} AND signalled_at IS NULL
          RETURNING name
        `;
        if (taken.length > 0 && signalId !== undefined) {
          const receipt = yield* sql`
            INSERT INTO workflow_signals (signal_id, kept_until)
            VALUES (${signalId}, MAX(${yield* idsKeptUntil}, COALESCE(
              (SELECT expires_at FROM workflow_mail WHERE signal_id = ${signalId}), ''
            )))
            ON CONFLICT (signal_id) DO NOTHING
            RETURNING signal_id
          `;
          // The id already woke a wait, so this one is not claimed: the transaction undoes it.
          if (receipt.length === 0) return yield* Effect.fail("seen" as const);
        }
        return taken.length > 0;
      },
      (effect, runId, name, woke) =>
        sql.withTransaction(effect).pipe(
          Effect.catchIf(
            (error) => error === "seen",
            () => Effect.succeed(false),
          ),
          Effect.orDie,
          Effect.tap((taken) =>
            taken
              ? Effect.flatMap(now, (at) => questionClaimed(runId, name, woke, at))
              : Effect.void,
          ),
          // A paused run is not woken, so nothing else would tell a watcher the wait is taken.
          Effect.tap((taken) => (taken ? PubSub.publish(changes, runId) : Effect.void)),
        ),
    ),
    waitsToWake: Effect.gen(function* () {
      const before = DateTime.formatIso(
        DateTime.subtractDuration(yield* DateTime.now, WAKE_REDONE_AFTER),
      );
      return yield* sql<WaitRow>`
        SELECT ${waitColumns} FROM workflow_waits
        WHERE woke_json IS NOT NULL AND signalled_at <= ${before}
          AND run_id IN (SELECT run_id FROM workflow_runs WHERE ended_at IS NULL)
      `.pipe(Effect.orDie);
    }),
    waitsClaimed: Effect.fn("WorkflowStore.waitsClaimed")(function* (runId) {
      return yield* sql<WaitRow>`
        SELECT ${waitColumns} FROM workflow_waits WHERE run_id = ${runId} AND woke_json IS NOT NULL
      `.pipe(Effect.orDie);
    }),
    mailDeliver: Effect.fn("WorkflowStore.mailDeliver")(function* (signalId, runId, name, woke) {
      let at = "";
      const outcome = yield* sql
        .withTransaction(
          Effect.gen(function* () {
            at = yield* now;
            // A kept copy of an id that already woke a wait straight is spent: it is dropped, so
            // it wakes no second wait and is not offered again.
            const seen = yield* sql`SELECT 1 FROM workflow_signals WHERE signal_id = ${signalId}`;
            if (seen.length > 0) {
              yield* sql`DELETE FROM workflow_mail WHERE signal_id = ${signalId}`;
              return "gone" as const;
            }
            const claimed = yield* sql`
              UPDATE workflow_waits SET signalled_at = ${at}, woke_json = ${jsonText(woke)}
              WHERE run_id = ${runId} AND name = ${name} AND signalled_at IS NULL
              RETURNING name
            `;
            if (claimed.length === 0) return "claimed" as const;
            const taken = yield* sql<{ expires_at: string }>`
              DELETE FROM workflow_mail
              WHERE signal_id = ${signalId} AND expires_at > ${at} RETURNING expires_at
            `;
            // Failing undoes the claim: the wait stays open for a signal that is still there.
            const copy = taken[0];
            if (copy === undefined) return yield* Effect.fail("gone" as const);
            const keep = yield* idsKeptUntil;
            const receipt = yield* sql`
              INSERT INTO workflow_signals (signal_id, kept_until)
              VALUES (${signalId}, ${copy.expires_at > keep ? copy.expires_at : keep})
              ON CONFLICT (signal_id) DO NOTHING
              RETURNING signal_id
            `;
            // Delivered straight in the meantime: undone, and the next look drops the copy above.
            if (receipt.length === 0) return yield* Effect.fail("gone" as const);
            return "delivered" as const;
          }),
        )
        .pipe(
          Effect.catchIf(
            (error) => error === "gone",
            () => Effect.succeed("gone" as const),
          ),
          Effect.orDie,
        );
      if (outcome === "delivered") {
        yield* questionClaimed(runId, name, woke, at);
        yield* PubSub.publish(changes, runId);
      }
      return outcome;
    }),
    prunable: Effect.fn("WorkflowStore.prunable")(function* (before, limit) {
      return yield* sql<{ run_id: string; engine_tag: string }>`
        SELECT run_id, engine_tag FROM workflow_runs r
        WHERE ended_at IS NOT NULL AND ended_at < ${before} AND engine_pruned_at IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM workflow_steps s WHERE s.run_id = r.run_id AND s.status = 'running'
          )
        ORDER BY ended_at LIMIT ${limit}
      `.pipe(Effect.orDie);
    }),
    enginePruned: Effect.fn("WorkflowStore.enginePruned")(function* (runId) {
      const at = yield* now;
      yield* sql`
        UPDATE workflow_runs SET engine_pruned_at = ${at} WHERE run_id = ${runId}
      `.pipe(Effect.orDie);
    }),
    pruneSkipped: Effect.fn("WorkflowStore.pruneSkipped")(function* (kept, limit) {
      // Named, or SQLite picks the status index and reads every skipped run's row.
      const workflows = yield* sql<{ workflow: string }>`
        SELECT DISTINCT workflow FROM workflow_runs INDEXED BY workflow_runs_skipped
        WHERE status = 'skipped' AND parent_run_id IS NULL
      `;
      let deleted = 0;
      let last: string | undefined;
      // Each batch commits on its own, so a later failure must not hide the earlier deletions.
      return yield* Effect.gen(function* () {
        for (const { workflow } of workflows) {
          if (deleted >= limit) break;
          // rowid breaks ties: a burst of runs can share one started_at across the boundary.
          const [newest] =
            kept === 0
              ? [{ started_at: "\u{10FFFF}", id: 0 }]
              : yield* sql<{ started_at: string; id: number }>`
                  SELECT started_at, rowid AS id FROM workflow_runs
                  INDEXED BY workflow_runs_skipped
                  WHERE workflow = ${workflow} AND status = 'skipped' AND parent_run_id IS NULL
                  ORDER BY started_at DESC, rowid DESC LIMIT 1 OFFSET ${kept - 1}
                `;
          if (newest === undefined) continue;
          const ids = (yield* sql<{ run_id: string }>`
            SELECT run_id FROM workflow_runs r INDEXED BY workflow_runs_skipped
            WHERE workflow = ${workflow} AND status = 'skipped' AND parent_run_id IS NULL
              AND (started_at, rowid) < (${newest.started_at}, ${newest.id})
              AND ended_at IS NOT NULL AND engine_pruned_at IS NOT NULL
              AND NOT EXISTS (SELECT 1 FROM workflow_runs c WHERE c.parent_run_id = r.run_id)
            ORDER BY started_at, rowid LIMIT ${limit - deleted}
          `).map((row) => row.run_id);
          if (ids.length === 0) continue;
          yield* sql.withTransaction(
            Effect.gen(function* () {
              yield* sql`DELETE FROM workflow_steps WHERE ${sql.in("run_id", ids)}`;
              yield* sql`DELETE FROM workflow_marks WHERE ${sql.in("run_id", ids)}`;
              yield* sql`DELETE FROM workflow_run_references WHERE ${sql.in("run_id", ids)}`;
              yield* sql`DELETE FROM workflow_runs WHERE ${sql.in("run_id", ids)}`;
            }),
          );
          deleted += ids.length;
          last = ids.at(-1);
        }
        return deleted;
      }).pipe(
        Effect.ensuring(
          Effect.suspend(() => (last === undefined ? Effect.void : PubSub.publish(changes, last))),
        ),
      );
    }, Effect.orDie),
    orphans: sql<RunRow>`
      SELECT c.* FROM workflow_runs c
      JOIN workflow_runs p ON p.run_id = c.parent_run_id
      WHERE c.ended_at IS NULL AND p.status = 'cancelled'
    `.pipe(Effect.orDie),
    unfinished: sql<{ workflow: string; version: number | bigint }>`
      SELECT workflow, version FROM workflow_runs WHERE ended_at IS NULL
    `.pipe(
      Effect.map((rows) =>
        rows.map((row) => ({ workflow: row.workflow, version: Number(row.version) })),
      ),
      Effect.orDie,
    ),
    everyRun: Effect.fn("WorkflowStore.everyRun")(function* (status) {
      return yield* sql<RunRow>`SELECT * FROM workflow_runs WHERE status = ${status}`.pipe(
        Effect.orDie,
      );
    }),
    signalSeen: Effect.fn("WorkflowStore.signalSeen")(function* (signalId) {
      const rows = yield* sql`
        SELECT 1 FROM workflow_signals WHERE signal_id = ${signalId}
      `.pipe(Effect.orDie);
      return rows.length > 0;
    }),
    mark: Effect.fn("WorkflowStore.mark")(function* (runId, name) {
      const rows = yield* sql<{ count: number | bigint }>`
        INSERT INTO workflow_marks (run_id, name, count) VALUES (${runId}, ${name}, 1)
        ON CONFLICT (run_id, name) DO UPDATE SET count = count + 1
        RETURNING count
      `.pipe(Effect.orDie);
      return Number(rows[0]?.count ?? 1);
    }),
    children: Effect.fn("WorkflowStore.children")(function* (runId) {
      return yield* sql<RunRow>`
        SELECT * FROM workflow_runs WHERE parent_run_id = ${runId} AND ended_at IS NULL
      `.pipe(Effect.orDie);
    }),
    stepsCancelled: Effect.fn("WorkflowStore.stepsCancelled")(function* (runId, except) {
      const at = yield* now;
      yield* write(
        runId,
        sql`
          UPDATE workflow_steps SET status = 'failed', detail = 'cancelled', ended_at = ${at}
          WHERE run_id = ${runId} AND status = 'running' AND name != ${except}
        `,
      );
    }),
    runsToEnd: Effect.fn("WorkflowStore.runsToEnd")(function* (step, tries) {
      return yield* sql<
        RunRow & { end_attempts: number | bigint | null; end_ended_at: string | null }
      >`
        SELECT r.*, s.attempts AS end_attempts, s.ended_at AS end_ended_at
        FROM workflow_runs r
        LEFT JOIN workflow_steps s ON s.run_id = r.run_id AND s.name = ${step}
        WHERE r.status = 'cancelled'
          AND (s.status IS NULL OR (s.status != 'completed' AND s.attempts < ${tries}))
      `.pipe(Effect.orDie);
    }),
    cancelsCutShort: Effect.fn("WorkflowStore.cancelsCutShort")(function* (except) {
      return yield* sql<RunRow>`
        SELECT r.* FROM workflow_runs r
        WHERE r.status = 'cancelled' AND EXISTS (
          SELECT 1 FROM workflow_steps s
          WHERE s.run_id = r.run_id AND s.status = 'running' AND s.name != ${except}
        )
      `.pipe(Effect.orDie);
    }),
    // CROSS JOIN keeps the few open waits outside: SQLite would otherwise read every run.
    untold: sql<RunRow>`
      SELECT c.* FROM workflow_waits w
      CROSS JOIN workflow_runs c ON c.parent_run_id = w.run_id AND c.parent_wait = w.name
      WHERE w.signalled_at IS NULL AND c.ended_at IS NOT NULL
    `.pipe(Effect.orDie),
    stepThread: Effect.fn("WorkflowStore.stepThread")(
      function* (runId, name, threadId, environment, turnId) {
        yield* write(
          runId,
          sql`
          UPDATE workflow_steps
          SET thread_id = ${threadId}, environment_id = ${environment}, turn_id = ${turnId}
          WHERE run_id = ${runId} AND name = ${name}
        `,
        );
      },
    ),
    runningThreads: Effect.fn("WorkflowStore.runningThreads")(function* (runId) {
      const rows = yield* sql<{
        thread_id: string;
        environment_id: string | null;
        turn_id: string | null;
      }>`
        SELECT thread_id, environment_id, turn_id FROM workflow_steps
        WHERE run_id = ${runId} AND status = 'running' AND thread_id IS NOT NULL
      `.pipe(Effect.orDie);
      return rows.map((row) => ({
        threadId: row.thread_id,
        ...(row.environment_id === null ? {} : { environment: row.environment_id }),
        ...(row.turn_id === null ? {} : { turnId: row.turn_id }),
      }));
    }),
    waitAt: Effect.fn("WorkflowStore.waitAt")(function* (address) {
      const rows = yield* (
        "runId" in address
          ? sql<WaitRow>`
              SELECT ${waitColumns} FROM workflow_waits
              WHERE run_id = ${address.runId} AND name = ${address.wait} AND signalled_at IS NULL
            `
          : sql<WaitRow>`
              SELECT ${waitColumns} FROM workflow_waits
              WHERE workflow = ${address.workflow} AND key = ${address.channel} AND signalled_at IS NULL
              ORDER BY opened_at LIMIT 1
            `
      ).pipe(Effect.orDie);
      return rows[0];
    }),
    waitsOn: Effect.fn("WorkflowStore.waitsOn")(function* (key, workflow) {
      return yield* sql<WaitRow>`
        SELECT ${waitColumns} FROM workflow_waits
        WHERE key = ${key} AND signalled_at IS NULL
          AND (${workflow ?? null} IS NULL OR workflow = ${workflow ?? null})
        ORDER BY opened_at
      `.pipe(Effect.orDie);
    }),
    waitsPastDeadline: Effect.flatMap(now, (at) =>
      sql<WaitRow>`
        SELECT ${waitColumns} FROM workflow_waits
        WHERE deadline IS NOT NULL AND deadline <= ${at} AND signalled_at IS NULL
      `.pipe(Effect.orDie),
    ),
    latestThread: Effect.fn("WorkflowStore.latestThread")(function* (runId) {
      const rows = yield* sql<{ thread_id: string; environment_id: string | null }>`
        SELECT thread_id, environment_id FROM workflow_steps
        WHERE run_id = ${runId} AND thread_id IS NOT NULL
        ORDER BY started_at DESC, rowid DESC LIMIT 1
      `.pipe(Effect.orDie);
      const row = rows[0];
      return row === undefined
        ? null
        : { threadId: row.thread_id, environmentId: row.environment_id };
    }),
    counts: sql<{ questions: number; paused: number; active: number; total: number }>`
      SELECT
        (SELECT COUNT(*) FROM workflow_waits
          WHERE request_json IS NOT NULL AND signalled_at IS NULL) AS questions,
        (SELECT COUNT(*) FROM workflow_runs WHERE status = 'paused') AS paused,
        (SELECT COUNT(*) FROM workflow_runs WHERE ended_at IS NULL) AS active,
        (SELECT COUNT(*) FROM workflow_runs) AS total
    `.pipe(
      Effect.orDie,
      Effect.map((rows) => ({
        needsYou: Number(rows[0]?.questions ?? 0) + Number(rows[0]?.paused ?? 0),
        active: Number(rows[0]?.active ?? 0),
        total: Number(rows[0]?.total ?? 0),
      })),
    ),
    stepResult: Effect.fn("WorkflowStore.stepResult")(function* (runId, name, value, said) {
      const full = jsonText(value);
      const kept = full.length <= STEP_RESULT_KEPT ? full : jsonText(stepResultCut(full));
      const words = said?.trim() ?? "";
      const keptSaid =
        words === "" ? null : words.length <= STEP_RESULT_KEPT ? words : stepResultCut(words);
      yield* sql`
        UPDATE workflow_steps SET result_json = ${kept}, said = ${keptSaid}
        WHERE run_id = ${runId} AND name = ${name}
      `.pipe(Effect.orDie);
    }),
    stepDetail: Effect.fn("WorkflowStore.stepDetail")(function* (runId, name, detail) {
      yield* write(
        runId,
        sql`UPDATE workflow_steps SET detail = ${detail} WHERE run_id = ${runId} AND name = ${name}`,
      );
    }),
    requests: sql<WaitRow>`
      SELECT ${waitColumns} FROM workflow_waits
      WHERE request_json IS NOT NULL AND signalled_at IS NULL ORDER BY opened_at
    `.pipe(Effect.orDie),
    watches: sql<WaitRow>`
      SELECT ${waitColumns} FROM workflow_waits
      WHERE watch_json IS NOT NULL AND signalled_at IS NULL ORDER BY opened_at
    `.pipe(Effect.orDie),
    mailPut: Effect.fn("WorkflowStore.mailPut")(function* (mail) {
      yield* sql
        .withTransaction(
          Effect.andThen(
            sql`
              INSERT INTO workflow_mail (signal_id, address, value_json, expires_at, sender_json)
              VALUES (
                ${mail.signalId}, ${mailAddress(mail.address)}, ${mail.valueJson},
                ${mail.expiresAt}, ${senderText(mail.sender)}
              )
              ON CONFLICT (signal_id) DO NOTHING
            `,
            // A copy kept by a retry that raced the first delivery outlives no receipt of it.
            sql`
              UPDATE workflow_signals SET kept_until = ${mail.expiresAt}
              WHERE signal_id = ${mail.signalId} AND kept_until < ${mail.expiresAt}
            `,
          ),
        )
        .pipe(Effect.orDie);
    }),
    mailNext: Effect.fn("WorkflowStore.mailNext")(function* (addresses, passed = new Set()) {
      const at = yield* now;
      for (const address of addresses) {
        const rows = yield* sql<{
          signal_id: string;
          value_json: string;
          sender_json: string | null;
        }>`
          SELECT signal_id, value_json, sender_json FROM workflow_mail
          WHERE address = ${mailAddress(address)} AND expires_at > ${at} ORDER BY rowid
        `.pipe(Effect.orDie);
        const mail = rows.find((row) => !passed.has(row.signal_id));
        if (mail !== undefined) {
          return {
            signalId: mail.signal_id,
            valueJson: mail.value_json,
            address,
            sender: mail.sender_json === null ? undefined : senderOf(mail.sender_json),
          };
        }
      }
      return undefined;
    }),
    mailSender: Effect.fn("WorkflowStore.mailSender")(function* (signalId) {
      const rows = yield* sql<{ sender_json: string | null }>`
        SELECT sender_json FROM workflow_mail WHERE signal_id = ${signalId}
      `.pipe(Effect.orDie);
      const kept = rows[0]?.sender_json;
      return kept === undefined || kept === null ? undefined : senderOf(kept);
    }),
    mailDelete: Effect.fn("WorkflowStore.mailDelete")(function* (signalId) {
      yield* sql`DELETE FROM workflow_mail WHERE signal_id = ${signalId}`.pipe(Effect.orDie);
    }),
    mailExpire: Effect.gen(function* () {
      const at = yield* DateTime.now;
      yield* sql`DELETE FROM workflow_mail WHERE expires_at <= ${DateTime.formatIso(at)}`;
      yield* sql`DELETE FROM workflow_signals WHERE kept_until <= ${DateTime.formatIso(at)}`;
    }).pipe(Effect.orDie),
    run: Effect.fn("WorkflowStore.run")(function* (runId) {
      const rows = yield* sql<RunRow>`SELECT * FROM workflow_runs WHERE run_id = ${runId}`.pipe(
        Effect.orDie,
      );
      return rows[0];
    }),
    runByKey: Effect.fn("WorkflowStore.runByKey")(function* (workflow, key) {
      const rows = yield* sql<RunRow>`
        SELECT * FROM workflow_runs WHERE workflow = ${workflow} AND idempotency_key = ${key}
        ORDER BY started_at LIMIT 1
      `.pipe(Effect.orDie);
      return rows[0];
    }),
    runsWhere: Effect.fn("WorkflowStore.runsWhere")(function* (filter) {
      return (yield* runsWherePage(filter)).rows;
    }),
    runsWherePage,
    runsWhereApart: Effect.fn("WorkflowStore.runsWhereApart")(
      function* (filter) {
        return {
          normal: yield* runsWherePage({ ...filter, skippedTopLevel: false }),
          skipped: yield* runsWherePage({ ...filter, skippedTopLevel: true }),
        };
      },
      // Without one snapshot, a top-level run that skips itself between the two reads can appear
      // in both lists.
      (effect) => sql.withTransaction(effect).pipe(NodeSqliteClient.readOnly),
      Effect.orDie,
    ),
    runs: Effect.fn("WorkflowStore.runs")(
      function* (status) {
        if (status !== undefined) {
          const rows = yield* sql<RunSummaryRow>`
            SELECT ${summaryColumns} FROM workflow_runs WHERE status = ${status}
            ORDER BY started_at DESC, rowid DESC LIMIT ${RUN_LIST_LIMIT + 1}
          `;
          return {
            rows: rows.slice(0, RUN_LIST_LIMIT),
            truncated: rows.length > RUN_LIST_LIMIT,
          };
        }
        // Skipped runs are counted apart, so a trigger that skips most of what it brings does
        // not push the runs that did something out of the list. A paused run or one with a
        // question open is listed however old, since what waits on a person is built from it.
        // Fetching one row past each cap detects truncation without adding a query.
        const tagged = yield* sql<
          RunSummaryRow & { readonly part: number | bigint; readonly list_rowid: number | bigint }
        >`
          SELECT 0 AS part, list_rowid, ${summaryColumns} FROM (
            SELECT rowid AS list_rowid, ${summaryColumns} FROM workflow_runs
            WHERE NOT (status = 'skipped' AND parent_run_id IS NULL)
            ORDER BY started_at DESC, rowid DESC LIMIT ${RUN_LIST_LIMIT + 1}
          )
          UNION ALL
          SELECT 1 AS part, list_rowid, ${summaryColumns} FROM (
            SELECT rowid AS list_rowid, ${summaryColumns} FROM workflow_runs
            WHERE status = 'skipped' AND parent_run_id IS NULL
            ORDER BY started_at DESC, rowid DESC LIMIT ${RUN_LIST_LIMIT + 1}
          )
          UNION ALL
          SELECT 2 AS part, rowid AS list_rowid, ${summaryColumns} FROM workflow_runs
          WHERE status = 'paused' OR run_id IN (
            SELECT run_id FROM workflow_waits
            WHERE request_json IS NOT NULL AND signalled_at IS NULL
          )
        `;
        const normal: Array<RunSummaryRow & { readonly list_rowid: number | bigint }> = [];
        const skipped: Array<RunSummaryRow & { readonly list_rowid: number | bigint }> = [];
        const needsYou: Array<RunSummaryRow & { readonly list_rowid: number | bigint }> = [];
        for (const { part, ...row } of tagged) {
          if (Number(part) === 0) normal.push(row);
          else if (Number(part) === 1) skipped.push(row);
          else needsYou.push(row);
        }
        const needsYouIds = new Set(needsYou.map((row) => row.run_id));
        let truncated = false;
        if (normal.length > RUN_LIST_LIMIT) {
          const overflow = normal[RUN_LIST_LIMIT]!;
          if (!needsYouIds.has(overflow.run_id)) {
            truncated = true;
          } else {
            // The 501st row is itself listed by the Needs you branch; check if any non-Needs-you
            // run sits past the 500th row so a complete list is not reported as truncated.
            const cutoff = normal[RUN_LIST_LIMIT - 1]!;
            const omitted = yield* sql<{ readonly found: number | bigint }>`
              SELECT 1 AS found FROM workflow_runs
              WHERE NOT (status = 'skipped' AND parent_run_id IS NULL)
                AND (started_at, rowid) < (${cutoff.started_at}, ${cutoff.list_rowid})
                AND status != 'paused'
                AND run_id NOT IN (
                  SELECT run_id FROM workflow_waits
                  WHERE request_json IS NOT NULL AND signalled_at IS NULL
                )
              LIMIT 1
            `;
            truncated = omitted.length > 0;
          }
        }
        const byId = new Map<string, RunSummaryRow>();
        for (const { list_rowid: _rowid, ...row } of [
          ...normal.slice(0, RUN_LIST_LIMIT),
          ...skipped.slice(0, RUN_LIST_LIMIT),
          ...needsYou,
        ]) {
          if (!byId.has(row.run_id)) byId.set(row.run_id, row);
        }
        const rows = [...byId.values()].sort((left, right) =>
          left.started_at === right.started_at ? 0 : left.started_at < right.started_at ? 1 : -1,
        );
        return {
          rows,
          truncated,
          skippedTruncated: skipped.length > RUN_LIST_LIMIT,
        };
      },
      // The list and the check for runs it left out must read the same state.
      (effect) => sql.withTransaction(effect).pipe(NodeSqliteClient.readOnly),
      Effect.orDie,
    ),
    triggerNext: Effect.fn("WorkflowStore.triggerNext")(function* (triggerId) {
      const rows = yield* sql<{ next_at: string }>`
        SELECT next_at FROM workflow_triggers WHERE trigger_id = ${triggerId}
      `.pipe(Effect.orDie);
      return rows[0]?.next_at;
    }),
    triggerSet: Effect.fn("WorkflowStore.triggerSet")(function* (triggerId, nextAt) {
      yield* sql`
        INSERT INTO workflow_triggers (trigger_id, next_at) VALUES (${triggerId}, ${nextAt})
        ON CONFLICT (trigger_id) DO UPDATE SET next_at = excluded.next_at
      `.pipe(Effect.orDie);
    }),
    triggerIds: sql<{ trigger_id: string }>`SELECT trigger_id FROM workflow_triggers`.pipe(
      Effect.map((rows) => rows.map((row) => row.trigger_id)),
      Effect.orDie,
      Effect.withSpan("WorkflowStore.triggerIds"),
    ),
    triggersKeep: Effect.fn("WorkflowStore.triggersKeep")(function* (triggerIds) {
      const kept = yield* sql<{ trigger_id: string }>`SELECT trigger_id FROM workflow_triggers`;
      for (const { trigger_id } of kept) {
        if (triggerIds.includes(trigger_id)) continue;
        yield* sql`DELETE FROM workflow_triggers WHERE trigger_id = ${trigger_id}`;
      }
    }, Effect.orDie),
    hookToken: Effect.fn("WorkflowStore.hookToken")(function* (hookId, fresh) {
      yield* sql`
        INSERT INTO workflow_hooks (hook_id, token) VALUES (${hookId}, ${fresh})
        ON CONFLICT (hook_id) DO NOTHING
      `;
      const rows = yield* sql<{ token: string }>`
        SELECT token FROM workflow_hooks WHERE hook_id = ${hookId}
      `;
      return rows[0]?.token ?? fresh;
    }, Effect.orDie),
    queuesForPlace: Effect.fn("WorkflowStore.queuesForPlace")(function* (runId, name) {
      const rows = yield* sql`
        SELECT 1 FROM workflow_steps WHERE run_id = ${runId} AND name = ${name} AND kind = 'queue'
      `.pipe(Effect.orDie);
      return rows.length > 0;
    }),
    steps: Effect.fn("WorkflowStore.steps")(function* (runId) {
      // A resumed run waiting to take back a held place is queued at that step again, but the
      // places it takes back together do not queue behind each other.
      return yield* sql<StepRow>`
        SELECT s.name, s.kind,
               CASE WHEN back.seq IS NULL THEN s.status ELSE 'running' END AS status,
               s.attempts, s.detail, s.thread_id, s.environment_id, s.result_json, s.said,
               s.started_at, CASE WHEN back.seq IS NULL THEN s.ended_at END AS ended_at,
               CASE WHEN s.kind = 'queue' AND (s.status = 'running' OR back.seq IS NOT NULL) THEN (
                 SELECT COUNT(*) FROM workflow_pool_places me
                 JOIN workflow_pool_places other
                   ON other.pool = me.pool
                   AND ((other.state = 'returning' AND (me.state = 'queued'
                     OR (me.state = 'returning' AND other.run_id != me.run_id AND other.seq < me.seq)))
                     OR (other.state = 'queued' AND me.state = 'queued' AND other.seq < me.seq))
                 JOIN workflow_runs r ON r.run_id = other.run_id AND r.status != 'paused'
                 WHERE me.run_id = s.run_id AND me.name = s.name
               ) END AS ahead
        FROM workflow_steps s
        LEFT JOIN workflow_pool_places back
          ON s.kind = 'queue' AND back.run_id = s.run_id AND back.name = s.name
          AND back.state = 'returning'
        WHERE s.run_id = ${runId} ORDER BY s.started_at, s.rowid
      `.pipe(Effect.orDie);
    }),
    referenceNoted: Effect.fn("WorkflowStore.referenceNoted")(function* (runId, step, reference) {
      const at = yield* now;
      const addressJson = jsonText(reference.address);
      const title = reference.title.slice(
        0,
        splitsSurrogatePair(reference.title, REFERENCE_TITLE_KEPT)
          ? REFERENCE_TITLE_KEPT - 1
          : REFERENCE_TITLE_KEPT,
      );
      const changed = yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const rows = yield* sql<ReferenceRow>`
              SELECT kind, key, address_json, title, url, state, steps_json, origin
              FROM workflow_run_references
              WHERE run_id = ${runId} AND kind = ${reference.kind} AND key = ${reference.key}
            `;
            const row = rows[0];
            if (row === undefined) {
              yield* sql`
                INSERT INTO workflow_run_references (
                  run_id, kind, key, address_json, title, url, state, steps_json, origin, noted_at
                ) VALUES (
                  ${runId}, ${reference.kind}, ${reference.key}, ${addressJson}, ${title},
                  ${reference.url ?? null}, ${reference.state ?? null},
                  ${jsonText(step === null ? [] : [step])}, ${step === null ? "trigger" : "step"},
                  ${at}
                )
              `;
              yield* subjectLearned(runId, reference, title, reference.url ?? null);
              return true;
            }
            const steps = jsonValue(row.steps_json) as ReadonlyArray<string>;
            const next = {
              address_json: addressJson,
              title: title === "" ? row.title : title,
              url: reference.url ?? row.url,
              state: reference.state ?? row.state,
              steps_json:
                step === null || steps.includes(step) ? row.steps_json : jsonText([...steps, step]),
            };
            // A touch that says nothing new is no change, so a look every minute costs no list.
            if (
              next.address_json === row.address_json &&
              next.title === row.title &&
              next.url === row.url &&
              next.state === row.state &&
              next.steps_json === row.steps_json
            ) {
              return false;
            }
            yield* sql`
              UPDATE workflow_run_references
              SET address_json = ${next.address_json}, title = ${next.title}, url = ${next.url},
                  state = ${next.state}, steps_json = ${next.steps_json}
              WHERE run_id = ${runId} AND kind = ${reference.kind} AND key = ${reference.key}
            `;
            yield* subjectLearned(runId, reference, next.title, next.url);
            return true;
          }),
        )
        .pipe(Effect.orDie);
      if (changed) yield* PubSub.publish(changes, runId);
    }),
    references: Effect.fn("WorkflowStore.references")(function* (runId) {
      const rows = yield* sql<ReferenceRow>`
        SELECT kind, key, address_json, title, url, state, steps_json, origin
        FROM workflow_run_references WHERE run_id = ${runId} ORDER BY rowid
      `.pipe(Effect.orDie);
      return rows.map((row) => ({
        kind: row.kind,
        key: row.key,
        address: jsonValue(row.address_json),
        title: row.title,
        url: row.url,
        state: row.state,
        steps: jsonValue(row.steps_json) as ReadonlyArray<string>,
        origin: row.origin,
      }));
    }),
  });
});

export const layer = Layer.effect(WorkflowStore, make);
