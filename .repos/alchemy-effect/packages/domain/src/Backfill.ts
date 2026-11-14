import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Queue from "effect/Queue";
import * as Random from "effect/Random";
import * as Semaphore from "effect/Semaphore";
import { type ReplayInput, type ReplayResult, type Routed, routeLive } from "./CatchUp.ts";
import type { Delivery } from "./Platform.ts";

/**
 * Backfill: how a view or projection added after its sources recorded events
 * (or rebuilt by bumping its version) receives their history, in timestamp
 * order, without a central coordinator.
 *
 * Roles, each a durable object that owns its own storage:
 *
 * - **Directory nodes** form a tree (fan-out 16, one subtree per source) that
 *   lists every source instance. It is only an index: a run reads it.
 * - **A run** per consumer generation: its root lists the directory into
 *   subtrees and paces them through **relays**, each fanning out six ways,
 *   backing off when the account's load is refused. A consumer keyed by its
 *   source needs one pass; any other needs two, with a barrier between.
 * - **Sources** (aggregate instances, and view keys other consumers read)
 *   serve their stored rows on any code, and switch a consumer to live
 *   delivery once a reader has read all of them.
 * - **Scanners**, one per source instance and consumer generation, read its
 *   rows, route them with the consumer's code and push each key its part.
 * - **Consumer keys** (view keys, projection keys) buffer what they receive
 *   ordered by `(at, stream, seq)` and, told that every source's history is
 *   in, apply it in that order. A key keyed by its source reads its source's
 *   rows itself and applies them as it reads.
 *
 * Every step does a bounded amount of work, records its progress before it
 * answers, and is idempotent, so a crash, a retry or a redeploy at any point
 * resumes where it left off. Every continuation is a scheduled job, never a
 * nested call.
 *
 * @internal
 */

// ---------------------------------------------------------------- runtime

/** A key-ordered store, as a Durable Object's storage is. */
export interface Storage {
  readonly get: <A>(key: string) => Effect.Effect<A | undefined>;
  readonly put: (entries: Readonly<Record<string, unknown>>) => Effect.Effect<void>;
  readonly delete: (keys: ReadonlyArray<string>) => Effect.Effect<void>;
  /** Entries under `prefix`, in key order, after `startAfter`. */
  readonly list: <A>(options: {
    readonly prefix: string;
    readonly startAfter?: string;
    readonly limit?: number;
  }) => Effect.Effect<ReadonlyArray<readonly [string, A]>>;
  /** Run `effect` with every other call on this object held back. */
  readonly exclusive: <A, E>(effect: Effect.Effect<A, E>) => Effect.Effect<A, E>;
}

/** Durable, at-least-once jobs on one object: a job with the same id replaces a pending one. */
export interface Jobs {
  /**
   * Run job `id` after `afterMillis`. The earliest request wins: a job already due
   * sooner isn't postponed (every job is idempotent, so running early is safe),
   * including one asked for while that job runs.
   */
  readonly schedule: (id: string, afterMillis: number) => Effect.Effect<void>;
}

/** An instance listed in the directory: its source (aggregate or view) and id. */
export interface SourceRef {
  readonly source: string;
  readonly id: string;
  /**
   * A view key's generation, once its view has been rebuilt: each generation's
   * keys are their own objects, so this names the one that holds its entries.
   */
  readonly generation?: number;
}

/**
 * What a run needs to know of a consumer. The deploy that adds the consumer
 * passes it to the run, so the run never depends on what an object's code knows.
 */
export interface Plan {
  /** The sources (aggregates and views, by name) the consumer reads: the subtrees a run lists (all if absent). */
  readonly sources?: ReadonlyArray<string>;
  /** Each key reads one instance, the one with its own id: the leaf starts the keys itself. */
  readonly singleSource: boolean;
  /** The generation of each source that is a rebuilt view (see {@link SourceRef.generation}). */
  readonly generations?: Readonly<Record<string, number>>;
}

/** `ref` with its source's generation, by the plan. */
export const withGeneration = (ref: SourceRef, plan: Plan | undefined): SourceRef => {
  const generation = plan?.generations?.[ref.source];
  return generation === undefined || generation === 0 ? ref : { ...ref, generation };
};

export interface NodeRpc {
  readonly register: (path: string, ref: SourceRef) => Effect.Effect<void>;
  readonly child: (path: string, child: string) => Effect.Effect<void>;
  /**
   * A page of what a node lists: its own instances after `after`, and (on the
   * first page) its children. Any code answers it, whatever consumers it knows.
   */
  readonly list: (path: string, after: string | undefined) => Effect.Effect<Listing>;
}

/** A page of a directory node's listing. */
export interface Listing {
  readonly rows: ReadonlyArray<SourceRef>;
  readonly children: ReadonlyArray<string>;
  /** Where the next page starts, if there is one. */
  readonly next?: string;
}

export interface SourceRpc {
  /**
   * `cursor`, `log` and, at the end of the log, `handoff`, in one call: what a
   * reader of a short history needs. Older code doesn't have it: a reader falls
   * back to the three calls.
   */
  readonly read: (
    ref: SourceRef,
    target: string,
    key: string,
    after: number,
    limit: number,
  ) => Effect.Effect<Read>;
  /**
   * The last seq it routed live to `target`: a reader reads after it, since the
   * rows up to it reached their keys live. An instance with no cursors predates
   * catch-up: everything is live, up to its version.
   */
  readonly cursor: (ref: SourceRef, target: string) => Effect.Effect<number>;
  /**
   * Its stored rows (events, or a view key's entries) after `after`, as stored.
   * Any code answers it: nothing in it depends on the consumer asking.
   */
  readonly log: (
    ref: SourceRef,
    after: number,
    limit: number,
  ) => Effect.Effect<ReadonlyArray<unknown>>;
  /**
   * Route `target` live from now on, if the reader has read every row up to its
   * version (`through`): `"more"` if rows were added since, `"stale"` on code
   * without the target. `key` names the reader, for traces.
   */
  readonly handoff: (
    ref: SourceRef,
    target: string,
    key: string,
    through: number,
  ) => Effect.Effect<Handoff>;
}

/** What a source answers to `handoff`. */
export type Handoff = "live" | "more" | "stale";

/** What a reader gets from one `read`: rows after `from`, and at the end of the log, the handoff. */
export interface Read {
  /** Where it read from: after `after`, or where live routing stopped (for `after` 0). */
  readonly from: number;
  readonly rows: ReadonlyArray<unknown>;
  /** Fewer rows than asked for: the end of the log, and whether it switched the target to live there. */
  readonly handoff?: Handoff;
}

/** A page a key read from its source. */
export interface Pulled {
  readonly deliveries: ReadonlyArray<Delivery>;
  /** The source switched the key to live delivery: nothing more to read. */
  readonly live: boolean;
  /**
   * The last seq the source read for this page: the key's cursor moves past it,
   * even when those rows held nothing for the key.
   */
  readonly through?: number;
  /**
   * Nothing followed this page when it was read: the key reads again at once to
   * switch to live, rather than wait.
   */
  readonly end?: boolean;
}

export interface ConsumerRpc {
  /** History for a key, from a scanner: it buffers it until it is told every source's is in. */
  readonly push: (
    target: string,
    key: string,
    deliveries: ReadonlyArray<Delivery>,
  ) => Effect.Effect<void>;
  /**
   * Every source's history is with the key: apply it. `"settled"` once applied;
   * it works on it for up to `waitMillis` before it answers.
   */
  readonly ready: (
    target: string,
    key: string,
    waitMillis?: number,
  ) => Effect.Effect<"pending" | "settled">;
  /**
   * Start a key of a consumer keyed by its source: it reads `ref`'s log itself.
   * `"settled"` once it has its history: it works on it for up to `waitMillis`
   * before it answers.
   */
  readonly start: (
    target: string,
    key: string,
    ref: SourceRef,
    waitMillis?: number,
  ) => Effect.Effect<"pending" | "settled">;
}

/**
 * A scanner reads one source instance's log for a consumer, routes it with the
 * consumer's code, and pushes each key its history: one object per source
 * instance and consumer generation, new with the deploy.
 */
export interface ScannerRpc {
  /** Push every key its history from `ref`, up to now: `true` once done, after up to `waitMillis`. */
  readonly scan: (target: string, ref: SourceRef, waitMillis: number) => Effect.Effect<boolean>;
  /** Tell every key it pushed to that all history is in: `true` once each has applied it. */
  readonly ready: (target: string, ref: SourceRef, waitMillis: number) => Effect.Effect<boolean>;
  /** A commit found the target behind on `ref` with no reader: read it and push what is new. */
  readonly kick: (target: string, ref: SourceRef) => Effect.Effect<void>;
}

/** What a relay works through: directory nodes to list, and source instances. */
export type RelayItem = { readonly path: string } | { readonly ref: SourceRef };

/** A pass of a relay tree over the directory, for one consumer. */
export interface RelayRun {
  readonly target: string;
  readonly plan: Plan;
  /**
   * `discover`: start each key (keyed by its source), or scan each source;
   * `ready`: tell each source's keys that every source's history is in.
   */
  readonly phase: "discover" | "ready";
  /**
   * When the pass answers (epoch ms): each relay keeps at its items until then,
   * and answers `false` if not all of them are done. Now, for one try at everything.
   */
  readonly deadline: number;
}

export interface RelayRpc {
  /**
   * Work through `items` for a run, and answer `true` once all of it is done.
   * `name` is the relay's place in the tree: each one is its own object.
   */
  readonly run: (
    name: string,
    run: RelayRun,
    items: ReadonlyArray<RelayItem>,
  ) => Effect.Effect<RelayResult>;
}

/** What a relay answers: which of its items are done, and how many calls the account's load refused. */
export interface RelayResult {
  readonly done: ReadonlyArray<boolean>;
  readonly refused: number;
  /** Source instances done under it. */
  readonly instances?: number;
  /** A call it gave up on, and why. */
  readonly failure?: string;
}

/** How far a consumer's run has got: `ready` once every source's history is with its keys. */
export type Phase = "unknown" | "discover" | "ready" | "complete";

/** The root of a consumer's run: one object per consumer generation. */
export interface RunRpc {
  /**
   * Start the run, once. A run already started (or complete) is found, not
   * started again; one started with a different plan (the consumer reads other
   * sources now, without a version bump) answers `changed`.
   */
  readonly begin: (target: string, plan: Plan) => Effect.Effect<Begin>;
  readonly phase: (target: string) => Effect.Effect<Phase>;
  readonly progress: (target: string) => Effect.Effect<Progress>;
}

/** What starting a run answers. */
export type Begin =
  | { readonly status: "started" | "complete" }
  /** Started with another plan: it reads what `started` says, not what was asked. */
  | { readonly status: "changed"; readonly started: Plan };

