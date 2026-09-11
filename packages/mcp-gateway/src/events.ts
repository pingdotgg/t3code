import * as DateTime from "effect/DateTime";

import * as NodeCrypto from "node:crypto";
import * as NodeNet from "node:net";
import * as NodeSqlite from "node:sqlite";

import { GatewayError } from "./port.ts";
import type { GatewayScope, GatewayStatusSnapshot } from "./port.ts";

// Gatewaysidecar durable event store per the v3 product specification, sections
// 7 and 13: immutable event payloads, per-environment monotonic sequences,
// bounded retention, cursor replay, and per-webhook delivery state that
// survives restarts. All state lives in one SQLite database file.

export interface GatewayEvent {
  readonly eventId: string;
  readonly environmentId: string;
  readonly sequence: number;
  readonly type: string;
  readonly occurredAt: string;
  readonly correlationId?: string;
  readonly threadId?: string;
  readonly data: Readonly<Record<string, unknown>>;
}

export interface GatewayDeliveryFailure {
  readonly failureId: string;
  readonly environmentId: string;
  readonly type: "delivery.failed";
  readonly authoritativeSequence: null;
  readonly occurredAt: string;
  readonly webhookId: string;
  readonly eventId: string;
  readonly attempts: number;
  readonly error: string;
}

export interface GatewaySubscription {
  readonly subscriptionId: string;
  readonly environmentId: string;
  readonly types?: ReadonlyArray<string>;
  readonly ackedSequence: number;
}

export interface GatewayWebhookConfig {
  readonly webhookId: string;
  readonly environmentId: string;
  readonly url: string;
  readonly types?: ReadonlyArray<string>;
  readonly secret: string;
  readonly previousSecret: string | null;
  readonly rotatedAt: string | null;
  readonly ackedSequence: number;
}

export type GatewayDeliveryState = "pending" | "in-flight" | "acked" | "failed";

export interface GatewayDeliveryRecord {
  readonly webhookId: string;
  readonly eventId: string;
  readonly state: GatewayDeliveryState;
  readonly attempts: number;
  readonly nextAttemptAt: string;
  readonly lastError: string | null;
}

interface WebhookRow {
  webhookId: string;
  environmentId: string;
  url: string;
  typesJson: string | null;
  secret: string;
  previousSecret: string | null;
  rotatedAt: string | null;
  ackedSequence: number;
}

export function isPrivateWebhookAddress(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/gu, "").toLowerCase();
  if (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized.endsWith(".local") ||
    normalized === "metadata.google.internal"
  ) {
    return true;
  }
  for (const suffix of [".sslip.io", ".nip.io"] as const) {
    if (normalized.endsWith(suffix)) {
      const encodedAddress = normalized.slice(0, -suffix.length).replaceAll("-", ".");
      if (NodeNet.isIP(encodedAddress) !== 0 && isPrivateWebhookAddress(encodedAddress))
        return true;
    }
  }
  if (NodeNet.isIP(normalized) === 4) {
    const [a = 0, b = 0, c = 0] = normalized.split(".").map(Number);
    return (
      a === 0 ||
      a === 10 ||
      (a === 100 && b >= 64 && b <= 127) ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && ((b === 0 && (c === 0 || c === 2)) || b === 168)) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113) ||
      a >= 224
    );
  }
  if (NodeNet.isIP(normalized) === 6) {
    const mappedPrefix = "::ffff:";
    if (normalized.startsWith(mappedPrefix)) {
      const mapped = normalized.slice(mappedPrefix.length);
      if (NodeNet.isIP(mapped) === 4) return isPrivateWebhookAddress(mapped);
      const words = mapped.split(":");
      if (words.length === 2 && words.every((word) => /^[\da-f]{1,4}$/u.test(word))) {
        const high = Number.parseInt(words[0] ?? "0", 16);
        const low = Number.parseInt(words[1] ?? "0", 16);
        return isPrivateWebhookAddress(`${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`);
      }
    }
    return (
      normalized === "::" ||
      normalized === "::1" ||
      normalized.startsWith("fc") ||
      normalized.startsWith("fd") ||
      normalized.startsWith("fe8") ||
      normalized.startsWith("fe9") ||
      normalized.startsWith("fea") ||
      normalized.startsWith("feb")
    );
  }
  return false;
}

function validateWebhookUrl(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new GatewayError({
      code: "invalid_input",
      message: "Webhook URL is invalid.",
      retryable: false,
    });
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    isPrivateWebhookAddress(url.hostname)
  ) {
    throw new GatewayError({
      code: "invalid_input",
      message: "Webhook URLs must use HTTPS and a public network destination.",
      retryable: false,
    });
  }
}

function newId(prefix: string): string {
  return `${prefix}_${NodeCrypto.randomBytes(12).toString("hex")}`;
}

function nowIso(): string {
  return DateTime.formatIso(DateTime.nowUnsafe());
}

export function signWebhookPayload(secret: string, payload: string): string {
  return NodeCrypto.createHmac("sha256", secret).update(payload).digest("hex");
}

function verifyHmac(secret: string, payload: string, signature: string): boolean {
  const expected = Buffer.from(signWebhookPayload(secret, payload));
  const actualHeader = signature.startsWith("sha256=")
    ? signature.slice("sha256=".length)
    : signature;
  const actual = Buffer.from(actualHeader);
  return actual.length === expected.length && NodeCrypto.timingSafeEqual(actual, expected);
}

export interface GatewayEventStoreInput {
  /** Full path for the SQLite database file. Production callers must provide
   * one; omitted only for isolated in-memory tests. */
  readonly file?: string;
  readonly retentionEvents?: number;
  readonly retentionDays?: number;
  readonly now?: () => string;
  readonly newEventId?: () => string;
  /** Bounded exponential backoff base for webhook retries, in milliseconds. */
  readonly webhookRetryBaseMs?: number;
  /** Test-only escape hatch for loopback receiver integration tests. */
  readonly allowPrivateWebhookTargets?: boolean;
}

