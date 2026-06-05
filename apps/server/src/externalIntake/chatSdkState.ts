// @effect-diagnostics globalDate:off
// @effect-diagnostics preferSchemaOverJson:off

import { randomUUID } from "node:crypto";

import { Message, type QueueEntry, type SerializedMessage, type StateAdapter } from "chat";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";

function nowMs() {
  return Date.now();
}

function expiresAt(ttlMs: number | undefined, now: number) {
  return ttlMs === undefined ? null : now + ttlMs;
}

function stringifyValue(value: unknown) {
  return JSON.stringify(value);
}

function parseValue<T>(valueJson: string) {
  return JSON.parse(valueJson) as T;
}

function parseJsonArray(valueJson: string | null | undefined): string[] {
  if (valueJson === null || valueJson === undefined || valueJson.trim().length === 0) return [];
  const parsed = JSON.parse(valueJson) as unknown;
  return Array.isArray(parsed)
    ? parsed.flatMap((entry) => (typeof entry === "string" ? [entry] : []))
    : [];
}

function serializeQueueEntry(entry: QueueEntry) {
  return JSON.stringify({
    enqueuedAt: entry.enqueuedAt,
    expiresAt: entry.expiresAt,
    message: entry.message.toJSON(),
  });
}

function deserializeQueueEntry(entryJson: string): QueueEntry {
  const entry = JSON.parse(entryJson) as {
    readonly enqueuedAt: number;
    readonly expiresAt: number;
    readonly message: SerializedMessage;
  };
  return {
    enqueuedAt: entry.enqueuedAt,
    expiresAt: entry.expiresAt,
    message: Message.fromJSON(entry.message),
  };
}

function runSql<A>(effect: Effect.Effect<A, SqlError>) {
  return Effect.runPromise(effect);
}

