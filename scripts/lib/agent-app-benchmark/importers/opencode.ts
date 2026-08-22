// @effect-diagnostics nodeBuiltinImport:off - safely snapshots a contributor-selected local SQLite database.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import { canonicalJson, sha256 } from "../corpus.ts";
import { type ShareableLocalCorpusSummary, buildShareableLocalCorpusSummary } from "../privacy.ts";

export interface OpenCodeMessageRow {
  readonly id: string;
  readonly sourceSessionId: string;
  readonly createdAt: number;
  readonly data: unknown;
  readonly parts: ReadonlyArray<OpenCodePartRow>;
}

export interface OpenCodePartRow {
  readonly id: string;
  readonly sourceSessionId: string;
  readonly sourceMessageId: string;
  readonly createdAt: number;
  readonly data: unknown;
}

export interface OpenCodeEventRow {
  readonly id: string;
  readonly aggregateId: string;
  readonly sequence: number;
  readonly type: string;
  readonly data: unknown;
}

export interface OpenCodeImportedSession {
  readonly sourceSessionId: string;
  readonly title: string;
  readonly finalRenderableBytes: number;
  readonly messages: ReadonlyArray<OpenCodeMessageRow>;
  readonly events: ReadonlyArray<OpenCodeEventRow>;
}

export interface OpenCodeLocalCorpus {
  readonly schemaVersion: 1;
  readonly kind: "opencode-local-private-corpus";
  readonly sessions: ReadonlyArray<OpenCodeImportedSession>;
  readonly shareableSummary: ShareableLocalCorpusSummary;
  readonly snapshotPath: string;
  readonly snapshotRetained: boolean;
}

export interface ImportOpenCodeCorpusOptions {
  readonly sourceDatabasePath: string;
  readonly privateDirectory: string;
  readonly limit?: number;
  readonly retainSnapshotOnSuccess?: boolean;
}

interface RankedSessionRow {
  readonly id: string;
  readonly title: string;
  readonly final_renderable_bytes: number;
}

interface MessageDatabaseRow {
  readonly id: string;
  readonly session_id: string;
  readonly time_created: number;
  readonly data: string;
}

interface PartDatabaseRow {
  readonly id: string;
  readonly message_id: string;
  readonly session_id: string;
  readonly time_created: number;
  readonly data: string;
}

interface EventDatabaseRow {
  readonly id: string;
  readonly aggregate_id: string;
  readonly seq: number;
  readonly type: string;
  readonly data: string;
}

function quoteSqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function tableExists(database: NodeSqlite.DatabaseSync, name: string): boolean {
  return (
    database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !==
    undefined
  );
}

function placeholders(values: ReadonlyArray<unknown>): string {
  return values.map(() => "?").join(", ");
}

function parsePrivateJson(kind: "message" | "part" | "event", id: string, source: string): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    throw new Error(`OpenCode ${kind} ${id} contains malformed JSON.`, { cause: error });
  }
  if (parsed !== null && typeof parsed === "object") {
    const version = (parsed as { readonly schemaVersion?: unknown }).schemaVersion;
    if (typeof version === "number" && version !== 1) {
      throw new Error(`OpenCode ${kind} ${id} uses unsupported schema version ${version}.`);
    }
  }
  return parsed;
}