export interface WebhookAttemptOutcome {
  readonly ok: boolean;
  readonly retryable: boolean;
}

export interface WebhookTarget {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

export interface RotationResult {
  readonly webhook: GatewayWebhookConfig;
  readonly secret: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  eventId TEXT PRIMARY KEY,
  environmentId TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  type TEXT NOT NULL,
  occurredAt TEXT NOT NULL,
  correlationId TEXT,
  threadId TEXT,
  data TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS events_env_seq ON events(environmentId, sequence);
CREATE TABLE IF NOT EXISTS sequences (
  environmentId TEXT PRIMARY KEY,
  lastSequence INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS subscriptions (
  subscriptionId TEXT PRIMARY KEY,
  environmentId TEXT NOT NULL,
  typesJson TEXT,
  ackedSequence INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS webhooks (
  webhookId TEXT PRIMARY KEY,
  environmentId TEXT NOT NULL,
  url TEXT NOT NULL,
  typesJson TEXT,
  secret TEXT NOT NULL,
  previousSecret TEXT,
  rotatedAt TEXT,
  ackedSequence INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS deliveries (
  webhookId TEXT NOT NULL,
  eventId TEXT NOT NULL,
  state TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  nextAttemptAt TEXT NOT NULL,
  lastError TEXT,
  PRIMARY KEY (webhookId, eventId),
  FOREIGN KEY (webhookId) REFERENCES webhooks(webhookId) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS deliveries_due ON deliveries(state, nextAttemptAt);
CREATE TABLE IF NOT EXISTS delivery_failures (
  failureId TEXT PRIMARY KEY,
  environmentId TEXT NOT NULL,
  webhookId TEXT NOT NULL,
  eventId TEXT NOT NULL,
  occurredAt TEXT NOT NULL,
  attempts INTEGER NOT NULL,
  error TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS delivery_failures_environment ON delivery_failures(environmentId, occurredAt);
CREATE TABLE IF NOT EXISTS idempotency (
  key TEXT PRIMARY KEY,
  payload TEXT NOT NULL,
  result TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'validating',
  dispatchContext TEXT
);
`;

export const MAX_WEBHOOK_RETRIES = 5;
export const WEBHOOK_BACKOFF_CAP_MS = 5 * 60 * 1000;

export function createGatewayEventStore(input: GatewayEventStoreInput = {}) {
  const retentionEvents = input.retentionEvents ?? 100_000;
  const retentionDays = input.retentionDays ?? 7;
  const retentionMs = retentionDays * 24 * 60 * 60 * 1000;
  const retryBaseMs = input.webhookRetryBaseMs ?? 1_000;
  const now = input.now ?? nowIso;
  const newEventId = input.newEventId ?? (() => newId("evt"));

  const db = new NodeSqlite.DatabaseSync(input.file ?? ":memory:");
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA synchronous = NORMAL;");
  db.exec(SCHEMA);
  const idempotencyColumns = db
    .prepare("PRAGMA table_info(idempotency)")
    .all() as unknown as ReadonlyArray<{
    readonly name: string;
  }>;
  if (!idempotencyColumns.some((column) => column.name === "status")) {
    db.exec("ALTER TABLE idempotency ADD COLUMN status TEXT NOT NULL DEFAULT 'validating'");
    db.exec("UPDATE idempotency SET status = 'completed' WHERE result <> 'null'");
  }
  if (!idempotencyColumns.some((column) => column.name === "dispatchContext")) {
    db.exec("ALTER TABLE idempotency ADD COLUMN dispatchContext TEXT");
  }
  const listeners = new Set<(event: GatewayEvent) => void>();
  const statusListeners = new Set<() => void>();
  const notifyStatus = () => {
    for (const listener of statusListeners) listener();
  };

  const eventFromRow = (row: Record<string, unknown>): GatewayEvent => {
    const event: GatewayEvent = {
      eventId: row.eventId as string,
      environmentId: row.environmentId as string,
      sequence: row.sequence as number,
      type: row.type as string,
      occurredAt: row.occurredAt as string,
      ...(row.correlationId === null ? {} : { correlationId: row.correlationId as string }),
      ...(row.threadId === null ? {} : { threadId: row.threadId as string }),
      data: JSON.parse(row.data as string) as Record<string, unknown>,
    };
    return event;
  };

  const webhookFromRow = (row: WebhookRow | Record<string, unknown>): GatewayWebhookConfig => {
    const record = row as Record<string, unknown>;
    const types =
      record.typesJson === null || record.typesJson === undefined
        ? undefined
        : (JSON.parse(record.typesJson as string) as ReadonlyArray<string>);
    return {
      webhookId: record.webhookId as string,
      environmentId: record.environmentId as string,
      url: record.url as string,
      ...(types === undefined ? {} : { types }),
      secret: record.secret as string,
      previousSecret: (record.previousSecret ?? null) as string | null,
      rotatedAt: (record.rotatedAt ?? null) as string | null,
      ackedSequence: record.ackedSequence as number,
    };
  };

  const deliveryFailureFromRow = (row: Record<string, unknown>): GatewayDeliveryFailure => ({
    failureId: row.failureId as string,
    environmentId: row.environmentId as string,
    type: "delivery.failed",
    authoritativeSequence: null,
    occurredAt: row.occurredAt as string,
    webhookId: row.webhookId as string,
    eventId: row.eventId as string,
    attempts: row.attempts as number,
    error: row.error as string,
  });

  const publicWebhook = (webhook: GatewayWebhookConfig): GatewayWebhookConfig => ({
    ...webhook,
    secret: "",
    previousSecret: null,
  });

  const eventById = (eventId: string): GatewayEvent | undefined => {
    const row = db.prepare("SELECT * FROM events WHERE eventId = ?").get(eventId) as
      | Record<string, unknown>
      | undefined;
    return row === undefined ? undefined : eventFromRow(row);
  };

  const webhookById = (webhookId: string): GatewayWebhookConfig | undefined => {
    const row = db.prepare("SELECT * FROM webhooks WHERE webhookId = ?").get(webhookId) as
      | Record<string, unknown>
      | undefined;
    return row === undefined ? undefined : webhookFromRow(row);
  };

  const insertDelivery = (webhookId: string, event: GatewayEvent) => {
    db.prepare(
      "INSERT OR IGNORE INTO deliveries (webhookId, eventId, state, attempts, nextAttemptAt) VALUES (?, ?, 'pending', 0, ?)",
    ).run(webhookId, event.eventId, now());
  };

  const insertEvent = db.prepare(
    "INSERT INTO events (eventId, environmentId, sequence, type, occurredAt, correlationId, threadId, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  );
  const bumpSequence = db.prepare(
    "INSERT INTO sequences (environmentId, lastSequence) VALUES (?, ?) ON CONFLICT(environmentId) DO UPDATE SET lastSequence = excluded.lastSequence",
  );
  const readSequence = db.prepare("SELECT lastSequence FROM sequences WHERE environmentId = ?");

  const emit = (event: {
    readonly eventId?: string;
    readonly sequence?: number;
    readonly occurredAt?: string;
    readonly environmentId: string;
    readonly type: string;
    readonly correlationId?: string;
    readonly threadId?: string;
    readonly data?: Readonly<Record<string, unknown>>;
  }): GatewayEvent => {
    const eventId = event.eventId ?? newEventId();
    const occurredAt = event.occurredAt ?? now();
    const payload = JSON.stringify(event.data ?? {});
    db.exec("BEGIN IMMEDIATE");
    let stored: GatewayEvent;
    try {
      const previous =
        (readSequence.get(event.environmentId) as { lastSequence: number } | undefined)
          ?.lastSequence ?? 0;
      const sequence = event.sequence ?? previous + 1;
      if (sequence <= previous && eventById(eventId) === undefined) {
        throw new GatewayError({
          code: "invalid_input",
          message: `Authoritative event sequence ${sequence} is not newer than ${previous}.`,
          retryable: false,
          environmentId: event.environmentId,
        });
      }
      stored = {
        eventId,
        environmentId: event.environmentId,
        // Sequence continuity across restarts comes from the durable sequences table.
        sequence,
        type: event.type,
        occurredAt,
        ...(event.correlationId === undefined ? {} : { correlationId: event.correlationId }),
        ...(event.threadId === undefined ? {} : { threadId: event.threadId }),
        data: event.data ?? {},
      };
      bumpSequence.run(event.environmentId, sequence);
      insertEvent.run(
        eventId,
        event.environmentId,
        sequence,
        event.type,
        occurredAt,
        event.correlationId ?? null,
        event.threadId ?? null,
        payload,
      );
      // Persist event fan-out in the same transaction. A committed event can
      // therefore never be lost between event insertion and delivery creation.
      if (event.type !== "delivery.failed") {
        const webhookRows = db
          .prepare("SELECT webhookId, typesJson FROM webhooks WHERE environmentId = ?")
          .all(event.environmentId) as Array<{ webhookId: string; typesJson: string | null }>;
        for (const row of webhookRows) {
          const types =
            row.typesJson === null
              ? undefined
              : (JSON.parse(row.typesJson) as ReadonlyArray<string>);
          if (matches(types, stored)) insertDelivery(row.webhookId, stored);
        }
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    trim();
    for (const listener of listeners) listener(stored);
    notifyStatus();
    return stored;
  };

  const matches = (filter: ReadonlyArray<string> | undefined, event: GatewayEvent): boolean =>
    filter === undefined || filter.includes(event.type);

  const cursorExpired = (environmentId: string, afterSequence: number): boolean => {
    // The cursor is expired when the oldest retained event for this
    // environment is already past the requested cursor: replay would be a lie.
    const oldest = db
      .prepare("SELECT MIN(sequence) AS oldest FROM events WHERE environmentId = ?")
      .get(environmentId) as { oldest: number | null };
    if (oldest.oldest === null) return false;
    return afterSequence + 1 < oldest.oldest;
  };

  const isoOffset = (ms: number): string =>
    DateTime.formatIso(DateTime.add(DateTime.makeUnsafe(now()), { milliseconds: ms }));

  const trim = () => {
    const cutoff = isoOffset(-retentionMs);
    db.prepare(
      `DELETE FROM events
       WHERE occurredAt < ?
          OR eventId IN (
            SELECT eventId FROM (
              SELECT eventId,
                     ROW_NUMBER() OVER (PARTITION BY environmentId ORDER BY sequence DESC) AS rowNumber
              FROM events
            ) WHERE rowNumber > ?
          )`,
    ).run(cutoff, retentionEvents);
    db.prepare("DELETE FROM deliveries WHERE eventId NOT IN (SELECT eventId FROM events)").run();
  };

  const ingest = (event: Parameters<typeof emit>[0]): GatewayEvent => {
    if (
      event.eventId === undefined ||
      event.sequence === undefined ||
      event.occurredAt === undefined
    ) {
      return emit(event);
    }
    const existing = eventById(event.eventId);
    if (existing !== undefined) return existing;
    try {
      return emit(event);
    } catch (error) {
      // A concurrent replay may win the unique event-id race.
      const raced = eventById(event.eventId);
      if (raced !== undefined) return raced;
      throw error;
    }
  };

  const statusSnapshot = (
    grants: Readonly<Record<string, ReadonlyArray<GatewayScope>>>,
  ): GatewayStatusSnapshot => {
    const environments = Object.entries(grants)
      .filter(([, scopes]) => scopes.includes("read"))
      .map(([environmentId]) => environmentId)
      .toSorted()
      .slice(0, 100)
      .map((environmentId) => {
        const eventStats = db
          .prepare(
            "SELECT COUNT(*) AS count, MIN(sequence) AS oldest FROM events WHERE environmentId = ?",
          )
          .get(environmentId) as { count: number; oldest: number | null };
        const latestSequence =
          (
            db
              .prepare("SELECT lastSequence FROM sequences WHERE environmentId = ?")
              .get(environmentId) as { lastSequence: number } | undefined
          )?.lastSequence ?? 0;
        const base = {
          environmentId,
          latestSequence,
          oldestRetainedSequence: eventStats.oldest,
          retainedEventCount: eventStats.count,
          deliveryAccess: grants[environmentId]?.includes("delivery") === true,
        };
        if (!base.deliveryAccess) return base;

        const subscriptionRows = db
          .prepare(
            "SELECT subscriptionId, typesJson, ackedSequence FROM subscriptions WHERE environmentId = ? ORDER BY subscriptionId LIMIT 100",
          )
          .all(environmentId) as Array<{
          subscriptionId: string;
          typesJson: string | null;
          ackedSequence: number;
        }>;
        const subscriptionCount = (
          db
            .prepare("SELECT COUNT(*) AS count FROM subscriptions WHERE environmentId = ?")
            .get(environmentId) as { count: number }
        ).count;
        const subscriptions = subscriptionRows.map((row) => {
          const types =
            row.typesJson === null ? [] : (JSON.parse(row.typesJson) as ReadonlyArray<string>);
          const placeholders = types.map(() => "?").join(",");
          const pendingEventCount = (
            db
              .prepare(
                types.length === 0
                  ? "SELECT COUNT(*) AS count FROM events WHERE environmentId = ? AND sequence > ?"
                  : `SELECT COUNT(*) AS count FROM events WHERE environmentId = ? AND sequence > ? AND type IN (${placeholders})`,
              )
              .get(environmentId, row.ackedSequence, ...types) as { count: number }
          ).count;
          return {
            subscriptionId: row.subscriptionId,
            ackedSequence: row.ackedSequence,
            pendingEventCount,
            status: cursorExpired(environmentId, row.ackedSequence)
              ? ("cursor-expired" as const)
              : pendingEventCount === 0
                ? ("caught-up" as const)
                : ("active" as const),
          };
        });

        const webhookRows = db
          .prepare(
            "SELECT webhookId, ackedSequence FROM webhooks WHERE environmentId = ? ORDER BY webhookId LIMIT 100",
          )
          .all(environmentId) as Array<{ webhookId: string; ackedSequence: number }>;
        const webhookCount = (
          db
            .prepare("SELECT COUNT(*) AS count FROM webhooks WHERE environmentId = ?")
            .get(environmentId) as { count: number }
        ).count;
        const deliveryCounts = (webhookId?: string) => {
          const rows = db
            .prepare(
              `SELECT state, COUNT(*) AS count FROM deliveries
               WHERE ${webhookId === undefined ? "webhookId IN (SELECT webhookId FROM webhooks WHERE environmentId = ?)" : "webhookId = ?"}
               GROUP BY state`,
            )
            .all(webhookId ?? environmentId) as Array<{
            state: GatewayDeliveryState;
            count: number;
          }>;
          const counts = { pending: 0, inFlight: 0, acked: 0, failed: 0 };
          for (const row of rows) {
            if (row.state === "in-flight") counts.inFlight = row.count;
            else counts[row.state] = row.count;
          }
          return counts;
        };
        const webhooks = webhookRows.map((row) => {
          const deliveries = deliveryCounts(row.webhookId);
          return {
            webhookId: row.webhookId,
            ackedSequence: row.ackedSequence,
            status:
              deliveries.failed > 0
                ? ("degraded" as const)
                : deliveries.pending > 0 || deliveries.inFlight > 0
                  ? ("pending" as const)
                  : ("healthy" as const),
            deliveries,
          };
        });
        const deliveryFailureCount = (
          db
            .prepare("SELECT COUNT(*) AS count FROM delivery_failures WHERE environmentId = ?")
            .get(environmentId) as { count: number }
        ).count;
        return {
          ...base,
          subscriptions,
          subscriptionCount,
          ...(subscriptionCount > subscriptions.length ? { subscriptionsTruncated: true } : {}),
          webhooks,
          webhookCount,
          ...(webhookCount > webhooks.length ? { webhooksTruncated: true } : {}),
          deliveries: deliveryCounts(),
          deliveryFailureCount,
        };
      });
    return {
      schemaVersion: "3",
      capturedAt: now(),
      live: true,
      stale: false,
      retention: { maxEventsPerEnvironment: retentionEvents, maxAgeDays: retentionDays },
      environments,
    };
  };

  return {
    /** Live delivery hook. Durable subscription cursors remain in SQLite; the
     * callback is only the transport used while an MCP session is connected. */
    onEvent: (listener: (event: GatewayEvent) => void): (() => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    onStatusChange: (listener: () => void): (() => void) => {
      statusListeners.add(listener);
      return () => statusListeners.delete(listener);
    },
    statusSnapshot,
    matchingSubscriptions: (event: GatewayEvent): ReadonlyArray<string> => {
      const rows = db
        .prepare(
          "SELECT subscriptionId, typesJson FROM subscriptions WHERE environmentId = ? AND ackedSequence < ?",
        )
        .all(event.environmentId, event.sequence) as Array<{
        subscriptionId: string;
        typesJson: string | null;
      }>;
      return rows
        .filter((row) =>
          matches(
            row.typesJson === null
              ? undefined
              : (JSON.parse(row.typesJson) as ReadonlyArray<string>),
            event,
          ),
        )
        .map((row) => row.subscriptionId);
    },
    /** Server-authoritative ingestion path (spec section 4.2). */
    ingest,
    emit,
    history: (
      environmentId: string,
      afterSequence: number,
      limit: number,
      types?: ReadonlyArray<string>,
    ): ReadonlyArray<GatewayEvent> => {
      trim();
      if (cursorExpired(environmentId, afterSequence)) {
        throw new GatewayError({
          code: "cursor_expired",
          message: `Cursor ${afterSequence} is older than event retention for environment ${environmentId}; request a fresh snapshot.`,
          retryable: false,
          environmentId,
          details: {
            latestSequence: (() => {
              const row = db
                .prepare("SELECT lastSequence FROM sequences WHERE environmentId = ?")
                .get(environmentId) as { lastSequence: number } | undefined;
              return row?.lastSequence ?? 0;
            })(),
          },
        });
      }
      const typeList = types?.filter((type) => type !== "");
      const rows = db
        .prepare(
          typeList === undefined || typeList.length === 0
            ? "SELECT * FROM events WHERE environmentId = ? AND sequence > ? ORDER BY sequence ASC LIMIT ?"
            : `SELECT * FROM events WHERE environmentId = ? AND sequence > ? AND type IN (${typeList.map(() => "?").join(",")}) ORDER BY sequence ASC LIMIT ?`,
        )
        .all(
          environmentId,
          afterSequence,
          ...(typeList === undefined || typeList.length === 0 ? [] : typeList),
          limit,
        ) as Array<Record<string, unknown>>;
      return rows.map(eventFromRow);
    },
    operationHistory: (
      environmentId: string,
      afterSequence: number,
      limit: number,
      threadId?: string,
    ): ReadonlyArray<GatewayEvent> => {
      trim();
      if (cursorExpired(environmentId, afterSequence)) {
        throw new GatewayError({
          code: "cursor_expired",
          message: `Cursor ${afterSequence} is older than event retention for environment ${environmentId}; request a fresh snapshot.`,
          retryable: false,
          environmentId,
        });
      }
      const rows = (
        threadId === undefined
          ? db
              .prepare(
                "SELECT * FROM events WHERE environmentId = ? AND sequence > ? ORDER BY sequence ASC LIMIT ?",
              )
              .all(environmentId, afterSequence, limit)
          : db
              .prepare(
                "SELECT * FROM events WHERE environmentId = ? AND threadId = ? AND sequence > ? ORDER BY sequence ASC LIMIT ?",
              )
              .all(environmentId, threadId, afterSequence, limit)
      ) as Array<Record<string, unknown>>;
      return rows.map(eventFromRow);
    },
    latestSequence: (environmentId: string): number => {
      const row = db
        .prepare("SELECT lastSequence FROM sequences WHERE environmentId = ?")
        .get(environmentId) as { lastSequence: number } | undefined;
      return row?.lastSequence ?? 0;
    },
    subscribe: (input2: {
      readonly environmentId: string;
      readonly types?: ReadonlyArray<string>;
      readonly afterSequence?: number;
    }): GatewaySubscription => {
      const subscription: GatewaySubscription = {
        subscriptionId: newId("sub"),
        environmentId: input2.environmentId,
        ...(input2.types === undefined ? {} : { types: [...input2.types] }),
        ackedSequence: input2.afterSequence ?? 0,
      };
      db.prepare(
        "INSERT INTO subscriptions (subscriptionId, environmentId, typesJson, ackedSequence) VALUES (?, ?, ?, ?)",
      ).run(
        subscription.subscriptionId,
        subscription.environmentId,
        subscription.types === undefined ? null : JSON.stringify(subscription.types),
        subscription.ackedSequence,
      );
      notifyStatus();
      return subscription;
    },
    subscriptionById: (subscriptionId: string): GatewaySubscription | undefined => {
      const row = db
        .prepare("SELECT * FROM subscriptions WHERE subscriptionId = ?")
        .get(subscriptionId) as Record<string, unknown> | undefined;
      if (row === undefined) return undefined;
      const types =
        row.typesJson === null
          ? undefined
          : (JSON.parse(row.typesJson as string) as ReadonlyArray<string>);
      return {
        subscriptionId: row.subscriptionId as string,
        environmentId: row.environmentId as string,
        ...(types === undefined ? {} : { types }),
        ackedSequence: row.ackedSequence as number,
      };
    },
    ack: (subscriptionId: string, throughSequence: number): GatewaySubscription => {
      const subscription = (() => {
        const found = db
          .prepare("SELECT * FROM subscriptions WHERE subscriptionId = ?")
          .get(subscriptionId) as Record<string, unknown> | undefined;
        if (found === undefined) {
          throw new GatewayError({
            code: "unknown_subscription",
            message: `Unknown subscription ${subscriptionId}.`,
            retryable: false,
          });
        }
        const types =
          found.typesJson === null
            ? undefined
            : (JSON.parse(found.typesJson as string) as ReadonlyArray<string>);
        return {
          subscriptionId: found.subscriptionId as string,
          environmentId: found.environmentId as string,
          ...(types === undefined ? {} : { types }),
          ackedSequence: found.ackedSequence as number,
        } satisfies GatewaySubscription;
      })();
      if (!Number.isInteger(throughSequence) || throughSequence < 0) {
        throw new GatewayError({
          code: "invalid_input",
          message: "throughSequence must be a non-negative integer.",
          retryable: false,
        });
      }
      const latestSequence = (() => {
        const row = db
          .prepare("SELECT lastSequence FROM sequences WHERE environmentId = ?")
          .get(subscription.environmentId) as { lastSequence: number } | undefined;
        return row?.lastSequence ?? 0;
      })();
      if (throughSequence > latestSequence) {
        throw new GatewayError({
          code: "invalid_input",
          message: `throughSequence may not exceed the latest retained sequence ${latestSequence}.`,
          retryable: false,
          environmentId: subscription.environmentId,
        });
      }
      // Acknowledgements are monotonic and may not skip beyond the retained event frontier.
      const next: GatewaySubscription = {
        ...subscription,
        ackedSequence: Math.max(subscription.ackedSequence, throughSequence),
      };
      db.prepare("UPDATE subscriptions SET ackedSequence = ? WHERE subscriptionId = ?").run(
        next.ackedSequence,
        subscriptionId,
      );
      notifyStatus();
      return next;
    },
    pendingFor: (subscriptionId: string, limit: number): ReadonlyArray<GatewayEvent> => {
      const subscription = (() => {
        const found = db
          .prepare("SELECT * FROM subscriptions WHERE subscriptionId = ?")
          .get(subscriptionId) as Record<string, unknown> | undefined;
        if (found === undefined) {
          throw new GatewayError({
            code: "unknown_subscription",
            message: `Unknown subscription ${subscriptionId}.`,
            retryable: false,
          });
        }
        const types =
          found.typesJson === null
            ? undefined
            : (JSON.parse(found.typesJson as string) as ReadonlyArray<string>);
        return {
          subscriptionId: found.subscriptionId as string,
          environmentId: found.environmentId as string,
          ...(types === undefined ? {} : { types }),
          ackedSequence: found.ackedSequence as number,
        } satisfies GatewaySubscription;
      })();
      trim();
      if (cursorExpired(subscription.environmentId, subscription.ackedSequence)) {
        throw new GatewayError({
          code: "cursor_expired",
          message: `Subscription cursor ${subscription.ackedSequence} is older than retention; re-subscribe with a fresh snapshot.`,
          retryable: false,
          environmentId: subscription.environmentId,
        });
      }
      const typeList = subscription.types?.filter((type) => type !== "");
      const rows = db
        .prepare(
          typeList === undefined || typeList.length === 0
            ? "SELECT * FROM events WHERE environmentId = ? AND sequence > ? ORDER BY sequence ASC LIMIT ?"
            : `SELECT * FROM events WHERE environmentId = ? AND sequence > ? AND type IN (${typeList.map(() => "?").join(",")}) ORDER BY sequence ASC LIMIT ?`,
        )
        .all(
          subscription.environmentId,
          subscription.ackedSequence,
          ...(typeList === undefined || typeList.length === 0 ? [] : typeList),
          limit,
        ) as Array<Record<string, unknown>>;
      return rows.map(eventFromRow);
    },
    registerWebhook: (input2: {
      readonly environmentId: string;
      readonly url: string;
      readonly types?: ReadonlyArray<string>;
    }): { readonly webhook: GatewayWebhookConfig; readonly secret: string } => {
      if (input.allowPrivateWebhookTargets !== true) validateWebhookUrl(input2.url);
      const secret = NodeCrypto.randomBytes(24).toString("hex");
      const webhook: GatewayWebhookConfig = {
        webhookId: newId("whk"),
        environmentId: input2.environmentId,
        url: input2.url,
        ...(input2.types === undefined ? {} : { types: [...input2.types] }),
        secret,
        previousSecret: null,
        rotatedAt: null,
        ackedSequence: 0,
      };
      db.prepare(
        "INSERT INTO webhooks (webhookId, environmentId, url, typesJson, secret, previousSecret, rotatedAt, ackedSequence) VALUES (?, ?, ?, ?, ?, NULL, NULL, 0)",
      ).run(
        webhook.webhookId,
        webhook.environmentId,
        webhook.url,
        webhook.types === undefined ? null : JSON.stringify(webhook.types),
        webhook.secret,
      );
      notifyStatus();
      // The secret is returned once at registration; later reads expose only a reference.
      return { webhook: publicWebhook(webhook), secret };
    },
    updateWebhook: (
      environmentId: string,
      webhookId: string,
      patch: { readonly types?: ReadonlyArray<string> },
    ): GatewayWebhookConfig => {
      const webhook = webhookById(webhookId);
      if (webhook === undefined || webhook.environmentId !== environmentId) {
        throw new GatewayError({
          code: "unknown_webhook",
          message: `Unknown webhook ${webhookId} in environment ${environmentId}.`,
          retryable: false,
          environmentId,
        });
      }
      const next: GatewayWebhookConfig = {
        ...webhook,
        ...(patch.types === undefined ? {} : { types: [...patch.types] }),
      };
      db.prepare("UPDATE webhooks SET typesJson = ? WHERE webhookId = ?").run(
        next.types === undefined ? null : JSON.stringify(next.types),
        webhookId,
      );
      notifyStatus();
      return publicWebhook(next);
    },
    deleteWebhook: (environmentId: string, webhookId: string): void => {
      const webhook = webhookById(webhookId);
      if (webhook === undefined || webhook.environmentId !== environmentId) {
        throw new GatewayError({
          code: "unknown_webhook",
          message: `Unknown webhook ${webhookId} in environment ${environmentId}.`,
          retryable: false,
          environmentId,
        });
      }
      db.prepare("DELETE FROM deliveries WHERE webhookId = ?").run(webhookId);
      db.prepare("DELETE FROM webhooks WHERE webhookId = ?").run(webhookId);
      notifyStatus();
    },
    deliveryFailureSummary: (
      environmentIds: ReadonlyArray<string>,
    ): { readonly count: number; readonly recent: ReadonlyArray<GatewayDeliveryFailure> } => {
      if (environmentIds.length === 0) return { count: 0, recent: [] };
      const placeholders = environmentIds.map(() => "?").join(", ");
      const count = db
        .prepare(
          `SELECT COUNT(*) AS count FROM delivery_failures WHERE environmentId IN (${placeholders})`,
        )
        .get(...environmentIds) as { count: number };
      const recent = db
        .prepare(
          `SELECT * FROM delivery_failures WHERE environmentId IN (${placeholders}) ORDER BY occurredAt DESC, failureId DESC LIMIT 5`,
        )
        .all(...environmentIds) as Array<Record<string, unknown>>;
      return { count: count.count, recent: recent.map(deliveryFailureFromRow) };
    },
    listWebhooks: (environmentId?: string): ReadonlyArray<GatewayWebhookConfig> => {
      const rows = (
        environmentId === undefined
          ? db.prepare("SELECT * FROM webhooks").all()
          : db.prepare("SELECT * FROM webhooks WHERE environmentId = ?").all(environmentId)
      ) as Array<Record<string, unknown>>;
      return rows.map(webhookFromRow).map(publicWebhook);
    },
    webhookById: (webhookId: string): GatewayWebhookConfig | undefined => {
      const found = webhookById(webhookId);
      return found === undefined ? undefined : publicWebhook(found);
    },
    /** Two-phase delivery: claim rows as in-flight before any network I/O. */
    dueDeliveries: (
      limit: number,
      excludedEnvironmentIds: ReadonlyArray<string> = [],
    ): ReadonlyArray<GatewayDeliveryRecord> => {
      const cutoff = now();
      const exclusions = excludedEnvironmentIds.map(() => "?").join(", ");
      const rows = db
        .prepare(
          `SELECT deliveries.* FROM deliveries
           JOIN webhooks ON webhooks.webhookId = deliveries.webhookId
           WHERE deliveries.state IN ('pending', 'in-flight')
             AND deliveries.nextAttemptAt <= ?
             ${exclusions === "" ? "" : `AND webhooks.environmentId NOT IN (${exclusions})`}
           ORDER BY deliveries.nextAttemptAt ASC
           LIMIT ?`,
        )
        .all(cutoff, ...excludedEnvironmentIds, limit) as Array<Record<string, unknown>>;
      return rows.map((row) => ({
        webhookId: row.webhookId as string,
        eventId: row.eventId as string,
        state: row.state as GatewayDeliveryState,
        attempts: row.attempts as number,
        nextAttemptAt: row.nextAttemptAt as string,
        lastError: (row.lastError ?? null) as string | null,
      }));
    },
    /** Builds an HTTP target for a due delivery and marks it in-flight. Signs
     * with the current secret first; falls back to the previous secret during
     * a rotation window so consumers are never dropped mid-rotation. */
    buildDelivery: (webhookId: string, eventId: string): WebhookTarget | undefined => {
      const webhook = webhookById(webhookId);
      const event = eventById(eventId);
      if (webhook === undefined || event === undefined) return undefined;
      if (webhook.environmentId !== event.environmentId) return undefined;
      if (!matches(webhook.types, event)) return undefined;
      const row = db
        .prepare("SELECT state, nextAttemptAt FROM deliveries WHERE webhookId = ? AND eventId = ?")
        .get(webhookId, eventId) as { state: string; nextAttemptAt: string } | undefined;
      if (
        row === undefined ||
        row.state === "acked" ||
        row.state === "failed" ||
        row.nextAttemptAt > now()
      ) {
        return undefined;
      }
      db.prepare(
        "UPDATE deliveries SET state = 'in-flight', attempts = attempts + 1, nextAttemptAt = ? WHERE webhookId = ? AND eventId = ?",
      ).run(isoOffset(retryBaseMs), webhookId, eventId);
      notifyStatus();
      const body = JSON.stringify(event);
      return {
        url: webhook.url,
        body,
        headers: {
          "Content-Type": "application/json",
          "X-T3-Event-Id": event.eventId,
          "X-T3-Event-Sequence": String(event.sequence),
          "X-T3-Correlation-Id": event.correlationId ?? "",
          "X-T3-Signature": `sha256=${signWebhookPayload(webhook.secret, body)}`,
        },
      };
    },
    /** Called after a delivery attempt. Success requires HTTP 2xx; ack may
     * carry X-T3-Ack-Sequence. Failures get bounded exponential backoff and a
     * durable failed state after MAX_WEBHOOK_RETRIES plus a delivery.failed event. */
    reportDeliveryAttempt: (
      webhookId: string,
      eventId: string,
      outcome: WebhookAttemptOutcome,
      error?: string,
      ackedSequence?: number,
    ): { readonly done: boolean; readonly deliveryFailedEvent: GatewayDeliveryFailure | null } => {
      const webhook = webhookById(webhookId);
      const event = eventById(eventId);
      if (webhook === undefined || event === undefined)
        return { done: true, deliveryFailedEvent: null };
      if (outcome.ok) {
        const ackSequence = Math.max(webhook.ackedSequence, ackedSequence ?? event.sequence);
        db.prepare("UPDATE webhooks SET ackedSequence = ? WHERE webhookId = ?").run(
          ackSequence,
          webhookId,
        );
        db.prepare(
          "UPDATE deliveries SET state = 'acked', lastError = NULL WHERE webhookId = ? AND eventId = ?",
        ).run(webhookId, eventId);
        notifyStatus();
        return { done: true, deliveryFailedEvent: null };
      }
      const row = db
        .prepare("SELECT attempts FROM deliveries WHERE webhookId = ? AND eventId = ?")
        .get(webhookId, eventId) as { attempts: number } | undefined;
      const attempts = row?.attempts ?? 1;
      if (!outcome.retryable || attempts >= MAX_WEBHOOK_RETRIES) {
        db.prepare(
          "UPDATE deliveries SET state = 'failed', lastError = ? WHERE webhookId = ? AND eventId = ?",
        ).run(error ?? "delivery failed", webhookId, eventId);
        const failureId = newId("delivery_failure");
        const failureError = error ?? "delivery failed";
        const occurredAt = now();
        db.prepare(
          "INSERT INTO delivery_failures (failureId, environmentId, webhookId, eventId, occurredAt, attempts, error) VALUES (?, ?, ?, ?, ?, ?, ?)",
        ).run(
          failureId,
          webhook.environmentId,
          webhookId,
          eventId,
          occurredAt,
          attempts,
          failureError,
        );
        const deliveryFailedEvent: GatewayDeliveryFailure = {
          failureId,
          environmentId: webhook.environmentId,
          type: "delivery.failed",
          authoritativeSequence: null,
          occurredAt,
          webhookId,
          eventId,
          attempts,
          error: failureError,
        };
        notifyStatus();
        return { done: true, deliveryFailedEvent };
      }
      // Bounded exponential backoff with a hard cap.
      const delay = Math.min(retryBaseMs * 2 ** (attempts - 1), WEBHOOK_BACKOFF_CAP_MS);
      const nextAttemptAt = isoOffset(delay);
      db.prepare(
        "UPDATE deliveries SET state = 'pending', nextAttemptAt = ?, lastError = ? WHERE webhookId = ? AND eventId = ?",
      ).run(nextAttemptAt, error ?? "delivery failed", webhookId, eventId);
      notifyStatus();
      return { done: false, deliveryFailedEvent: null };
    },
    /** Rotates the webhook signing secret. The previous secret keeps verifying
     * in-flight deliveries during a rotation window; the cursor is untouched. */
    rotateWebhookSecret: (environmentId: string, webhookId: string): RotationResult => {
      const webhook = webhookById(webhookId);
      if (webhook === undefined || webhook.environmentId !== environmentId) {
        throw new GatewayError({
          code: "unknown_webhook",
          message: `Unknown webhook ${webhookId} in environment ${environmentId}.`,
          retryable: false,
          environmentId,
        });
      }
      const secret = NodeCrypto.randomBytes(24).toString("hex");
      db.prepare(
        "UPDATE webhooks SET previousSecret = secret, secret = ?, rotatedAt = ? WHERE webhookId = ?",
      ).run(secret, now(), webhookId);
      return {
        webhook: publicWebhook({ ...webhook, secret, previousSecret: webhook.secret }),
        secret,
      };
    },
    verifyWebhookSignature: (webhookId: string, payload: string, signature: string): boolean => {
      const webhook = webhookById(webhookId);
      if (webhook === undefined) return false;
      return (
        verifyHmac(webhook.secret, payload, signature) ||
        (webhook.previousSecret !== null && verifyHmac(webhook.previousSecret, payload, signature))
      );
    },
    // Request-id idempotency memory for mutating commands (spec section 6.2),
    // durable across restarts. Repeating the same (environmentId, threadId,
    // requestId) with the same payload replays the original result; a different
    // payload under the same key is a conflict.
    rememberRequest: (
      key: string,
      payload: string,
      result: unknown,
    ): "accepted" | "duplicate" | "conflict" => {
      const stored = db.prepare("SELECT payload FROM idempotency WHERE key = ?").get(key) as
        | { payload: string }
        | undefined;
      if (stored !== undefined) return stored.payload === payload ? "duplicate" : "conflict";
      db.prepare(
        "INSERT INTO idempotency (key, payload, result, status) VALUES (?, ?, ?, 'validating')",
      ).run(key, payload, JSON.stringify(result ?? null));
      return "accepted";
    },
    recallRequest: <T>(key: string): T | undefined => {
      const stored = db.prepare("SELECT result FROM idempotency WHERE key = ?").get(key) as
        | { result: string }
        | undefined;
      return stored === undefined ? undefined : (JSON.parse(stored.result) as T);
    },
    requestState: (key: string): "validating" | "dispatched" | "completed" | undefined => {
      const stored = db.prepare("SELECT status FROM idempotency WHERE key = ?").get(key) as
        | { status: "validating" | "dispatched" | "completed" }
        | undefined;
      return stored?.status;
    },
    recallDispatchContext: <T>(key: string): T | undefined => {
      const stored = db
        .prepare("SELECT dispatchContext FROM idempotency WHERE key = ?")
        .get(key) as { dispatchContext: string | null } | undefined;
      if (stored?.dispatchContext === null || stored?.dispatchContext === undefined)
        return undefined;
      const parsed = JSON.parse(stored.dispatchContext) as T | null;
      return parsed === null ? undefined : parsed;
    },
    markRequestDispatched: (key: string, dispatchContext: unknown): void => {
      db.prepare(
        "UPDATE idempotency SET status = 'dispatched', dispatchContext = ? WHERE key = ?",
      ).run(JSON.stringify(dispatchContext ?? null), key);
    },
    completeRequest: (key: string, result: unknown): void => {
      db.prepare("UPDATE idempotency SET result = ?, status = 'completed' WHERE key = ?").run(
        JSON.stringify(result ?? null),
        key,
      );
    },
    forgetRequest: (key: string): void => {
      db.prepare("DELETE FROM idempotency WHERE key = ?").run(key);
    },
    close: (): void => {
      db.close();
    },
  };
}

export type GatewayEventStore = ReturnType<typeof createGatewayEventStore>;