export function createSqlChatSdkState(sql: SqlClient.SqlClient): StateAdapter {
  return {
    async connect() {},
    async disconnect() {},
    async subscribe(threadId) {
      const now = nowMs();
      await runSql(sql`
        INSERT INTO external_chat_sdk_subscriptions (thread_id, created_at_ms, updated_at_ms)
        VALUES (${threadId}, ${now}, ${now})
        ON CONFLICT(thread_id) DO UPDATE SET
          updated_at_ms = excluded.updated_at_ms
      `);
    },
    async unsubscribe(threadId) {
      await runSql(sql`
        DELETE FROM external_chat_sdk_subscriptions
        WHERE thread_id = ${threadId}
      `);
    },
    async isSubscribed(threadId) {
      const rows = await runSql(sql<{ readonly threadId: string }>`
        SELECT thread_id AS "threadId"
        FROM external_chat_sdk_subscriptions
        WHERE thread_id = ${threadId}
        LIMIT 1
      `);
      return rows.length > 0;
    },
    async acquireLock(threadId, ttlMs) {
      const now = nowMs();
      const token = randomUUID();
      const lockExpiresAt = now + ttlMs;
      const rows = await runSql(sql<{ readonly token: string; readonly expiresAt: number }>`
        INSERT INTO external_chat_sdk_locks (
          thread_id,
          token,
          expires_at_ms,
          created_at_ms,
          updated_at_ms
        )
        VALUES (${threadId}, ${token}, ${lockExpiresAt}, ${now}, ${now})
        ON CONFLICT(thread_id) DO UPDATE SET
          token = excluded.token,
          expires_at_ms = excluded.expires_at_ms,
          updated_at_ms = excluded.updated_at_ms
        WHERE external_chat_sdk_locks.expires_at_ms <= ${now}
        RETURNING token, expires_at_ms AS "expiresAt"
      `);
      const acquired = rows[0];
      return acquired?.token === token ? { threadId, token, expiresAt: acquired.expiresAt } : null;
    },
    async releaseLock(lock) {
      await runSql(sql`
        DELETE FROM external_chat_sdk_locks
        WHERE thread_id = ${lock.threadId}
          AND token = ${lock.token}
      `);
    },
    async forceReleaseLock(threadId) {
      await runSql(sql`
        DELETE FROM external_chat_sdk_locks
        WHERE thread_id = ${threadId}
      `);
    },
    async extendLock(lock, ttlMs) {
      const now = nowMs();
      await runSql(sql`
        UPDATE external_chat_sdk_locks
        SET expires_at_ms = ${now + ttlMs},
            updated_at_ms = ${now}
        WHERE thread_id = ${lock.threadId}
          AND token = ${lock.token}
      `);
      const rows = await runSql(sql<{ readonly token: string }>`
        SELECT token
        FROM external_chat_sdk_locks
        WHERE thread_id = ${lock.threadId}
          AND token = ${lock.token}
          AND expires_at_ms > ${now}
        LIMIT 1
      `);
      return rows.length > 0;
    },
    async get<T = unknown>(key: string) {
      const now = nowMs();
      const rows = await runSql(sql<{ readonly valueJson: string }>`
        SELECT value_json AS "valueJson"
        FROM external_chat_sdk_cache
        WHERE key = ${key}
          AND (expires_at_ms IS NULL OR expires_at_ms > ${now})
        LIMIT 1
      `);
      return rows[0] === undefined ? null : parseValue<T>(rows[0].valueJson);
    },
    async set<T = unknown>(key: string, value: T, ttlMs?: number) {
      const now = nowMs();
      await runSql(sql`
        INSERT INTO external_chat_sdk_cache (
          key,
          value_json,
          expires_at_ms,
          created_at_ms,
          updated_at_ms
        )
        VALUES (${key}, ${stringifyValue(value)}, ${expiresAt(ttlMs, now)}, ${now}, ${now})
        ON CONFLICT(key) DO UPDATE SET
          value_json = excluded.value_json,
          expires_at_ms = excluded.expires_at_ms,
          updated_at_ms = excluded.updated_at_ms
      `);
    },
    async setIfNotExists(key, value, ttlMs) {
      const now = nowMs();
      await runSql(sql`
        DELETE FROM external_chat_sdk_cache
        WHERE key = ${key}
          AND expires_at_ms IS NOT NULL
          AND expires_at_ms <= ${now}
      `);
      const rows = await runSql(sql<{ readonly key: string }>`
        INSERT INTO external_chat_sdk_cache (
          key,
          value_json,
          expires_at_ms,
          created_at_ms,
          updated_at_ms
        )
        VALUES (${key}, ${stringifyValue(value)}, ${expiresAt(ttlMs, now)}, ${now}, ${now})
        ON CONFLICT(key) DO NOTHING
        RETURNING key
      `);
      return rows.length > 0;
    },
    async delete(key) {
      await runSql(sql`
        DELETE FROM external_chat_sdk_cache
        WHERE key = ${key}
      `);
    },
    async appendToList(key, value, options) {
      const now = nowMs();
      const existing = await runSql(sql<{ readonly valuesJson: string }>`
        SELECT values_json AS "valuesJson"
        FROM external_chat_sdk_lists
        WHERE key = ${key}
          AND (expires_at_ms IS NULL OR expires_at_ms > ${now})
        LIMIT 1
      `);
      const values = [...parseJsonArray(existing[0]?.valuesJson), stringifyValue(value)];
      const trimmed = options?.maxLength === undefined ? values : values.slice(-options.maxLength);
      await runSql(sql`
        INSERT INTO external_chat_sdk_lists (
          key,
          values_json,
          expires_at_ms,
          created_at_ms,
          updated_at_ms
        )
        VALUES (
          ${key},
          ${JSON.stringify(trimmed)},
          ${expiresAt(options?.ttlMs, now)},
          ${now},
          ${now}
        )
        ON CONFLICT(key) DO UPDATE SET
          values_json = excluded.values_json,
          expires_at_ms = excluded.expires_at_ms,
          updated_at_ms = excluded.updated_at_ms
      `);
    },
    async getList<T = unknown>(key: string) {
      const now = nowMs();
      const rows = await runSql(sql<{ readonly valuesJson: string }>`
        SELECT values_json AS "valuesJson"
        FROM external_chat_sdk_lists
        WHERE key = ${key}
          AND (expires_at_ms IS NULL OR expires_at_ms > ${now})
        LIMIT 1
      `);
      return parseJsonArray(rows[0]?.valuesJson).map((valueJson) => parseValue<T>(valueJson));
    },
    async enqueue(threadId, entry, maxSize) {
      const now = nowMs();
      const existing = await runSql(sql<{ readonly entriesJson: string }>`
        SELECT entries_json AS "entriesJson"
        FROM external_chat_sdk_queues
        WHERE thread_id = ${threadId}
        LIMIT 1
      `);
      const entries = [
        ...parseJsonArray(existing[0]?.entriesJson),
        serializeQueueEntry(entry),
      ].slice(-maxSize);
      await runSql(sql`
        INSERT INTO external_chat_sdk_queues (
          thread_id,
          entries_json,
          created_at_ms,
          updated_at_ms
        )
        VALUES (${threadId}, ${JSON.stringify(entries)}, ${now}, ${now})
        ON CONFLICT(thread_id) DO UPDATE SET
          entries_json = excluded.entries_json,
          updated_at_ms = excluded.updated_at_ms
      `);
      return entries.length;
    },
    async dequeue(threadId) {
      const rows = await runSql(sql<{ readonly entriesJson: string }>`
        SELECT entries_json AS "entriesJson"
        FROM external_chat_sdk_queues
        WHERE thread_id = ${threadId}
        LIMIT 1
      `);
      const entries = parseJsonArray(rows[0]?.entriesJson);
      const [next, ...rest] = entries;
      if (next === undefined) return null;
      await runSql(sql`
        UPDATE external_chat_sdk_queues
        SET entries_json = ${JSON.stringify(rest)},
            updated_at_ms = ${nowMs()}
        WHERE thread_id = ${threadId}
      `);
      return deserializeQueueEntry(next);
    },
    async queueDepth(threadId) {
      const rows = await runSql(sql<{ readonly entriesJson: string }>`
        SELECT entries_json AS "entriesJson"
        FROM external_chat_sdk_queues
        WHERE thread_id = ${threadId}
        LIMIT 1
      `);
      return parseJsonArray(rows[0]?.entriesJson).length;
    },
  };
}
