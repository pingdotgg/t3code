import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Pull from "effect/Pull";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * The storage and delivery rules of one environment's held webhook requests.
 * Runs inside the environment's `HookInboxObject` Durable Object against its SQLite
 * storage; written against `SqlClient` so tests can run it on any SQLite.
 */

/** How long a held request waits for its environment. */
const HOOK_INBOX_TTL_MS = 24 * 60 * 60 * 1000;
/** Requests one environment may have waiting at once. */
const HOOK_INBOX_MAX_REQUESTS = 1_000;
/** Body bytes one environment may have waiting at once. */
export const HOOK_INBOX_MAX_BYTES = 50 * 1_048_576;
/**
 * Requests one hook may have waiting at once. The relay cannot check tokens,
 * so this keeps junk sent to one hook id from crowding out the others.
 */
export const HOOK_INBOX_MAX_PER_HOOK = 100;
/** Requests pushed per alarm run; the next run starts right away while more wait. */
const DELIVERIES_PER_RUN = 20;
/** Requests read at a time; a run keeps reading past busy hooks' backlogs. */
const ROWS_READ_PER_PAGE = 50;
/** Wait before trying a hook whose environment answered busy again. */
const BUSY_RETRY_MS = 30_000;
const MAX_RETRY_DELAY = Duration.minutes(10);
/** Past this many failures the schedule is at its cap, so stepping further changes nothing. */
const MAX_COUNTED_FAILURES = 25;

/**
 * Delays between delivery attempts while the environment is unreachable,
 * indexed by consecutive failures since it was last reached or woke us.
 * A wake means its tunnel just connected, but Cloudflare can take a few
 * minutes to route the hostname to it, so the first 3 minutes retry every
 * 10 s. After that the environment is likely gone again: 30 s, 1 min, 2 min,
 * ... up to 10 min.
 */
export const retrySchedule = Schedule.spaced("10 seconds").pipe(
  Schedule.upTo({ times: 18 }),
  Schedule.concat(
    Schedule.exponential("30 seconds").pipe(
      Schedule.modifyDelay(({ duration }) =>
        Effect.succeed(Duration.min(Duration.fromInputUnsafe(duration), MAX_RETRY_DELAY)),
      ),
    ),
  ),
);

export interface HeldHook {
  readonly id: string;
  readonly receivedAt: string;
  readonly method: string;
  /** Path segments exactly as the sender sent them; the environment decodes them. */
  readonly rawHookId: string;
  readonly rawToken: string;
  /** The decoded hook id, so every spelling of one hook shares its cap. */
  readonly hookKey: string;
  /** Without the leading `?`. */
  readonly query: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
}

/**
 * `delivered` deletes the request. `unreachable` keeps it and backs off the
 * whole inbox, since nothing else will get through either. `busy` keeps it
 * and its hook's later requests for the next run, but lets other hooks'
 * requests go ahead, so one stuck task cannot hold up the rest.
 */
export type DeliveryOutcome = "delivered" | "busy" | "unreachable";

/** The `retrySchedule` delay after `failures` consecutive unreachable attempts. */
export const retryDelayMs = Effect.fn("HookInboxStore.retryDelayMs")(function* (failures: number) {
  const step = yield* Schedule.toStep(retrySchedule);
  let delay = MAX_RETRY_DELAY;
  for (
    let attempt = 0;
    attempt < Math.min(Math.max(1, failures), MAX_COUNTED_FAILURES);
    attempt++
  ) {
    const next = yield* step(0, undefined).pipe(
      Effect.map(([, duration]) => Option.some(duration)),
      // The schedule never ends; stay at the cap if it ever does.
      Pull.catchDone(() => Effect.succeedNone),
    );
    if (Option.isNone(next)) break;
    delay = next.value;
  }
  return Duration.toMillis(delay);
});

const HeadersJson = Schema.fromJsonString(Schema.Record(Schema.String, Schema.String));
const encodeHeaders = Schema.encodeSync(HeadersJson);
const decodeHeaders = Schema.decodeUnknownOption(HeadersJson);

interface HeldHookRow {
  readonly seq: number;
  readonly id: string;
  readonly received_at: string;
  readonly method: string;
  readonly raw_hook_id: string;
  readonly raw_token: string;
  readonly hook_key: string;
  readonly query: string;
  readonly headers: string;
  readonly body: Uint8Array;
}

interface TargetRow {
  readonly base_url: string;
  readonly failures: number;
}

const iso = (epochMillis: number) => DateTime.formatIso(DateTime.makeUnsafe(epochMillis));