/** Whether two plans read the same sources, at the same generations, the same way. */
export const samePlan = (a: Plan, b: Plan) => {
  const sources = (plan: Plan) =>
    plan.sources === undefined ? "*" : [...plan.sources].sort().join(",");
  const generations = (plan: Plan) =>
    Object.entries(plan.generations ?? {})
      .filter(([, generation]) => generation > 0)
      .sort(([x], [y]) => x.localeCompare(y))
      .map(([source, generation]) => `${source}#${generation}`)
      .join(",");
  return (
    a.singleSource === b.singleSource &&
    sources(a) === sources(b) &&
    generations(a) === generations(b)
  );
};

/**
 * Why a deploy can't wait on a run started with another plan: the consumer now
 * reads sources its run doesn't, and only a new generation reads them.
 */
export const planChanged = (target: string, started: Plan, asked: Plan) => {
  const list = (plan: Plan) =>
    plan.sources === undefined ? "every source" : plan.sources.join(", ");
  return `${target} now reads ${list(asked)}, but its backfill was started reading ${list(started)}. Bump its version to rebuild it from every source's history.`;
};

/** A consumer reads other sources than its backfill was started with, at the same version. */
export class PlanChanged extends Data.TaggedError("BackfillPlanChanged")<{
  readonly message: string;
}> {}

/** How far a run has got, for a deploy to report while it waits. */
export interface Progress {
  readonly target: string;
  readonly phase: Phase;
  /** The subtrees of the directory this phase works through, and how many are done. */
  readonly subtrees: number;
  readonly done: number;
  /** Source instances (keys keyed by their source, or scanners) done in this phase. */
  readonly instances: number;
  /** Passes over the directory so far: a pass that isn't done in time is followed by another. */
  readonly passes: number;
  /** Calls Cloudflare refused for the account's load: the run backs off when it does. */
  readonly refused: number;
  /** When the run began, and when it last moved, in epoch milliseconds. */
  readonly startedAt?: number;
  readonly updatedAt?: number;
  /** The last call it gave up on, if any, and why. */
  readonly lastError?: string;
}

/** How the roles reach each other. */
export interface Network {
  readonly node: NodeRpc;
  readonly source: SourceRpc;
  readonly consumer: ConsumerRpc;
  readonly scanner: ScannerRpc;
  readonly relay: RelayRpc;
  readonly run: RunRpc;
}

/** Tuning, in rows and calls per step. */
export interface Limits {
  /** History rows a reader (a key keyed by its source, or a scanner) reads per call. */
  readonly page: number;
  /** Source instances a directory node handles per step, and calls it makes at once. */
  readonly nodePage: number;
  readonly concurrency: number;
  /** Buffered rows a key applies per step. */
  readonly apply: number;
  /** How long to wait before calling a stale source again, in milliseconds. */
  readonly staleRetryMillis: number;
  /**
   * How long before the first retry of a refused or failed call, in milliseconds:
   * right after a deploy its new code may not have reached the object yet.
   */
  readonly firstRetryMillis: number;
  /** How long a key without sources waits before asking whether discovery is complete again. */
  readonly pollMillis: number;
  /**
   * Instances a directory node lists before it splits into 16 children, so every
   * node's share of a listing stays bounded and the tree grows as log16 of the instances.
   */
  readonly leafSize: number;
  /** The depth instances list themselves at, before any split. */
  readonly depth: number;
}

/**
 * The depth instances list themselves at: 256 leaves, each splitting once it
 * fills. Wide enough that first commits spread over many objects, few enough
 * that a small Domain's directory stays small (every node costs a listing).
 */
export const DEPTH = 2;

export const defaultLimits: Limits = {
  // A long history arrives in few round trips: each one costs more than its rows.
  page: 1_000,
  nodePage: 25,
  concurrency: 5,
  apply: 200,
  staleRetryMillis: 30_000,
  firstRetryMillis: 1_000,
  pollMillis: 5_000,
  leafSize: 256,
  depth: DEPTH,
};

// ---------------------------------------------------------------- keys

const enc = encodeURIComponent;
const pad = (n: number, width: number) => String(Math.max(0, Math.floor(n))).padStart(width, "0");

/** Log a protocol step at debug level (`backfill <step>` and a JSON body), to follow a backfill. */
const trace = (step: string, fields: Record<string, unknown>) =>
  Effect.logDebug(`backfill ${step} ${JSON.stringify(fields)}`);

/**
 * The directory has one subtree per source (`Account:`, `Deposits:`), so a run
 * for a consumer walks only the sources it reads. Within a subtree a node's path
 * is the source, a colon and a prefix of the instance's hash: `Account:a3`.
 */
export const leafOf = (ref: SourceRef, depth: number = DEPTH): string =>
  `${ref.source}:${hashOf(ref).slice(0, depth)}`;

/** The hash digits of a path: its depth within its source's subtree. */
const digitsOf = (path: string) => path.slice(path.indexOf(":") + 1);

/** The source a node's subtree lists, or `undefined` for the root (and news relays). */
export const sourceOfPath = (path: string): string | undefined => {
  const colon = path.indexOf(":");
  return colon < 0 ? undefined : path.slice(0, colon);
};

/** The FNV-1a hash of an instance's source and id, as 8 hex digits: its path in the tree. */
const hashOf = ({ source, id }: SourceRef): string => {
  let hash = 0x811c9dc5;
  for (const char of `${source}/${id}`) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  // FNV-1a barely moves the high bits for ids that differ in their last characters
  // (`b0`, `b1`, …): mix them in (murmur3's finalizer), so the tree fills evenly.
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x85ebca6b);
  hash ^= hash >>> 13;
  hash = Math.imul(hash, 0xc2b2ae35);
  hash ^= hash >>> 16;
  return (hash >>> 0).toString(16).padStart(8, "0");
};

/** The child of a split node that lists an instance: one more hex digit of its hash. */
const childFor = (path: string, ref: SourceRef) =>
  `${ref.source}:${hashOf(ref).slice(0, digitsOf(path).length + 1)}`;

/** A source's subtree (`Account:`) hangs off the root; a news relay (`a3`) climbs by digit. */
const parentOf = (path: string) => (path.endsWith(":") ? "" : path.slice(0, -1));
const refKey = (ref: SourceRef) => `${enc(ref.source)}:${enc(ref.id)}`;

/** A buffered delivery's place in a key's merge: timestamp, then stream, then seq. */
export const orderKey = (target: string, delivery: Delivery) =>
  `bf:b:${enc(target)}:${pad(delivery.envelope.at, 15)}:${enc(delivery.source)}:${pad(delivery.seq, 12)}`;

// ---------------------------------------------------------------- outbox

type Message =
  /** Start the key of a consumer keyed by its source, which no run started. */
  | {
      readonly kind: "start";
      readonly target: string;
      readonly key: string;
      readonly ref: SourceRef;
    }
  /** Ask a scanner to read a source instance no run read. */
  | { readonly kind: "kick"; readonly target: string; readonly ref: SourceRef };

const OUTBOX_LEASE_MS = 60_000;

/**
 * How long before a failed send is tried again: past the ~20s a Durable Object
 * must sit idle before it leaves the code it ran before a deploy, so retries to
 * one still on older code don't keep it there.
 */
const RETRY_MS = 30_000;

/** Instances a directory node lists per page. */
const LIST_PAGE = 512;

/** How long a key started with a wait pauses between pages that couldn't go further. */
const WAIT_PAUSE_MS = 50;

/**
 * Cloudflare refuses calls when an account puts too much load on Durable
 * Objects, and resets an isolate whose objects (many share one) use too much
 * memory. Either is a sign to send less: a refused call is tried again later,
 * not at once, so a wide run backs off to the load the account can take
 * rather than collapse under its own retries.
 */
export const overloaded = (cause: Cause.Cause<unknown>) => {
  const error = Cause.squash(cause);
  return /too much load|too many concurrent|overloaded|try again later|exceeded its memory limit/i.test(
    Predicate.hasProperty(error, "message") ? String(error.message) : String(error),
  );
};

/** A wait after `failures` failures in a row: doubling from `base`, up to `max`, jittered. */
const backoff = (failures: number, base: number, max: number) =>
  Effect.map(Random.next, (jitter) =>
    Math.round(Math.min(max, base * 2 ** Math.max(0, failures - 1)) * (0.5 + jitter)),
  );

/** A key's pause between pages: short while it makes progress, backing off while calls fail. */
const pause = (failures: number) =>
  failures === 0 ? Effect.succeed(WAIT_PAUSE_MS) : backoff(failures, 250, 5_000);

/**
 * Run a job again after a refusal or a failure, waiting twice as long each time:
 * from `firstRetryMillis`, so a one-off failure (or a deploy's code still on its
 * way to an object) costs seconds, up to four times the slow pace. Cloudflare moves
 * a Durable Object to new code when it is evicted after sitting idle: calls at a
 * short, fixed pace would keep one on older code, so the gaps grow until it can.
 */
const makeRetry = (storage: Storage, jobs: Jobs, limits: Limits) => {
  const key = (id: string) => `bf:retry:${id}`;
  return {
    later: (id: string, slowMillis: number) =>
      Effect.gen(function* () {
        const tries = (yield* storage.get<number>(key(id))) ?? 0;
        yield* storage.put({ [key(id)]: tries + 1 });
        yield* jobs.schedule(
          id,
          Math.min(slowMillis * 4, limits.firstRetryMillis * 2 ** Math.min(tries, 20)),
        );
      }),
    /** The job went through: its next failure retries soon again. */
    clear: (id: string) =>
      Effect.gen(function* () {
        if ((yield* storage.get(key(id))) !== undefined) yield* storage.delete([key(id)]);
      }),
  };
};
type Retry = ReturnType<typeof makeRetry>;

/** A call that counts as lost if it hasn't answered in time: a hung call would stall its caller. */
const bounded = <A, E>(call: Effect.Effect<A, E>) => call.pipe(Effect.timeout("20 seconds"));

/** Where `ref`'s live routing to `target` stopped; 0 (read it all) if it can't say (older code). */
const cursorOf = (net: Network, ref: SourceRef, target: string) =>
  bounded(net.source.cursor(ref, target)).pipe(Effect.catchCause(() => Effect.succeed(0)));

/**
 * Read a page of `ref`'s log for `target` in one call (see `SourceRpc.read`).
 * A source on older code has no `read`: fall back to `cursor` and `log`, and
 * the caller asks for the handoff itself. A call the account's load refused
 * fails, for the caller to back off.
 */
const readAt = (
  net: Network,
  ref: SourceRef,
  target: string,
  key: string,
  after: number,
  limit: number,
): Effect.Effect<Read, unknown> =>
  bounded(net.source.read(ref, target, key, after, limit)).pipe(
    Effect.catchCauseIf(
      (cause) => !overloaded(cause),
      () =>
        Effect.gen(function* () {
          const from = after > 0 ? after : yield* cursorOf(net, ref, target);
          const rows = yield* bounded(net.source.log(ref, from, limit));
          return { from, rows } satisfies Read;
        }),
    ),
  );