function median(values: ReadonlyArray<number>): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle]!;
  return (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function readSnapshot(
  database: NodeSqlite.DatabaseSync,
  limit: number,
): {
  readonly sessions: ReadonlyArray<OpenCodeImportedSession>;
  readonly messageCount: number;
  readonly partCount: number;
  readonly eventCount: number;
  readonly eventBytes: number;
  readonly semanticSha256: string;
} {
  for (const requiredTable of ["session", "message", "part"]) {
    if (!tableExists(database, requiredTable)) {
      throw new Error(`OpenCode snapshot is missing required table ${requiredTable}.`);
    }
  }

  const ranked = database
    .prepare(
      `SELECT
         s.id,
         s.title,
         COALESCE((SELECT SUM(length(CAST(m.data AS BLOB))) FROM message m WHERE m.session_id = s.id), 0)
           + COALESCE((SELECT SUM(length(CAST(p.data AS BLOB))) FROM part p WHERE p.session_id = s.id), 0)
           AS final_renderable_bytes
       FROM session s
       ORDER BY final_renderable_bytes DESC, s.id ASC
       LIMIT ?`,
    )
    .all(limit) as unknown as ReadonlyArray<RankedSessionRow>;
  const sessionIds = ranked.map((session) => session.id);
  if (sessionIds.length === 0) {
    return {
      sessions: [],
      messageCount: 0,
      partCount: 0,
      eventCount: 0,
      eventBytes: 0,
      semanticSha256: sha256("[]"),
    };
  }

  const messageRows = database
    .prepare(
      `SELECT id, session_id, time_created, data
       FROM message
       WHERE session_id IN (${placeholders(sessionIds)})
       ORDER BY session_id ASC, time_created ASC, id ASC`,
    )
    .all(...sessionIds) as unknown as ReadonlyArray<MessageDatabaseRow>;
  const messageIds = messageRows.map((message) => message.id);
  const partRows = database
    .prepare(
      `SELECT id, message_id, session_id, time_created, data
       FROM part
       WHERE session_id IN (${placeholders(sessionIds)})
       ORDER BY session_id ASC, time_created ASC, id ASC`,
    )
    .all(...sessionIds) as unknown as ReadonlyArray<PartDatabaseRow>;

  const knownMessages = new Map(messageRows.map((message) => [message.id, message.session_id]));
  for (const part of partRows) {
    const messageSessionId = knownMessages.get(part.message_id);
    if (messageSessionId === undefined || messageSessionId !== part.session_id) {
      throw new Error(`OpenCode part ${part.id} has an inconsistent message/session foreign key.`);
    }
  }

  const relatedAggregateIds = [
    ...new Set([...sessionIds, ...messageIds, ...partRows.map((part) => part.id)]),
  ];
  const eventRows = tableExists(database, "event")
    ? (database
        .prepare(
          `SELECT id, aggregate_id, seq, type, data
           FROM event
           WHERE aggregate_id IN (${placeholders(relatedAggregateIds)})
           ORDER BY aggregate_id ASC, seq ASC, id ASC`,
        )
        .all(...relatedAggregateIds) as unknown as ReadonlyArray<EventDatabaseRow>)
    : [];

  const partsByMessage = new Map<string, Array<OpenCodePartRow>>();
  for (const part of partRows) {
    const value: OpenCodePartRow = {
      id: part.id,
      sourceSessionId: part.session_id,
      sourceMessageId: part.message_id,
      createdAt: part.time_created,
      data: parsePrivateJson("part", part.id, part.data),
    };
    const parts = partsByMessage.get(part.message_id) ?? [];
    parts.push(value);
    partsByMessage.set(part.message_id, parts);
  }
  const messagesBySession = new Map<string, Array<OpenCodeMessageRow>>();
  for (const message of messageRows) {
    const value: OpenCodeMessageRow = {
      id: message.id,
      sourceSessionId: message.session_id,
      createdAt: message.time_created,
      data: parsePrivateJson("message", message.id, message.data),
      parts: partsByMessage.get(message.id) ?? [],
    };
    const messages = messagesBySession.get(message.session_id) ?? [];
    messages.push(value);
    messagesBySession.set(message.session_id, messages);
  }
  const eventsBySession = new Map<string, Array<OpenCodeEventRow>>();
  const aggregateSession = new Map<string, string>();
  for (const id of sessionIds) aggregateSession.set(id, id);
  for (const message of messageRows) aggregateSession.set(message.id, message.session_id);
  for (const part of partRows) aggregateSession.set(part.id, part.session_id);
  for (const event of eventRows) {
    const sessionId = aggregateSession.get(event.aggregate_id);
    if (!sessionId)
      throw new Error(`OpenCode event ${event.id} has an inconsistent aggregate foreign key.`);
    const value: OpenCodeEventRow = {
      id: event.id,
      aggregateId: event.aggregate_id,
      sequence: event.seq,
      type: event.type,
      data: parsePrivateJson("event", event.id, event.data),
    };
    const events = eventsBySession.get(sessionId) ?? [];
    events.push(value);
    eventsBySession.set(sessionId, events);
  }

  const sessions = ranked.map<OpenCodeImportedSession>((session) => ({
    sourceSessionId: session.id,
    title: session.title,
    finalRenderableBytes: session.final_renderable_bytes,
    messages: messagesBySession.get(session.id) ?? [],
    events: (eventsBySession.get(session.id) ?? []).sort(
      (left, right) => left.sequence - right.sequence || left.id.localeCompare(right.id),
    ),
  }));
  return {
    sessions,
    messageCount: messageRows.length,
    partCount: partRows.length,
    eventCount: eventRows.length,
    eventBytes: eventRows.reduce((total, event) => total + Buffer.byteLength(event.data), 0),
    semanticSha256: sha256(canonicalJson(sessions)),
  };
}

export async function importOpenCodeCorpus(
  options: ImportOpenCodeCorpusOptions,
): Promise<OpenCodeLocalCorpus> {
  const limit = options.limit ?? 20;
  if (!Number.isInteger(limit) || limit <= 0 || limit > 100) {
    throw new Error("OpenCode import limit must be an integer from 1 through 100.");
  }
  await NodeFSP.mkdir(options.privateDirectory, { recursive: true, mode: 0o700 });
  await NodeFSP.chmod(options.privateDirectory, 0o700);
  const snapshotPath = NodePath.join(options.privateDirectory, "opencode-snapshot.sqlite");
  await NodeFSP.rm(snapshotPath, { force: true });

  let source: NodeSqlite.DatabaseSync | undefined;
  let snapshot: NodeSqlite.DatabaseSync | undefined;
  try {
    source = new NodeSqlite.DatabaseSync(options.sourceDatabasePath, { readOnly: true });
    source.exec(`VACUUM INTO ${quoteSqlString(snapshotPath)}`);
    source.close();
    source = undefined;

    snapshot = new NodeSqlite.DatabaseSync(snapshotPath, { readOnly: true });
    const imported = readSnapshot(snapshot, limit);
    snapshot.close();
    snapshot = undefined;

    const sizes = imported.sessions.map((session) => session.finalRenderableBytes);
    const shareableSummary = buildShareableLocalCorpusSummary({
      selectedSessionCount: imported.sessions.length,
      messageCount: imported.messageCount,
      partCount: imported.partCount,
      eventCount: imported.eventCount,
      finalRenderableBytes: sizes.reduce((total, size) => total + size, 0),
      eventBytes: imported.eventBytes,
      sizeDistributionBytes: {
        minimum: sizes.length === 0 ? 0 : Math.min(...sizes),
        median: median(sizes),
        maximum: sizes.length === 0 ? 0 : Math.max(...sizes),
      },
      semanticSha256: imported.semanticSha256,
    });
    if (!options.retainSnapshotOnSuccess) await NodeFSP.rm(snapshotPath, { force: true });
    return {
      schemaVersion: 1,
      kind: "opencode-local-private-corpus",
      sessions: imported.sessions,
      shareableSummary,
      snapshotPath,
      snapshotRetained: options.retainSnapshotOnSuccess === true,
    };
  } catch (error) {
    try {
      snapshot?.close();
    } catch {}
    try {
      source?.close();
    } catch {}
    await NodeFSP.rm(snapshotPath, { force: true });
    throw error;
  }
}
