import fs from "node:fs";
import path from "node:path";
import { DatabaseSync, StatementSync } from "node:sqlite";
import type { SQLOutputValue } from "node:sqlite";

import type { OrchestrationEvent } from "@t3tools/contracts";
import { Effect } from "effect";

interface EventRow {
  sequence: number;
  event_id: string;
  event_type: string;
  aggregate_type: string;
  aggregate_id: string;
  occurred_at: string;
  command_id: string | null;
  payload_json: string;
}

function readRequiredString(
  row: Record<string, SQLOutputValue>,
  column: keyof EventRow,
): string {
  const value = row[column];
  if (typeof value !== "string") {
    throw new Error(`Invalid SQLite value for ${String(column)}: expected string`);
  }
  return value;
}

function readOptionalString(
  row: Record<string, SQLOutputValue>,
  column: keyof EventRow,
): string | null {
  const value = row[column];
  if (value === null) return null;
  if (typeof value !== "string") {
    throw new Error(`Invalid SQLite value for ${String(column)}: expected string or null`);
  }
  return value;
}

function readRequiredNumber(
  row: Record<string, SQLOutputValue>,
  column: keyof EventRow,
): number {
  const value = row[column];
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  throw new Error(`Invalid SQLite value for ${String(column)}: expected number`);
}

export class SqliteEventStore {
  private readonly db: DatabaseSync;
  private readonly insertStatement: StatementSync;
  private closed = false;

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.migrate();
    this.insertStatement = this.db.prepare(`
      INSERT INTO orchestration_events (
        event_id, event_type, aggregate_type, aggregate_id, occurred_at, command_id, payload_json
      )
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS orchestration_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL UNIQUE,
        event_type TEXT NOT NULL,
        aggregate_type TEXT NOT NULL,
        aggregate_id TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        command_id TEXT,
        payload_json TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_orch_events_aggregate
      ON orchestration_events(aggregate_type, aggregate_id, sequence);
    `);
  }

  append(event: Omit<OrchestrationEvent, "sequence">): Effect.Effect<OrchestrationEvent> {
    return Effect.sync(() => {
      const result = this.insertStatement.run(
        event.eventId,
        event.type,
        event.aggregateType,
        event.aggregateId,
        event.occurredAt,
        event.commandId,
        JSON.stringify(event.payload),
      );

      return {
        ...event,
        sequence: Number(result.lastInsertRowid),
      };
    });
  }

  readFromSequence(sequenceExclusive: number, limit = 1_000): Effect.Effect<OrchestrationEvent[]> {
    return Effect.sync(() => {
      const rows = this.db
        .prepare(
          `
          SELECT sequence, event_id, event_type, aggregate_type, aggregate_id, occurred_at, command_id, payload_json
          FROM orchestration_events
          WHERE sequence > ?
          ORDER BY sequence ASC
          LIMIT ?
        `,
        )
        .all(sequenceExclusive, limit);
      return rows.map((row) => ({
        sequence: readRequiredNumber(row, "sequence"),
        eventId: readRequiredString(row, "event_id"),
        type: readRequiredString(row, "event_type"),
        aggregateType: readRequiredString(row, "aggregate_type"),
        aggregateId: readRequiredString(row, "aggregate_id"),
        occurredAt: readRequiredString(row, "occurred_at"),
        commandId: readOptionalString(row, "command_id"),
        payload: JSON.parse(readRequiredString(row, "payload_json")) as unknown,
      }));
    });
  }

  readAll(): Effect.Effect<OrchestrationEvent[]> {
    return this.readFromSequence(0, Number.MAX_SAFE_INTEGER);
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.db.close();
  }
}