/** A target's generation: `view:Name#2` is 2. */
const generationOf = (target: string) => Number(/[#@](\d+)$/.exec(target)?.[1] ?? 0);

/** Refused by an instance still on older code; the sender tries again later. */
class Stale extends Data.TaggedError("Stale")<{ readonly message: string }> {}

/**
 * A source's durable outbox of control messages: staged with the state change
 * that produced them, sent in order, deleted once sent. One flush at a time.
 */
const outbox = (storage: Storage, jobs: Jobs, net: Network, retry: Retry) => {
  const send = (message: Message): Effect.Effect<void> =>
    message.kind === "start"
      ? Effect.asVoid(net.consumer.start(message.target, message.key, message.ref))
      : net.scanner.kick(message.target, message.ref);
  const acquire = storage.exclusive(
    Effect.gen(function* () {
      const held = yield* storage.get<number>("bf:q-lease");
      const now = yield* Effect.sync(() => Date.now());
      if (held !== undefined && held > now) return false;
      yield* storage.put({ "bf:q-lease": now + OUTBOX_LEASE_MS });
      return true;
    }),
  );
  /** Send every staged message; `true` when the outbox is empty. */
  const flush: Effect.Effect<boolean> = Effect.gen(function* () {
    // Nothing staged: no lease to take.
    if ((yield* storage.list({ prefix: "bf:q:", limit: 1 })).length === 0) return true;
    // Another flush holds the lease; it may stop before this one's rows: try again later.
    if (!(yield* acquire)) return yield* Effect.as(jobs.schedule("bf-flush", RETRY_MS), false);
    return yield* Effect.gen(function* () {
      while (true) {
        const rows = yield* storage.list<Message>({ prefix: "bf:q:", limit: 50 });
        if (rows.length === 0) {
          yield* retry.clear("bf-flush");
          return true;
        }
        for (const [key, message] of rows) {
          yield* send(message);
          yield* storage.delete([key]);
        }
      }
    }).pipe(
      // A send failed: the rest stay staged, and the backstop sends them later.
      Effect.catchCause(() => Effect.as(retry.later("bf-flush", RETRY_MS), false)),
      Effect.ensuring(storage.delete(["bf:q-lease"])),
    );
  });
  return {
    /** Stage messages; call inside the exclusive section that commits their cause. */
    stage: (messages: ReadonlyArray<Message>) =>
      Effect.gen(function* () {
        if (messages.length === 0) return;
        const last = ((yield* storage.get<number>("bf:q-seq")) ?? 0) + messages.length;
        const rows: Record<string, Message> = { "bf:q-seq": last as never };
        messages.forEach((message, index) => {
          rows[`bf:q:${pad(last - messages.length + index + 1, 12)}`] = message;
        });
        yield* storage.put(rows);
        // The backstop: sent even if this instance dies before a flush runs.
        yield* jobs.schedule("bf-flush", 5_000);
      }),
    flush,
  };
};

// ---------------------------------------------------------------- sources

/** What a source instance gives the protocol. */
export interface SourceHost {
  readonly ref: SourceRef;
  /** Every consumer in the model this instance's code runs: a target outside it is from newer code. */
  readonly model: () => ReadonlyArray<string>;
  /** Whether `target`'s keys are keyed by their source: each reads its own source's log. */
  readonly singleSource?: (target: string) => boolean;
  /** Its current version: the seq of its last event or entry. */
  readonly version: Effect.Effect<number>;
  readonly routed: Effect.Effect<Routed | undefined>;
  /** Route `target` live from the current version on. Called holding the exclusive section. */
  readonly markLive: (target: string) => Effect.Effect<void>;
  /** Its stored rows after `after`, as stored: what a reader routes with its own code. */
  readonly log: (after: number, limit: number) => Effect.Effect<ReadonlyArray<unknown>>;
}

/**
 * A source instance's part of the protocol: it serves its log as stored, on
 * any code, and switches a target to live delivery once a reader has read all
 * of it. Until then a commit withholds the target's deliveries (the reader
 * reads them from the log). The first commit to withhold them on code that
 * knows the target asks for a reader: an instance no run listed (one created
 * on older code during a rollout) is caught up that way.
 */
export const makeSource = (
  storage: Storage,
  jobs: Jobs,
  net: Network,
  host: SourceHost,
  limits: Limits = defaultLimits,
) => {
  const retry = makeRetry(storage, jobs, limits);
  const queue = outbox(storage, jobs, net, retry);
  const kickedKey = (target: string) => `bf:kick:${enc(target)}`;

  const fromKey = (target: string) => `bf:from:${enc(target)}`;

  /**
   * Where live routing to `target` stopped (see `SourceRpc.cursor`), as it was
   * when its reader first asked: kept, so a reader that asks again (its answer
   * lost after the source went live) starts at the same row, not past it.
   */
  const cursor = (target: string) =>
    storage.exclusive(
      Effect.gen(function* () {
        const kept = yield* storage.get<number>(fromKey(target));
        if (kept !== undefined) return kept;
        const routed = yield* host.routed;
        const from = routed === undefined ? yield* host.version : (routed[target] ?? 0);
        yield* storage.put({ [fromKey(target)]: from });
        return from;
      }),
    );

  const handoff = (target: string, key: string, through: number) =>
    Effect.gen(function* () {
      if (!host.model().includes(target)) return "stale" as Handoff;
      const result = yield* storage.exclusive(
        Effect.gen(function* () {
          // Rows were added after the reader read up to `through`: it reads them first.
          if ((yield* host.version) > through) return "more" as const;
          const routed = yield* host.routed;
          if (routed !== undefined && (routed[target] ?? 0) < through) yield* host.markLive(target);
          yield* storage.delete([kickedKey(target)]);
          return "live" as const;
        }),
      );
      yield* trace("handoff", { source: host.ref, target, key, through, result });
      return result as Handoff;
    });

  return {
    /**
     * A commit withheld `target`'s deliveries: it is behind here. Ask for a
     * reader, once. Call inside the commit's exclusive section.
     */
    onCommit: (target: string) =>
      Effect.gen(function* () {
        if ((yield* storage.get(kickedKey(target))) !== undefined) return;
        yield* storage.put({ [kickedKey(target)]: true });
        yield* queue.stage([
          host.singleSource?.(target) === true
            ? { kind: "start", target, key: host.ref.id, ref: host.ref }
            : { kind: "kick", target, ref: host.ref },
        ]);
      }),

    log: (after: number, limit: number) => host.log(after, limit),

    cursor: (target: string) => cursor(target),

    read: (target: string, key: string, after: number, limit: number) =>
      Effect.gen(function* () {
        const from = after > 0 ? after : yield* cursor(target);
        const rows = yield* host.log(from, limit);
        if (rows.length >= limit) return { from, rows } satisfies Read;
        // Rows are numbered without gaps: these end at `from + rows.length`.
        return {
          from,
          rows,
          handoff: yield* handoff(target, key, from + rows.length),
        } satisfies Read;
      }),

    handoff: (target: string, key: string, through: number) => handoff(target, key, through),

    /** The backstop job: send what is staged. */
    flush: Effect.asVoid(queue.flush),
  };
};

export type Source = ReturnType<typeof makeSource>;

// ---------------------------------------------------------------- scanners

/** What a scanner gives the protocol: the consumer's routing, in the code it runs. */
export interface ScannerHost {
  /** Route a source's stored rows (from its `log`) to `target`: each row's seq and its deliveries. */
  readonly route: (
    target: string,
    ref: SourceRef,
    rows: ReadonlyArray<unknown>,
  ) => Effect.Effect<
    ReadonlyArray<{ readonly seq: number; readonly deliveries: ReadonlyArray<Delivery> }>
  >;
}

/** A scanner's progress through one source instance, for one target. */
interface ScanState {
  readonly ref: SourceRef;
  /** It has asked the source where live routing stopped, and starts there. */
  readonly started?: boolean;
  /** Every row up to this seq is with its keys. */
  readonly through: number;
  /** Read to the end of the log at least once: the history a run waits for is with its keys. */
  readonly scanned: boolean;
  /** The source routes the target live: nothing more to read. */
  readonly live: boolean;
  /**
   * Past the run's barrier: keys it pushes to from now on are told at once that
   * all history is in (no pass will tell them).
   */
  readonly readied?: boolean;
  /** Started by a commit, not a run: it asks the run whether it is past the barrier. */
  readonly kicked?: boolean;
}

/**
 * A scanner: reads one source instance's log, as stored, routes it with the
 * consumer's code, and pushes each key the deliveries it gets. At the end of
 * the log it asks the source to route the target live from there; a source
 * still on older code can't, so the scanner reads on later (what it reads then
 * is newer than the deploy, and arrives as live deliveries would).
 */
export const makeScanner = (
  storage: Storage,
  jobs: Jobs,
  net: Network,
  host: ScannerHost,
  limits: Limits = defaultLimits,
) => {
  const retry = makeRetry(storage, jobs, limits);
  const stateKey = (target: string) => `bf:sc:${enc(target)}`;
  const keysPrefix = (target: string) => `bf:sk:${enc(target)}:`;
  const jobId = (target: string) => `bf-scan:${target}`;
  const getState = (target: string) => storage.get<ScanState>(stateKey(target));

  /** Start where the source's live routing stopped: the keys have every row before it. */
  const start = (target: string, state: ScanState) =>
    Effect.gen(function* () {
      const cursor = yield* cursorOf(net, state.ref, target);
      return yield* storage.exclusive(
        Effect.gen(function* () {
          const current = (yield* getState(target)) ?? state;
          if (current.started) return current;
          const started = { ...current, started: true, through: Math.max(current.through, cursor) };
          yield* storage.put({ [stateKey(target)]: started });
          return started;
        }),
      );
    });

  /** Whether the run is past its barrier, as far as this scanner knows (it asks only if a commit started it). */
  const pastBarrier = (target: string, state: ScanState) =>
    Effect.gen(function* () {
      if (state.readied) return true;
      if (!state.kicked) return false;
      const phase = yield* net.run.phase(target);
      if (phase !== "ready" && phase !== "complete") return false;
      yield* storage.exclusive(
        Effect.gen(function* () {
          const current = yield* getState(target);
          if (current !== undefined && !current.readied)
            yield* storage.put({ [stateKey(target)]: { ...current, readied: true } });
        }),
      );
      return true;
    });

  const init = (target: string, ref: SourceRef, kicked = false) =>
    storage.exclusive(
      Effect.gen(function* () {
        const state = yield* getState(target);
        if (state !== undefined) return state;
        const fresh: ScanState = {
          ref,
          through: 0,
          scanned: false,
          live: false,
          ...(kicked ? { kicked } : {}),
        };
        yield* storage.put({ [stateKey(target)]: fresh });
        return fresh;
      }),
    );

  /**
   * One step: read and push a page, or at the end of the log, ask the source
   * to route the target live. `pushed` once the history up to now is with its
   * keys; `next` says whether to step again now, later (the source is on older
   * code), or never (it routes the target live).
   */
  const step = (
    target: string,
  ): Effect.Effect<{ readonly pushed: boolean; readonly next: "now" | "later" | "never" }> =>
    Effect.gen(function* () {
      const found = yield* getState(target);
      if (found === undefined || found.live) return { pushed: true, next: "never" } as const;
      const state = found.started ? found : yield* start(target, found);
      const rows = yield* bounded(net.source.log(state.ref, state.through, limits.page)).pipe(
        Effect.orDie,
      );
      if (rows.length > 0) {
        const routed = yield* host.route(target, state.ref, rows);
        const through = routed.length > 0 ? routed[routed.length - 1]!.seq : state.through;
        const byKey = new Map<string, Array<Delivery>>();
        for (const row of routed)
          for (const delivery of row.deliveries) {
            const list = byKey.get(delivery.key) ?? [];
            list.push(delivery);
            byKey.set(delivery.key, list);
          }
        yield* Effect.forEach(
          byKey,
          ([key, deliveries]) =>
            bounded(net.consumer.push(target, key, deliveries)).pipe(Effect.orDie),
          { concurrency: limits.concurrency, discard: true },
        );
        // The keys first, so a `ready` pass lists them; then, past the barrier (which no
        // pass will tell them of), tell them here; only then move past these rows, so a
        // step that fails telling them reads and tells them again. (`ready` marks the
        // state before it lists keys, so a key is told by one or the other.)
        const keys: Record<string, true> = {};
        for (const key of byKey.keys()) keys[`${keysPrefix(target)}${enc(key)}`] = true;
        yield* storage.exclusive(storage.put(keys));
        const current = yield* getState(target);
        if (current === undefined || current.through !== state.through)
          return { pushed: state.scanned, next: "now" } as const;
        if (yield* pastBarrier(target, current))
          yield* Effect.forEach(
            byKey.keys(),
            (key) => bounded(net.consumer.ready(target, key, 0)).pipe(Effect.orDie),
            { concurrency: limits.concurrency, discard: true },
          );
        yield* storage.exclusive(
          Effect.gen(function* () {
            const latest = yield* getState(target);
            if (latest !== undefined && latest.through === state.through)
              yield* storage.put({ [stateKey(target)]: { ...latest, through } });
          }),
        );
        if (rows.length >= limits.page) return { pushed: state.scanned, next: "now" } as const;
      }
      // The end of the log: ask the source to deliver live from here.
      const after = (yield* getState(target))!;
      const handoff = yield* bounded(net.source.handoff(after.ref, target, "", after.through)).pipe(
        Effect.catchCause(() => Effect.succeed("stale" as Handoff)),
      );
      if (handoff === "more") return { pushed: after.scanned, next: "now" } as const;
      yield* storage.exclusive(
        Effect.gen(function* () {
          const current = yield* getState(target);
          if (current === undefined || current.through !== after.through) return;
          yield* storage.put({
            [stateKey(target)]: { ...current, scanned: true, live: handoff === "live" },
          });
        }),
      );
      yield* trace("scanned", { ref: after.ref, target, through: after.through, handoff });
      // Still on older code: read on later, past what arrives meanwhile.
      if (handoff === "stale") yield* retry.later(jobId(target), limits.staleRetryMillis);
      else yield* retry.clear(jobId(target));
      return { pushed: true, next: handoff === "live" ? "never" : "later" } as const;
    });

  /** Keep stepping until the history up to now is pushed, or `until` (epoch ms). */
  const scanUntil = (target: string, until: number) =>
    Effect.gen(function* () {
      while (true) {
        const { pushed, next } = yield* step(target);
        if (pushed) return true;
        if (next !== "now" || (yield* Clock.currentTimeMillis) >= until) {
          // The rest in jobs; the run asks again.
          if (next === "now") yield* jobs.schedule(jobId(target), 0);
          return false;
        }
      }
    });

  return {
    scan: (target: string, ref: SourceRef, waitMillis: number) =>
      Effect.gen(function* () {
        const state = yield* init(target, ref);
        if (state.scanned) return true;
        return yield* scanUntil(target, (yield* Clock.currentTimeMillis) + waitMillis);
      }),

    ready: (target: string, waitMillis: number) =>
      Effect.gen(function* () {
        // Marked before it lists keys: one pushed to after the listing is told by `step`.
        yield* storage.exclusive(
          Effect.gen(function* () {
            const current = yield* getState(target);
            if (current !== undefined && !current.readied)
              yield* storage.put({ [stateKey(target)]: { ...current, readied: true } });
          }),
        );
        const until = (yield* Clock.currentTimeMillis) + waitMillis;
        let after: string | undefined;
        let done = true;
        while (true) {
          const rows = yield* storage.list({
            prefix: keysPrefix(target),
            ...(after === undefined ? {} : { startAfter: after }),
            limit: 256,
          });
          if (rows.length === 0) return done;
          const settled = yield* Effect.forEach(
            rows,
            ([row]) =>
              Effect.gen(function* () {
                const key = decodeURIComponent(row.slice(keysPrefix(target).length));
                while (true) {
                  const left = until - (yield* Clock.currentTimeMillis);
                  const wait = Math.max(0, Math.min(RELAY_KEY_WAIT_MS, left));
                  const result = yield* net.consumer
                    .ready(target, key, wait)
                    .pipe(Effect.timeout(`${wait + CALL_TIMEOUT_MS} millis`), Effect.orDie);
                  if (result === "settled") return true;
                  if ((yield* Clock.currentTimeMillis) >= until) return false;
                }
              }),
            { concurrency: limits.concurrency },
          );
          done = done && settled.every(Boolean);
          after = rows[rows.length - 1]![0];
        }
      }),

    kick: (target: string, ref: SourceRef) =>
      Effect.gen(function* () {
        const state = yield* init(target, ref, true);
        if (!state.live) yield* jobs.schedule(jobId(target), 0);
      }),

    /** Run a scheduled job by its id. */
    run: (id: string) =>
      Effect.gen(function* () {
        const { next } = yield* step(id.slice("bf-scan:".length));
        if (next === "now") yield* jobs.schedule(id, 0);
      }).pipe(Effect.catchCause(() => retry.later(id, RETRY_MS))),
  };
};

export type Scanner = ReturnType<typeof makeScanner>;

// ---------------------------------------------------------------- consumer keys

/** A consumer key's view of one of its sources during a backfill. */
interface Feed {
  readonly ref: SourceRef | null;
  /** The last seq pulled. */
  readonly cursor: number;
  /** Switched to live delivery: nothing more to pull. */
  readonly live: boolean;
  /** Deliveries from it waiting in the buffer. */
  readonly buffered: number;
}

/** What a consumer key gives the protocol. */
export interface ConsumerHost {
  readonly key: string;
  /** This consumer's target id in the code this instance runs. */
  readonly target: () => string;
  /**
   * Whether each key hears only from the source instance with its own id: then
   * it reads that instance's log itself, as soon as its leaf starts it (no
   * barrier), and applies what it reads directly (nothing to merge).
   */
  readonly singleSource?: () => boolean;
  /**
   * Route a source's stored rows (from its `log`) to this consumer: each row's
   * seq and its deliveries. Runs this key's code, whatever code the source runs.
   */
  readonly history?: (
    ref: SourceRef,
    rows: ReadonlyArray<unknown>,
  ) => Effect.Effect<
    ReadonlyArray<{ readonly seq: number; readonly deliveries: ReadonlyArray<Delivery> }>
  >;
  /** The sources this consumer reads (`Account`, `Deposits`): where it asks about discovery. */
  readonly sources?: () => ReadonlyArray<string>;
  /**
   * Apply deliveries in order, as the live path would. Called holding the
   * exclusive section.
   */
  readonly apply: (deliveries: ReadonlyArray<Delivery>) => Effect.Effect<void>;
  /** Work an `apply` left for after its exclusive section commits (pushes, sends). */
  readonly after?: Effect.Effect<void>;
}

/**
 * A consumer key's part of the protocol. Its host passes every delivery for
 * the current target through {@link Consumer.admit} before applying it, and
 * serves `source` and `ready`.
 */
export const makeConsumer = (
  storage: Storage,
  jobs: Jobs,
  net: Network,
  host: ConsumerHost,
  limits: Limits = defaultLimits,
) => {
  const T = (target: string) => enc(target);
  const backfillKey = (target: string) => `bf:c:${T(target)}`;
  const doneKey = (target: string) => `bf:done:${T(target)}`;
  const feedKey = (target: string, stream: string) => `bf:f:${T(target)}:${enc(stream)}`;
  const feedsPrefix = (target: string) => `bf:f:${T(target)}:`;
  /** Feeds still pulling with nothing buffered: the merge can't apply past them. */
  const starvedKey = (target: string, stream: string) => `bf:x:${T(target)}:${enc(stream)}`;
  const starvedPrefix = (target: string) => `bf:x:${T(target)}:`;
  const pullingKey = (target: string, stream: string) => `bf:p:${T(target)}:${enc(stream)}`;
  const pullingPrefix = (target: string) => `bf:p:${T(target)}:`;
  const bufferPrefix = (target: string) => `bf:b:${T(target)}:`;
  /** A buffered delivery held, not counted: see `buffer`. */
  const heldKey = (row: string) => `bf:h:${row.slice("bf:b:".length)}`;
  const jobId = (target: string) => `bf-merge:${target}`;
  /** Keyed by its source: it has read its source's log to the end (its history is here). */
  const caughtKey = (target: string) => `bf:caught:${T(target)}`;
  const retry = makeRetry(storage, jobs, limits);
  /**
   * A message for another generation of this consumer. A newer one means this
   * instance still runs older code: refuse it, so the sender tries again once
   * it runs the deployed code. An older one is from a superseded backfill.
   */
  const stale = (target: string) =>
    generationOf(target) > generationOf(host.target())
      ? Effect.die(new Stale({ message: `${host.key} runs ${host.target()}, not ${target} yet` }))
      : Effect.void;

  interface Backfill {
    /** Every source's history is here: apply it in order. */
    readonly ready: boolean;
    /** A scanner pushed it history: that scanner tells it when it is ready. */
    readonly pushed?: boolean;
  }

  const begin = (target: string) =>
    Effect.gen(function* () {
      const existing = yield* storage.get<Backfill>(backfillKey(target));
      if (existing) return existing;
      const backfill: Backfill = { ready: false };
      yield* storage.put({ [backfillKey(target)]: backfill });
      yield* jobs.schedule(jobId(target), 0);
      return backfill;
    });

  /** Record a feed's buffered count and whether it starves the merge. */
  const starves = (feed: Feed | undefined) =>
    feed !== undefined && !feed.live && feed.buffered === 0;
  const putFeed = (target: string, stream: string, feed: Feed) =>
    Effect.gen(function* () {
      const before = yield* storage.get<Feed>(feedKey(target, stream));
      yield* storage.put({ [feedKey(target, stream)]: feed });
      // The indexes change only when the feed's state does: one write per row otherwise.
      if (before === undefined || before.live !== feed.live) {
        if (!feed.live) yield* storage.put({ [pullingKey(target, stream)]: true });
        else yield* storage.delete([pullingKey(target, stream)]);
      }
      if (before === undefined || starves(before) !== starves(feed)) {
        if (starves(feed)) yield* storage.put({ [starvedKey(target, stream)]: true });
        else yield* storage.delete([starvedKey(target, stream)]);
      }
    });

  /** Buffer deliveries in merge order. Callers hold the exclusive section. */
  const buffer = (target: string, deliveries: ReadonlyArray<Delivery>, live: boolean) =>
    Effect.gen(function* () {
      // Each feed is written once per call, however many of its deliveries arrive.
      const feeds = new Map<string, Feed>();
      for (const delivery of deliveries) {
        const key = orderKey(target, delivery);
        const feed = feeds.get(delivery.source) ??
          (yield* storage.get<Feed>(feedKey(target, delivery.source))) ?? {
            ref: null,
            cursor: 0,
            // Arriving live from a source it never heard of: one with no history for this key.
            live,
            buffered: 0,
          };
        if ((yield* storage.get(key)) !== undefined) {
          // Held live, now read from the log too: it counts.
          if (!live && (yield* storage.get(heldKey(key))) !== undefined) {
            yield* storage.delete([heldKey(key)]);
            feeds.set(delivery.source, { ...feed, buffered: feed.buffered + 1 });
          }
          continue;
        }
        yield* storage.put({ [key]: delivery });
        if (live && feed.ref !== null && !feed.live) {
          // Live from a source this key is still reading: the source went live before
          // the key had the rows before this one (the answer that said so was lost). Held,
          // not counted, so the merge waits for those rows before it applies this.
          yield* storage.put({ [heldKey(key)]: true });
          feeds.set(delivery.source, feed);
          continue;
        }
        feeds.set(delivery.source, { ...feed, buffered: feed.buffered + 1 });
      }
      for (const [stream, feed] of feeds) yield* putFeed(target, stream, feed);
    });

  /**
   * Read a page of the source's log and route it with this key's code. At the
   * end of the log, ask the source to deliver live from there: `caughtUp` either
   * way, since the key has every row the source had.
   */
  const readLog = (target: string, ref: SourceRef, from: number) =>
    Effect.gen(function* () {
      // At first, start where the source's live routing stopped: this key has the rest.
      const read = yield* readAt(net, ref, target, host.key, from, limits.page);
      const rows = read.rows;
      const routed = yield* host.history!(ref, rows);
      const through = routed.length > 0 ? routed[routed.length - 1]!.seq : read.from;
      const deliveries = routed
        .flatMap((row) => row.deliveries)
        .filter((delivery) => delivery.key === host.key);
      if (rows.length >= limits.page)
        return { deliveries, live: false, through, caughtUp: false } satisfies Pulled & {
          readonly caughtUp: boolean;
        };
      const handoff =
        read.handoff ??
        (yield* bounded(net.source.handoff(ref, target, host.key, through)).pipe(
          Effect.catchCause(() => Effect.succeed("stale" as Handoff)),
        ));
      return {
        deliveries,
        live: handoff === "live",
        through,
        // Rows were added meanwhile: read them at once.
        end: handoff === "more",
        caughtUp: handoff !== "more",
      } satisfies Pulled & { readonly caughtUp: boolean };
    });

  /** Pull a page for each feed that starves the merge. */
  const pullStarved = (target: string) =>
    Effect.gen(function* () {
      const starved = yield* storage.list({
        prefix: starvedPrefix(target),
        limit: limits.concurrency * 4,
      });
      const streams = starved.map(([row]) =>
        decodeURIComponent(row.slice(starvedPrefix(target).length)),
      );
      // A page that reached the end of its source is followed at once by the pull
      // that switches the feed to live, so the merge never stops to wait for it.
      const pullFeed = (stream: string): Effect.Effect<boolean> =>
        Effect.gen(function* () {
          const feed = yield* storage.get<Feed>(feedKey(target, stream));
          if (!feed || feed.live || feed.ref === null) return false;
          // Keyed by its source: the key reads the source's log and routes it itself.
          const pulled = yield* readLog(target, feed.ref, feed.cursor).pipe(
            // Refused (still on older code) or lost in transit: pull it again later.
            Effect.catchCause(() => Effect.void),
          );
          if (pulled === undefined) return true;
          yield* storage.exclusive(
            Effect.gen(function* () {
              const current = yield* storage.get<Feed>(feedKey(target, stream));
              if (!current || current.cursor !== feed.cursor) return;
              // Read up to the end of its source's log: its history is here, whether
              // or not the source could switch it to live delivery yet.
              if (
                "caughtUp" in pulled &&
                pulled.caughtUp &&
                !(yield* storage.get(caughtKey(target)))
              ) {
                yield* storage.put({ [caughtKey(target)]: true });
                yield* trace("caught-up", { key: host.key, target });
              }
              // Its only source, and nothing buffered ahead: the page is already in
              // order, so apply it rather than buffer it.
              const direct =
                host.singleSource?.() === true &&
                (yield* storage.list({ prefix: bufferPrefix(target), limit: 1 })).length === 0;
              if (direct) {
                for (const delivery of pulled.deliveries) yield* host.apply([delivery]);
              } else yield* buffer(target, pulled.deliveries, false);
              const after = (yield* storage.get<Feed>(feedKey(target, stream)))!;
              yield* putFeed(target, stream, {
                ...after,
                cursor: Math.max(
                  after.cursor,
                  pulled.through ?? 0,
                  ...pulled.deliveries.map((d) => d.seq),
                ),
                live: pulled.live,
              });
            }),
          );
          if (pulled.end === true && !pulled.live) return yield* pullFeed(stream);
          // A source on code without the target can't deliver live yet: read again later.
          return "caughtUp" in pulled && pulled.caughtUp === true && !pulled.live;
        });
      const failed = yield* Effect.forEach(streams, pullFeed, {
        concurrency: limits.concurrency,
      });
      return failed.some((stale) => stale);
    });

  /**
   * Apply buffered deliveries in merge order while no pulling feed starves the
   * merge. Once ready, with no feed left to pull and nothing buffered, the
   * backfill is done and the key goes back to applying directly.
   */
  const applyBuffered = (target: string) =>
    storage.exclusive(
      Effect.gen(function* () {
        const backfill = yield* storage.get<Backfill>(backfillKey(target));
        if (!backfill) return "done" as const;
        if ((yield* storage.list({ prefix: starvedPrefix(target), limit: 1 })).length > 0)
          return "starved" as const;
        // A page in merge order, each delivery applied on its own (as live, so watchers and
        // downstream consumers see every change), each feed written once. It stops after
        // the delivery that leaves a feed still pulling with nothing buffered.
        const page = yield* storage.list<Delivery>({
          prefix: bufferPrefix(target),
          limit: limits.apply,
        });
        const feeds = new Map<string, Feed>();
        const applied: Array<Delivery> = [];
        let starved = false;
        for (const [, delivery] of page) {
          const feed =
            feeds.get(delivery.source) ??
            (yield* storage.get<Feed>(feedKey(target, delivery.source)))!;
          // A held delivery wasn't counted (see `buffer`).
          const row = orderKey(target, delivery);
          const held = (yield* storage.get(heldKey(row))) !== undefined;
          if (held) yield* storage.delete([heldKey(row)]);
          const next = held ? feed : { ...feed, buffered: feed.buffered - 1 };
          feeds.set(delivery.source, next);
          yield* host.apply([delivery]);
          applied.push(delivery);
          if (starves(next)) {
            starved = true;
            break;
          }
        }
        if (applied.length > 0) {
          yield* storage.delete(page.slice(0, applied.length).map(([row]) => row));
          for (const [stream, feed] of feeds) yield* putFeed(target, stream, feed);
        }
        if (starved) return "starved" as const;
        if (page.length >= limits.apply) return "more" as const;
        if (!backfill.ready) return "waiting" as const;
        if ((yield* storage.list({ prefix: pullingPrefix(target), limit: 1 })).length > 0)
          return "starved" as const;
        // Ready, every feed live and the buffer empty: done, atomically with the last apply.
        for (const prefix of [feedsPrefix(target), starvedPrefix(target), pullingPrefix(target)]) {
          while (true) {
            const rows = yield* storage.list({ prefix, limit: 128 });
            if (rows.length === 0) break;
            yield* storage.delete(rows.map(([key]) => key));
          }
        }
        yield* storage.delete([backfillKey(target), `bf:asked:${T(target)}`, caughtKey(target)]);
        yield* storage.put({ [doneKey(target)]: true });
        return "done" as const;
      }),
    );

  /** Keyed by its source: it has its history (read to the end of its log, or done). */
  const settled = (target: string) =>
    Effect.map(
      Effect.all([storage.get(doneKey(target)), storage.get(caughtKey(target))]),
      ([done, caught]) => done !== undefined || caught !== undefined,
    );

  /**
   * Keyed by its source: read `ref`'s log from the start. Ready at once, since
   * it has no other source to wait for. Callers hold the exclusive section.
   */
  const follow = (target: string, ref: SourceRef) =>
    Effect.gen(function* () {
      const backfill = yield* begin(target);
      if (!backfill.ready)
        yield* storage.put({ [backfillKey(target)]: { ...backfill, ready: true } });
      const stream = `${ref.source}/${ref.id}`;
      const feed = yield* storage.get<Feed>(feedKey(target, stream));
      if (feed === undefined || feed.ref === null)
        yield* putFeed(target, stream, {
          ref,
          cursor: 0,
          live: false,
          buffered: feed?.buffered ?? 0,
        });
    });

  /** The merge job for one target. */
  /** The merge job for one target: `true` when it couldn't go on (a call failed), and waits. */
  const merge = (target: string): Effect.Effect<boolean> =>
    Effect.gen(function* () {
      const backfill = yield* storage.get<Backfill>(backfillKey(target));
      if (!backfill) return false;
      if (!backfill.ready) {
        // A key with history is told it is ready by the scanners that pushed it. One
        // fed only live (no history) has no one to tell it: it asks the run.
        if (backfill.pushed) return false;
        const phase = yield* net.run.phase(target).pipe(Effect.catchCause(() => Effect.void));
        if (phase === undefined)
          return yield* Effect.as(retry.later(jobId(target), RETRY_MS), true);
        yield* trace("waiting", { key: host.key, target, phase });
        if (phase !== "ready" && phase !== "complete")
          return yield* Effect.as(jobs.schedule(jobId(target), limits.pollMillis), false);
        yield* storage.exclusive(
          Effect.gen(function* () {
            const current = yield* storage.get<Backfill>(backfillKey(target));
            if (current) yield* storage.put({ [backfillKey(target)]: { ...current, ready: true } });
          }),
        );
      }
      const outcome = yield* applyBuffered(target);
      yield* trace("merge", { key: host.key, target, outcome });
      if (host.after) yield* host.after;
      if (outcome === "done" || outcome === "waiting")
        return yield* Effect.as(retry.clear(jobId(target)), false);
      // A remote failure never fails the job (which a durable callback would retry
      // with a growing delay, then park): it asks again after a fixed wait.
      const failed = outcome === "starved" ? yield* pullStarved(target) : false;
      if (failed) return yield* Effect.as(retry.later(jobId(target), RETRY_MS), true);
      yield* retry.clear(jobId(target));
      yield* jobs.schedule(jobId(target), 0);
      return false;
    });

  return {
    /**
     * Deliveries for `target` arriving at this key. `true`: apply them now, as
     * usual. `false`: the key is backfilling, and they were buffered.
     */
    admit: (target: string, deliveries: ReadonlyArray<Delivery>) =>
      Effect.gen(function* () {
        const known = yield* storage.exclusive(
          Effect.gen(function* () {
            if (yield* storage.get(doneKey(target))) return "apply" as const;
            if (!(yield* storage.get(backfillKey(target)))) return "unknown" as const;
            yield* buffer(target, deliveries, true);
            yield* jobs.schedule(jobId(target), 0);
            return "buffered" as const;
          }),
        );
        if (known !== "unknown") return known === "apply";
        if (host.singleSource?.() === true) {
          // Keyed by its source: it needs no one to start it. It reads its source's
          // log, and takes these in order with it (a new instance's key reads little).
          // Its source is the instance with its own id.
          const source = deliveries[0]!.origin;
          yield* storage.exclusive(
            Effect.gen(function* () {
              yield* follow(target, { source, id: host.key });
              yield* buffer(target, deliveries, true);
            }),
          );
          yield* jobs.schedule(jobId(target), 0);
          return false;
        }
        // A key's first delivery for this target: is a run still pushing history?
        const phase = yield* net.run.phase(target);
        return yield* storage.exclusive(
          Effect.gen(function* () {
            if (yield* storage.get(doneKey(target))) return true;
            if (phase === "complete" && !(yield* storage.get(backfillKey(target)))) {
              yield* storage.put({ [doneKey(target)]: true });
              return true;
            }
            yield* begin(target);
            yield* buffer(target, deliveries, true);
            yield* jobs.schedule(jobId(target), 0);
            return false;
          }),
        );
      }),

    push: (target: string, deliveries: ReadonlyArray<Delivery>) =>
      Effect.gen(function* () {
        const applied = yield* storage.exclusive(
          Effect.gen(function* () {
            if (target !== host.target()) {
              yield* stale(target);
              // An older generation's run: superseded.
              return false;
            }
            if (yield* storage.get(doneKey(target))) {
              // Its history is in: these are newer (read from a source still on older
              // code), and arrive as live deliveries would. The checkpoints drop repeats.
              yield* host.apply(deliveries.map(({ history: _, ...live }) => live));
              return true;
            }
            const backfill = yield* begin(target);
            if (!backfill.pushed)
              yield* storage.put({ [backfillKey(target)]: { ...backfill, pushed: true } });
            yield* buffer(target, deliveries, true);
            return false;
          }),
        );
        if (applied && host.after) yield* host.after;
      }),

    start: (target: string, ref: SourceRef, waitMillis = 0) =>
      Effect.gen(function* () {
        const started = yield* storage.exclusive(
          Effect.gen(function* () {
            yield* trace("start", { key: host.key, target });
            if (target !== host.target()) {
              yield* stale(target);
              // An older generation's run: superseded, nothing to wait for.
              return "settled" as const;
            }
            if (yield* settled(target)) return "settled" as const;
            yield* follow(target, ref);
            return "pending" as const;
          }),
        );
        if (started === "settled") return started;
        // Worked on here when asked to wait; the job takes over only if it isn't done in time.
        if (waitMillis <= 0) return yield* Effect.as(jobs.schedule(jobId(target), 0), started);
        // Work on it here, rather than wait for an alarm to run the job: read its
        // source's log a page at a time until it has its history, or time is up.
        const until = (yield* Clock.currentTimeMillis) + waitMillis;
        for (let failures = 0; ;) {
          failures = (yield* merge(target)) ? failures + 1 : 0;
          if (yield* settled(target)) return "settled" as const;
          if ((yield* Clock.currentTimeMillis) >= until)
            return yield* Effect.as(jobs.schedule(jobId(target), 0), "pending" as const);
          yield* Effect.sleep(`${yield* pause(failures)} millis`);
        }
      }),

    ready: (target: string, waitMillis = 0) =>
      Effect.gen(function* () {
        const told = yield* storage.exclusive(
          Effect.gen(function* () {
            yield* trace("told-ready", { key: host.key, target });
            if (target !== host.target()) {
              yield* stale(target);
              return "settled" as const;
            }
            if (yield* storage.get(doneKey(target))) return "settled" as const;
            const backfill = yield* begin(target);
            if (!backfill.ready)
              yield* storage.put({ [backfillKey(target)]: { ...backfill, ready: true } });
            return "pending" as const;
          }),
        );
        if (told === "settled") return told;
        yield* jobs.schedule(jobId(target), 0);
        if (waitMillis <= 0) return told;
        // Apply it here, rather than wait for an alarm to run the job.
        const until = (yield* Clock.currentTimeMillis) + waitMillis;
        for (let failures = 0; ;) {
          failures = (yield* merge(target)) ? failures + 1 : 0;
          if (yield* storage.get(doneKey(target))) return "settled" as const;
          if ((yield* Clock.currentTimeMillis) >= until) return "pending" as const;
          yield* Effect.sleep(`${yield* pause(failures)} millis`);
        }
      }),

    /** The merge job for one target. */
    merge,

    /** Is a backfill of `target` still running on this key? */
    backfilling: (target: string) =>
      Effect.map(storage.get(backfillKey(target)), (backfill) => backfill !== undefined),
  };
};

export type Consumer = ReturnType<typeof makeConsumer>;

// ---------------------------------------------------------------- directory

/**
 * A directory node: lists instances, links itself into its parent, and splits
 * into 16 children once it lists more than `leafSize`. Runs only read it.
 */
export const makeNode = (
  storage: Storage,
  jobs: Jobs,
  net: Network,
  limits: Limits = defaultLimits,
) => {
  const retry = makeRetry(storage, jobs, limits);

  /** Remember this node's path (jobs read it), written once. */
  const keepPath = (path: string) =>
    Effect.gen(function* () {
      if ((yield* storage.get<string>("path")) !== path) yield* storage.put({ path });
    });

  /**
   * Link this node into its parent, and so on up to the root, before answering:
   * an instance's first commit waits for it, so every instance with an event
   * can be reached from the root. Only a node's first registration pays for it.
   */
  const ensureLinked = (path: string) =>
    Effect.gen(function* () {
      if (path === "" || (yield* storage.get("linked"))) return;
      // One link at a time: registrations arriving together all find the node
      // unlinked, and would each call its parent, and so on up to a flooded root.
      yield* linking.withPermits(1)(
        Effect.gen(function* () {
          if (yield* storage.get("linked")) return;
          yield* net.node.child(parentOf(path), path);
          yield* storage.exclusive(storage.put({ linked: true, path }));
        }),
      );
    });
  const linking = Semaphore.makeUnsafe(1);

  /**
   * Move a page of listed instances to the children, until none are left here.
   * Each is listed at its child before it leaves here, so a reader that lists a
   * node's own instances before its children never misses one.
   */
  const split = (path: string) =>
    Effect.gen(function* () {
      const rows = yield* storage.list<SourceRef>({ prefix: "i:", limit: limits.nodePage });
      if (rows.length === 0) return;
      yield* Effect.forEach(rows, ([, ref]) => net.node.register(childFor(path, ref), ref), {
        concurrency: limits.concurrency,
        discard: true,
      });
      yield* storage.exclusive(storage.delete(rows.map(([key]) => key)));
      yield* jobs.schedule("split", 0);
    });

  return {
    register: (path: string, ref: SourceRef) =>
      Effect.gen(function* () {
        const forward = yield* storage.exclusive(
          Effect.gen(function* () {
            // Split: its children list instances now.
            if (yield* storage.get("split")) return childFor(path, ref);
            const key = `i:${refKey(ref)}`;
            if ((yield* storage.get(key)) !== undefined) return undefined;
            const count = ((yield* storage.get<number>("count")) ?? 0) + 1;
            yield* keepPath(path);
            yield* storage.put({ [key]: ref, count });
            // Full: split into 16 children by the next hex digit, a page at a time.
            if (count > limits.leafSize && digitsOf(path).length < 8) {
              yield* storage.put({ split: true });
              yield* jobs.schedule("split", 0);
            }
            return undefined;
          }),
        );
        yield* ensureLinked(path);
        if (forward !== undefined) yield* net.node.register(forward, ref);
      }),

    child: (path: string, child: string) =>
      Effect.gen(function* () {
        yield* storage.exclusive(
          Effect.gen(function* () {
            yield* keepPath(path);
            if ((yield* storage.get(`c:${child}`)) === undefined)
              yield* storage.put({ [`c:${child}`]: true });
          }),
        );
        yield* ensureLinked(path);
      }),

    list: (path: string, after: string | undefined) =>
      storage.exclusive(
        Effect.gen(function* () {
          const rows = yield* storage.list<SourceRef>({
            prefix: "i:",
            ...(after === undefined ? {} : { startAfter: after }),
            limit: LIST_PAGE,
          });
          // Its own rows before its children: a row a split moves on is listed at the
          // child before it leaves here, so a reader that lists the child later finds it.
          const children =
            after === undefined
              ? (yield* storage.list({ prefix: "c:" })).map(([key]) => key.slice(2))
              : [];
          return {
            rows: rows.map(([, ref]) => ref),
            children,
            ...(rows.length === LIST_PAGE ? { next: rows[rows.length - 1]![0] } : {}),
          } satisfies Listing;
        }),
      ),

    /** Run a scheduled job by its id. */
    run: (id: string) =>
      Effect.gen(function* () {
        const path = (yield* storage.get<string>("path")) ?? "";
        if (id === "split") yield* split(path);
        yield* retry.clear(id);
      }).pipe(
        // A remote failure tries again after a fixed wait, rather than failing the job.
        Effect.catchCause(() => retry.later(id, RETRY_MS)),
      ),
  };
};

export type Node = ReturnType<typeof makeNode>;

// ---------------------------------------------------------------- relay

/**
 * How many calls a relay makes at once: Cloudflare runs at most six outgoing
 * calls per invocation, so a wider relay would queue its own calls.
 */
export const RELAY_FANOUT = 6;

/** How long a key works on its history before it answers a relay that is waiting for it. */
const RELAY_KEY_WAIT_MS = 10_000;

/**
 * How many subtrees a run's root lists the directory into, at least: small
 * steps for its window, a few hundred keys each at a million instances.
 */
const FRONTIER_SIZE = 512;

/** A relay's count of the calls the account's load refused. */
interface Tally {
  refused: number;
  /** Source instances done. */
  instances: number;
  /** A call given up on, and why. */
  failure?: string;
}

/** How long a call may take, beyond the work it was asked to wait for, before it counts as lost. */
const CALL_TIMEOUT_MS = 20_000;

/**
 * How long a relay waits before it calls again after a failure, doubling each
 * time up to {@link RELAY_RETRY_MAX_MS}: an object still on older code moves to
 * the deployed code only once it has been idle, so calls at a fixed short pace
 * would keep it there.
 */
const RELAY_RETRY_MS = 250;
const RELAY_RETRY_MAX_MS = 30_000;
/** Calls the account's load refused before a relay gives an item back to the run's root. */
const RELAY_REFUSALS = 3;

/** Failed calls a relay makes again at once, before it waits. */
const RELAY_RETRY_AT_ONCE = 2;

/**
 * A relay: one node of the tree a pass of a run fans out over, each its own
 * object. Given more than {@link RELAY_FANOUT} items it splits them among as
 * many child relays; given one directory node, it lists it and works through
 * what it lists; given a few, it handles each source instance itself and
 * hands each directory node to a child relay. Every relay answers once
 * everything under it is done, so a pass is done when the first one answers,
 * after about log6 of the instances levels of calls.
 *
 * For each source instance, it starts the instance's key (a consumer keyed by
 * its source), or calls the instance's scanner: to push its history
 * (`discover`), or to tell the keys it pushed to that all history is in
 * (`ready`).
 *
 * It keeps no state: a relay that fails is called again, and work already
 * done answers at once. It reads the directory, which any code serves, and
 * calls keys and scanners, which are new with the deploy: so a run never
 * waits for an existing object to run the deployed code.
 */
export const makeRelay = (net: Network) => {
  /**
   * Keep at `effect` until it succeeds or `until` (epoch ms) has passed; `undefined`
   * then, after logging why (`what` names the call).
   */
  const persist = <A>(
    effect: Effect.Effect<A>,
    until: number,
    what: () => string,
    /** How long one attempt may take before it counts as lost: a hung call would stall its subtree. */
    attempt: () => Effect.Effect<number> = () => Effect.succeed(CALL_TIMEOUT_MS),
    /** Counts the calls the account's load refused, for the run's root to pace itself by. */
    tally?: Tally,
  ): Effect.Effect<A | undefined> =>
    Effect.gen(function* () {
      // A pass with no time to retry (one try at everything) expects failures: it doesn't log them.
      const quiet = until <= (yield* Clock.currentTimeMillis);
      for (let tries = 0, refusals = 0; ; tries++) {
        const limit = yield* attempt();
        const result = yield* (
          quiet ? effect : effect.pipe(Effect.timeout(`${limit} millis`))
        ).pipe(
          Effect.map((value) => ({ value })),
          Effect.catchCause((cause) => Effect.succeed({ cause })),
        );
        if ("value" in result) return result.value;
        // A call lost in transit: try again at once, a couple of times, then wait. A
        // call the account's load refused: wait at once, longer each time.
        const refused = overloaded(result.cause);
        const failure = () => `${what()}: ${String(Cause.squash(result.cause)).slice(0, 300)}`;
        if (refused && tally !== undefined) tally.refused += 1;
        // Refused a few times: give it back to the run's root, which sends it again at a
        // lower load, rather than hold the rest of its round until the pass's deadline.
        if (refused && ++refusals >= RELAY_REFUSALS) {
          if (tally !== undefined) tally.failure ??= failure();
          return undefined;
        }
        if (!refused && tries < RELAY_RETRY_AT_ONCE) continue;
        const wait = yield* backoff(
          refused ? tries + 1 : tries - RELAY_RETRY_AT_ONCE + 1,
          refused ? 1_000 : RELAY_RETRY_MS,
          RELAY_RETRY_MAX_MS,
        );
        if ((yield* Clock.currentTimeMillis) + wait >= until) {
          if (!quiet) yield* Effect.logInfo(`backfill relay-failed ${failure()}`);
          if (tally !== undefined) tally.failure ??= failure();
          return undefined;
        }
        yield* Effect.sleep(`${wait} millis`);
      }
    });

  /** Every page a directory node lists: its instances' keys, and its children. */
  const listed = (path: string, run: RelayRun, until: number, tally?: Tally) =>
    Effect.gen(function* () {
      const items: Array<RelayItem> = [];
      let after: string | undefined;
      while (true) {
        const page = yield* persist(
          net.node.list(path, after),
          until,
          () => `list ${path}`,
          undefined,
          tally,
        );
        if (page === undefined) return undefined;
        for (const ref of page.rows) items.push({ ref: withGeneration(ref, run.plan) });
        // The root lists one subtree per source: only those the consumer reads.
        const sources = path === "" ? run.plan.sources : undefined;
        for (const child of page.children)
          if (sources === undefined || sources.includes(sourceOfPath(child) ?? ""))
            items.push({ path: child });
        if (page.next === undefined) return items;
        after = page.next;
      }
    });

  /** One source instance's part of a pass; keep at it until it is done, or time is up. */
  const instance = (run: RelayRun, ref: SourceRef, until: number, tally: Tally) =>
    Effect.gen(function* () {
      const call = (wait: number): Effect.Effect<boolean> =>
        run.plan.singleSource
          ? Effect.map(
              net.consumer.start(run.target, ref.id, ref, wait),
              (started) => started === "settled",
            )
          : run.phase === "discover"
            ? net.scanner.scan(run.target, ref, wait)
            : net.scanner.ready(run.target, ref, wait);
      const quiet = until <= (yield* Clock.currentTimeMillis);
      while (true) {
        const left = until - (yield* Clock.currentTimeMillis);
        const wait = Math.max(0, Math.min(RELAY_KEY_WAIT_MS, left));
        const done = yield* persist(
          call(wait),
          until,
          () => `${run.phase} ${ref.source}/${ref.id}`,
          () => Effect.succeed(wait + CALL_TIMEOUT_MS),
          tally,
        );
        if (done === true) {
          tally.instances += 1;
          return true;
        }
        if ((yield* Clock.currentTimeMillis) >= until) {
          if (done === false && !quiet)
            yield* Effect.logInfo(
              `backfill relay-pending ${run.target} ${run.phase} ${ref.source}/${ref.id}`,
            );
          return false;
        }
      }
    });

  const run = (
    name: string,
    relayRun: RelayRun,
    items: ReadonlyArray<RelayItem>,
  ): Effect.Effect<RelayResult> =>
    Effect.gen(function* () {
      const tally: Tally = { refused: 0, instances: 0 };
      const done = yield* work(name, relayRun, items, tally);
      return {
        done,
        refused: tally.refused,
        instances: tally.instances,
        ...(tally.failure === undefined ? {} : { failure: tally.failure }),
      };
    });

  /** Work through `items`: whether each is done. */
  const work = (
    name: string,
    relayRun: RelayRun,
    items: ReadonlyArray<RelayItem>,
    tally: Tally,
  ): Effect.Effect<ReadonlyArray<boolean>> =>
    Effect.gen(function* () {
      const until = relayRun.deadline;
      const child = (suffix: string, chunk: ReadonlyArray<RelayItem>) =>
        Effect.map(
          persist(
            net.relay.run(`${name}${suffix}`, relayRun, chunk),
            until,
            () => `relay ${name}${suffix}`,
            // A child answers by the pass's deadline: allow it that, and a little more.
            () => Effect.map(Clock.currentTimeMillis, (now) => until - now + CALL_TIMEOUT_MS),
            tally,
          ),
          (result): ReadonlyArray<boolean> => {
            if (result === undefined) return chunk.map(() => false);
            tally.refused += result.refused;
            tally.instances += result.instances ?? 0;
            tally.failure ??= result.failure;
            return result.done;
          },
        );
      if (items.length > RELAY_FANOUT) {
        // Too many to call at once: split them among child relays.
        const size = Math.ceil(items.length / RELAY_FANOUT);
        const chunks = Array.from({ length: RELAY_FANOUT }, (_, i) =>
          items.slice(i * size, (i + 1) * size),
        ).filter((chunk) => chunk.length > 0);
        const done = yield* Effect.forEach(chunks, (chunk, i) => child(`/${i}`, chunk), {
          concurrency: RELAY_FANOUT,
        });
        return done.flat();
      }
      const only = items.length === 1 ? items[0]! : undefined;
      if (only !== undefined && "path" in only) {
        // One directory node: list it, and work through what it lists here.
        const next = yield* listed(only.path, relayRun, until, tally);
        if (next === undefined) return [false];
        yield* trace("relay-listed", { name, path: only.path, items: next.length });
        return [(yield* work(name, relayRun, next, tally)).every(Boolean)];
      }
      return yield* Effect.forEach(
        items,
        (item, i) =>
          "path" in item
            ? Effect.map(child(`.${i}`, [item]), (done) => done[0] === true)
            : instance(relayRun, item.ref, until, tally),
        { concurrency: RELAY_FANOUT },
      );
    });

  /**
   * The subtrees a run's root paces its passes over: the directory listed level
   * by level until there are at least {@link FRONTIER_SIZE} of them (or nothing
   * left to list), with any instances listed above them. Many small subtrees
   * let the root steer its load finely.
   */
  const frontier = (run: RelayRun, until: number) =>
    Effect.gen(function* () {
      let level: ReadonlyArray<RelayItem> = [{ path: "" }];
      while (level.length < FRONTIER_SIZE && level.some((item) => "path" in item)) {
        const next: Array<RelayItem> = [];
        const listings = yield* Effect.forEach(
          level,
          (item): Effect.Effect<ReadonlyArray<RelayItem> | undefined> =>
            "path" in item ? listed(item.path, run, until) : Effect.succeed([item]),
          { concurrency: RELAY_FANOUT },
        );
        for (const listing of listings) {
          if (listing === undefined) return undefined;
          next.push(...listing);
        }
        level = next;
      }
      return level;
    });

  return { run, frontier };
};

export type Relay = ReturnType<typeof makeRelay>;

// ---------------------------------------------------------------- runs

/** A run's progress, at its root. */
interface RunState {
  readonly plan: Plan;
  readonly phase: "discover" | "ready" | "complete";
  /** Passes in a row that weren't done: the next waits longer (see {@link RELAY_RETRY_MS}). */
  readonly misses?: number;
  /** How many subtrees it works through at once: see {@link makeRun}. */
  readonly window?: number;
}

/** Subtrees a run's root starts with at once: it grows to all of them while the account takes the load. */
const RUN_WINDOW = 16;

/** Calls a run's root keeps out at once: one object runs at most six. */
const RUN_CALLS = 6;

/**
 * The root of a consumer's run: it drives passes of a relay tree from its own
 * jobs. A consumer keyed by its source needs one pass (each key reads its own
 * source). Any other needs two, with a barrier between: `discover` pushes every
 * source's history to its keys, and only once all of it is in does `ready`
 * tell the keys to apply it, in timestamp order. Each pass is repeated until
 * it is done.
 */
export const makeRun = (
  storage: Storage,
  jobs: Jobs,
  net: Network,
  options: {
    /** How long a pass keeps at it before it answers (0: one try at everything). */
    readonly waitMillis: number;
    /** How long before a pass that wasn't done runs again, doubling each time up to 30s. */
    readonly againMillis: number;
  },
) => {
  const relay = makeRelay(net);
  const stateKey = (target: string) => `run:${enc(target)}`;
  const getState = (target: string) => storage.get<RunState>(stateKey(target));
  const progressKey = (target: string) => `prog:${enc(target)}`;
  const getProgress = (target: string) => storage.get<Progress>(progressKey(target));

  /** A frontier item's mark that it is done in a phase: a pass that runs again skips it. */
  const doneKey = (target: string, phase: string, item: RelayItem) =>
    `rd:${enc(target)}:${phase}:${"path" in item ? `p:${item.path}` : `i:${refKey(item.ref)}`}`;

  const drive = (target: string): Effect.Effect<void> =>
    Effect.gen(function* () {
      const state = yield* getState(target);
      if (state === undefined || state.phase === "complete") return;
      const started = yield* Clock.currentTimeMillis;
      const deadline = started + options.waitMillis;
      // One try at everything: every round runs in this pass, whatever the clock says.
      const quiet = options.waitMillis <= 0;
      const relayRun: RelayRun = {
        target,
        plan: state.plan,
        phase: state.phase,
        deadline,
      };
      const items = yield* relay.frontier(relayRun, deadline);
      const todo: Array<RelayItem> = [];
      for (const item of items ?? [])
        if ((yield* storage.get(doneKey(target, state.phase, item))) === undefined) todo.push(item);
      // What a deploy reports while it waits: kept apart from the state, written as it moves.
      const before = yield* getProgress(target);
      let progress: Progress = {
        target,
        phase: state.phase,
        subtrees: items?.length ?? before?.subtrees ?? 0,
        done: (items?.length ?? 0) - todo.length,
        instances: before?.phase === state.phase ? before.instances : 0,
        passes: (before?.phase === state.phase ? before.passes : 0) + 1,
        refused: before?.refused ?? 0,
        startedAt: before?.startedAt ?? started,
        updatedAt: started,
        ...(before?.lastError === undefined ? {} : { lastError: before.lastError }),
      };
      yield* storage.put({ [progressKey(target)]: progress });
      // Up to `window` subtrees out at once, in six calls (one object runs at most six at
      // once), each handing the relay tree its share; a new call as each one answers, with
      // what was given back sent again later. Like TCP's congestion window, `window` doubles
      // while the account takes the load, then grows slowly, and halves (once per window)
      // when Cloudflare refuses calls: a wide run stays under the account's limit rather
      // than hit it all at once and wait it out.
      let window = state.window ?? RUN_WINDOW;
      let growing = state.window === undefined;
      const queue = [...todo];
      let active = 0;
      let calls = 0;
      let refused = 0;
      let done = items !== undefined;
      let cutAt = 0;
      const finished = yield* Queue.unbounded<{
        readonly batch: ReadonlyArray<RelayItem>;
        readonly result: RelayResult;
        readonly launched: number;
      }>();
      while (queue.length > 0 || active > 0) {
        const open = quiet || (yield* Clock.currentTimeMillis) < deadline;
        while (open && active < RUN_CALLS && queue.length > 0) {
          const batch = queue.splice(0, Math.max(1, Math.round(window / RUN_CALLS)));
          const launched = yield* Clock.currentTimeMillis;
          const name = `${state.phase}-${state.misses ?? 0}/${calls++}`;
          yield* Effect.forkChild(
            relay
              .run(name, relayRun, batch)
              .pipe(Effect.flatMap((result) => Queue.offer(finished, { batch, result, launched }))),
          );
          active += 1;
        }
        if (active === 0) break;
        const { batch, result, launched } = yield* Queue.take(finished);
        active -= 1;
        refused += result.refused;
        const marks: Record<string, true> = {};
        const back: Array<RelayItem> = [];
        batch.forEach((item, i) => {
          if (result.done[i] === true) marks[doneKey(target, state.phase, item)] = true;
          else back.push(item);
        });
        progress = {
          ...progress,
          done: progress.done + Object.keys(marks).length,
          instances: progress.instances + (result.instances ?? 0),
          refused: progress.refused + result.refused,
          updatedAt: yield* Clock.currentTimeMillis,
          ...(result.failure === undefined ? {} : { lastError: result.failure }),
        };
        yield* storage.put({ ...marks, [progressKey(target)]: progress });
        if (result.refused > 0) {
          growing = false;
          if (launched >= cutAt) {
            window = Math.max(1, window / 2);
            cutAt = yield* Clock.currentTimeMillis;
          }
        } else {
          const step = batch.length;
          window = Math.min(todo.length, growing ? window + step : window + (step * step) / window);
        }
        if (back.length === 0) continue;
        // One try at everything: what wasn't done waits for the next pass.
        if (quiet) {
          done = false;
          continue;
        }
        queue.push(...back);
        // Nothing went through: wait a little before sending it again.
        if (back.length === batch.length)
          yield* Effect.sleep(`${yield* backoff(1, 1_000, 5_000)} millis`);
      }
      if (queue.length > 0) done = false;
      window = Math.max(1, Math.round(window));
      yield* Effect.logInfo(
        `backfill run-pass ${target} ${state.phase} done=${done} subtrees=${todo.length} window=${window} refused=${refused} in ${(yield* Clock.currentTimeMillis) - started}ms`,
      );
      if (!done) {
        const misses = (state.misses ?? 0) + 1;
        yield* storage.put({ [stateKey(target)]: { ...state, misses, window } });
        return yield* jobs.schedule(
          `drive:${target}`,
          Math.min(RELAY_RETRY_MAX_MS, options.againMillis * 2 ** (misses - 1)),
        );
      }
      const phase =
        state.plan.singleSource || state.phase === "ready" ? "complete" : ("ready" as const);
      yield* storage.put({
        [stateKey(target)]: { plan: state.plan, phase, window },
        [progressKey(target)]: {
          ...progress,
          phase,
          updatedAt: yield* Clock.currentTimeMillis,
        } satisfies Progress,
      });
      if (phase !== "complete") yield* jobs.schedule(`drive:${target}`, 0);
      else yield* clearPrefix(`rd:${enc(target)}:`);
    });

  const clearPrefix = (prefix: string) =>
    Effect.gen(function* () {
      while (true) {
        const rows = yield* storage.list({ prefix, limit: 128 });
        if (rows.length === 0) return;
        yield* storage.delete(rows.map(([key]) => key));
      }
    });

  return {
    begin: (target: string, plan: Plan) =>
      storage.exclusive(
        Effect.gen(function* () {
          const state = yield* getState(target);
          if (state !== undefined) {
            // The first plan stands: a run reads one set of sources, start to finish.
            if (!samePlan(state.plan, plan))
              return { status: "changed", started: state.plan } satisfies Begin;
            return { status: state.phase === "complete" ? "complete" : "started" } satisfies Begin;
          }
          yield* storage.put({
            [stateKey(target)]: { plan, phase: "discover" } satisfies RunState,
          });
          yield* jobs.schedule(`drive:${target}`, 0);
          return { status: "started" } satisfies Begin;
        }),
      ),
    phase: (target: string) =>
      Effect.map(getState(target), (state): Phase => state?.phase ?? "unknown"),
    /** How far the run has got; its phase is the run's own, so it never reads ahead of it. */
    progress: (target: string) =>
      Effect.gen(function* () {
        const phase: Phase = (yield* getState(target))?.phase ?? "unknown";
        const progress = yield* getProgress(target);
        return {
          target,
          subtrees: 0,
          done: 0,
          instances: 0,
          passes: 0,
          refused: 0,
          ...progress,
          phase,
        } satisfies Progress;
      }),
    /** Run a scheduled job by its id. */
    run: (id: string) => (id.startsWith("drive:") ? drive(id.slice("drive:".length)) : Effect.void),
  };
};

export type Run = ReturnType<typeof makeRun>;

// ---------------------------------------------------------------- host glue

/**
 * Route a commit's deliveries (an aggregate's events, or a view key's entries):
 * live to caught-up consumers, and through the backfill to lagging ones. Call
 * inside the commit's exclusive section; returns what to send and the new cursors.
 */
export const routeCommit = (
  source: Source,
  targets: ReadonlyArray<string>,
  routed: Routed | undefined,
  before: number,
  after: number,
  deliveries: ReadonlyArray<Delivery>,
) =>
  Effect.gen(function* () {
    const live = routeLive(targets, routed, before, after, deliveries);
    // A target behind here has its deliveries withheld: its reader reads them from the
    // log. An instance with no cursors predates catch-up: everything is live.
    if (routed !== undefined)
      for (const target of targets)
        if ((routed[target] ?? 0) !== before) yield* source.onCommit(target);
    return { send: live.deliveries, routed: live.routed };
  });

/** Route stored rows to one target only, as history: each row's seq and its deliveries. */
export const routeRows = <Row>(
  replay: (input: ReplayInput<Row>) => Effect.Effect<ReplayResult>,
  id: string,
  targets: ReadonlyArray<string>,
  target: string,
  rows: ReadonlyArray<Row>,
  seqOf: (row: Row) => number,
) =>
  Effect.forEach(rows, (row) =>
    Effect.map(
      replay({
        id,
        routed: Object.fromEntries(
          targets.map((t) => [t, t === target ? seqOf(row) - 1 : Number.MAX_SAFE_INTEGER]),
        ),
        rows: [row],
      }),
      ({ deliveries }) => ({ seq: seqOf(row), deliveries }),
    ),
  );

/** A consumer's kind and name from its target id: `view:Name#2` is the view `Name`. */
export const consumerOf = (target: string) => {
  const [kind, rest] = target.split(/:(.*)/s) as [string, string];
  return { kind: kind as "view" | "projection", name: rest.replace(/[#@]\d+$/, "") };
};
