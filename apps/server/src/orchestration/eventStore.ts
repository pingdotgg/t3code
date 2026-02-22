import fs from "node:fs";
import path from "node:path";

import type { OrchestrationEvent } from "@t3tools/contracts";
import Database from "better-sqlite3";
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

export class SqliteEventStore {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.migrate();
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
      const stmt = this.db.prepare(`
        INSERT INTO orchestration_events (
          event_id, event_type, aggregate_type, aggregate_id, occurred_at, command_id, payload_json
        )
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      const result = stmt.run(
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
        .all(sequenceExclusive, limit) as EventRow[];
      return rows.map((row) => ({
        sequence: row.sequence,
        eventId: row.event_id,
        type: row.event_type,
        aggregateType: row.aggregate_type,
        aggregateId: row.aggregate_id,
        occurredAt: row.occurred_at,
        commandId: row.command_id,
        payload: JSON.parse(row.payload_json) as unknown,
      }));
    });
  }

  readAll(): Effect.Effect<OrchestrationEvent[]> {
    return this.readFromSequence(0, Number.MAX_SAFE_INTEGER);
  }
}