export const migrate = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS held_hooks (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      received_at TEXT NOT NULL,
      method TEXT NOT NULL,
      raw_hook_id TEXT NOT NULL,
      raw_token TEXT NOT NULL,
      hook_key TEXT NOT NULL,
      query TEXT NOT NULL,
      headers TEXT NOT NULL,
      body BLOB NOT NULL
    )
  `;
  yield* sql`CREATE INDEX IF NOT EXISTS held_hooks_hook ON held_hooks (hook_key)`;
  // Where to push, and how many attempts in a row have failed. One row.
  yield* sql`
    CREATE TABLE IF NOT EXISTS held_hooks_target (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      base_url TEXT NOT NULL,
      failures INTEGER NOT NULL DEFAULT 0
    )
  `;
});

const setTarget = (baseUrl: string, options: { readonly resetFailures: boolean }) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* options.resetFailures
      ? sql`
          INSERT INTO held_hooks_target (id, base_url) VALUES (1, ${baseUrl})
          ON CONFLICT (id) DO UPDATE SET base_url = excluded.base_url, failures = 0
        `
      : sql`
          INSERT INTO held_hooks_target (id, base_url) VALUES (1, ${baseUrl})
          ON CONFLICT (id) DO UPDATE SET base_url = excluded.base_url
        `;
  });

const readTarget = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<TargetRow>`SELECT base_url, failures FROM held_hooks_target WHERE id = 1`;
  return rows[0] ?? null;
});

const resetFailures = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`UPDATE held_hooks_target SET failures = 0 WHERE id = 1`;
});

/**
 * Counts one more unreachable attempt. Incremented in place, so a wake that
 * reset the count while this run's request was in flight is not overwritten.
 */
const countFailure = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly failures: number }>`
    UPDATE held_hooks_target SET failures = min(failures + 1, ${MAX_COUNTED_FAILURES})
    WHERE id = 1 RETURNING failures
  `;
  return rows[0]?.failures ?? 1;
});

const hasPending = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly id: string }>`SELECT id FROM held_hooks LIMIT 1`;
  return rows.length > 0;
});

/**
 * Stores a request for later delivery to `baseUrl`. Returns the time the
 * first attempt is due, or null when the inbox is full and nothing was stored.
 */
export const hold = Effect.fn("HookInboxStore.hold")(function* (hook: HeldHook, baseUrl: string) {
  const sql = yield* SqlClient.SqlClient;
  // One statement, so the caps hold however many requests arrive at once.
  const inserted = yield* sql<{ readonly id: string }>`
    INSERT INTO held_hooks
      (id, received_at, method, raw_hook_id, raw_token, hook_key, query, headers, body)
    SELECT ${hook.id}, ${hook.receivedAt}, ${hook.method}, ${hook.rawHookId}, ${hook.rawToken},
      ${hook.hookKey}, ${hook.query}, ${encodeHeaders(hook.headers)}, ${hook.body}
    WHERE (SELECT count(*) FROM held_hooks) < ${HOOK_INBOX_MAX_REQUESTS}
      AND (SELECT count(*) FROM held_hooks WHERE hook_key = ${hook.hookKey})
        < ${HOOK_INBOX_MAX_PER_HOOK}
      AND (SELECT coalesce(sum(length(body)), 0) FROM held_hooks) + ${hook.body.byteLength}
        <= ${HOOK_INBOX_MAX_BYTES}
    ON CONFLICT (id) DO NOTHING
    RETURNING id
  `;
  if (inserted.length === 0) {
    yield* Effect.annotateCurrentSpan({ "relay.inbox.refused": yield* refusalReason(hook) });
    return null;
  }
  yield* setTarget(baseUrl, { resetFailures: false });
  const target = yield* readTarget;
  const backlog = yield* backlogSize;
  yield* Effect.annotateCurrentSpan({
    "relay.inbox.held_count": backlog.count,
    "relay.inbox.held_bytes": backlog.bytes,
  });
  return (yield* Clock.currentTimeMillis) + (yield* retryDelayMs(target?.failures ?? 0));
});

const backlogSize = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly count: number; readonly bytes: number }>`
    SELECT count(*) AS count, coalesce(sum(length(body)), 0) AS bytes FROM held_hooks
  `;
  return rows[0] ?? { count: 0, bytes: 0 };
});

/** Which cap refused a request, or that it was already held, for traces. */
const refusalReason = (hook: HeldHook) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const existing = yield* sql<{ readonly id: string }>`
      SELECT id FROM held_hooks WHERE id = ${hook.id}
    `;
    if (existing.length > 0) return "already_held";
    const backlog = yield* backlogSize;
    if (backlog.count >= HOOK_INBOX_MAX_REQUESTS) return "max_requests";
    if (backlog.bytes + hook.body.byteLength > HOOK_INBOX_MAX_BYTES) return "max_bytes";
    return "max_per_hook";
  });

/**
 * The environment is reachable again at `baseUrl`. Returns whether anything
 * is waiting, so the caller can deliver right away.
 */
export const wake = Effect.fn("HookInboxStore.wake")(function* (baseUrl: string) {
  if (!(yield* hasPending)) return false;
  yield* setTarget(baseUrl, { resetFailures: true });
  return true;
});

export const clear = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DELETE FROM held_hooks`;
  yield* sql`DELETE FROM held_hooks_target`;
});

/**
 * Pushes the oldest held requests to the environment, one at a time, in
 * order per hook. Stops at the first sign the environment is unreachable;
 * skips past a hook whose environment answered busy. Drops requests older
 * than the TTL. Returns when the next run is due, or null when nothing is left.
 */
export const deliverDue = Effect.fn("HookInboxStore.deliverDue")(function* <R>(
  send: (baseUrl: string, hook: HeldHook) => Effect.Effect<DeliveryOutcome, never, R>,
) {
  const sql = yield* SqlClient.SqlClient;
  const startedAt = yield* Clock.currentTimeMillis;
  const expired = yield* sql<{ readonly id: string }>`
    DELETE FROM held_hooks WHERE received_at < ${iso(startedAt - HOOK_INBOX_TTL_MS)}
    RETURNING id
  `;
  const target = yield* readTarget;
  /** Oldest held requests after `afterSeq`, skipping hooks already found busy. */
  const readPage = (afterSeq: number, skip: ReadonlySet<string>) =>
    sql<HeldHookRow>`
      SELECT seq, id, received_at, method, raw_hook_id, raw_token, hook_key, query, headers, body
      FROM held_hooks
      WHERE seq > ${afterSeq}
        ${skip.size === 0 ? sql`` : sql`AND hook_key NOT IN ${sql.in([...skip])}`}
      ORDER BY seq LIMIT ${ROWS_READ_PER_PAGE}
    `;
  let batch = yield* readPage(0, new Set());
  if (batch.length === 0 || target === null) {
    if (target === null) yield* sql`DELETE FROM held_hooks`;
    // Empty, so the next request held starts the schedule from the top.
    else yield* resetFailures;
    yield* Effect.annotateCurrentSpan({ "relay.inbox.expired": expired.length });
    return null;
  }

  let failures = target.failures;
  let sent = 0;
  let delivered = 0;
  let unreadable = 0;
  let longestWaitMs = 0;
  const busyHooks = new Set<string>();
  /** What this run did, for the alarm's span; never request contents. */
  const annotateRun = (result: string) =>
    Effect.gen(function* () {
      const backlog = yield* backlogSize;
      yield* Effect.annotateCurrentSpan({
        "relay.inbox.run_result": result,
        "relay.inbox.sent": sent,
        "relay.inbox.delivered": delivered,
        "relay.inbox.busy_hooks": busyHooks.size,
        "relay.inbox.expired": expired.length,
        "relay.inbox.unreadable": unreadable,
        "relay.inbox.consecutive_failures": failures,
        "relay.inbox.longest_wait_ms": longestWaitMs,
        "relay.inbox.held_count": backlog.count,
        "relay.inbox.held_bytes": backlog.bytes,
      });
    });
  // Pages run out only once every non-busy request has been tried, so a
  // backlog behind busy hooks never hides another hook's requests.
  pages: while (batch.length > 0) {
    for (const row of batch) {
      if (sent === DELIVERIES_PER_RUN) break pages;
      // Later requests to a busy hook wait their turn, so its order is kept.
      if (busyHooks.has(row.hook_key)) continue;
      const headers = decodeHeaders(row.headers);
      if (Option.isNone(headers)) {
        // Unreadable: it can never be delivered, and must not block the rest.
        yield* sql`DELETE FROM held_hooks WHERE id = ${row.id}`;
        unreadable += 1;
        continue;
      }
      sent += 1;
      const outcome = yield* send(target.base_url, {
        id: row.id,
        receivedAt: row.received_at,
        method: row.method,
        rawHookId: row.raw_hook_id,
        rawToken: row.raw_token,
        hookKey: row.hook_key,
        query: row.query,
        headers: headers.value,
        body: row.body,
      });
      if (outcome === "unreachable") {
        failures = yield* countFailure;
        yield* annotateRun("unreachable");
        return (yield* Clock.currentTimeMillis) + (yield* retryDelayMs(failures));
      }
      if (failures !== 0) {
        failures = 0;
        yield* resetFailures;
      }
      if (outcome === "busy") {
        busyHooks.add(row.hook_key);
        continue;
      }
      yield* sql`DELETE FROM held_hooks WHERE id = ${row.id}`;
      delivered += 1;
      const receivedAtMs = DateTime.toEpochMillis(DateTime.makeUnsafe(row.received_at));
      longestWaitMs = Math.max(longestWaitMs, startedAt - receivedAtMs);
    }
    batch = yield* readPage(batch.at(-1)!.seq, busyHooks);
  }
  if (!(yield* hasPending)) {
    yield* resetFailures;
    yield* annotateRun("drained");
    return null;
  }
  // Everything left this run was busy: give those tasks a moment to drain.
  const now = yield* Clock.currentTimeMillis;
  const idle = delivered === 0 && busyHooks.size > 0;
  yield* annotateRun(idle ? "busy" : "more_pending");
  return idle ? now + BUSY_RETRY_MS : now;
});
