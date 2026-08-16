// @effect-diagnostics nodeBuiltinImport:off
import { mkdtempSync, rmSync } from "node:fs";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import { tmpdir } from "node:os";

import { describe, expect, it } from "@effect/vitest";

import { readOpenCodeRecords } from "./usageTranscriptReader.ts";

function createDatabase(): string {
  const directory = mkdtempSync(NodePath.join(tmpdir(), "t3-opencode-"));
  const dbPath = NodePath.join(directory, "opencode.db");
  const database = new NodeSqlite.DatabaseSync(dbPath);
  database.exec(`
    CREATE TABLE message (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      data TEXT NOT NULL
    );
    CREATE TABLE session_message (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      type TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      data TEXT NOT NULL
    );
  `);

  const legacy = database.prepare(
    "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)",
  );
  legacy.run(
    "legacy-completed",
    "session-1",
    1_000,
    2_500,
    JSON.stringify({
      role: "assistant",
      modelID: "legacy-model",
      time: { created: 1_000, completed: 2_500 },
      tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
      cost: 0,
    }),
  );

  const current = database.prepare(
    "INSERT INTO session_message (id, session_id, type, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)",
  );
  current.run(
    "current-incomplete",
    "session-1",
    "assistant",
    3_000,
    3_000,
    JSON.stringify({
      model: { id: "current-model" },
      time: { created: 3_000 },
      tokens: { input: 20, output: 10, reasoning: 0, cache: { read: 0, write: 0 } },
      cost: 0,
    }),
  );
  current.run(
    "current-completed",
    "session-1",
    "assistant",
    4_000,
    4_500,
    JSON.stringify({
      model: { id: "current-model" },
      time: { created: 4_000, completed: 4_500 },
      tokens: { input: 30, output: 15, reasoning: 0, cache: { read: 0, write: 0 } },
      cost: 0,
    }),
  );
  database.close();
  return dbPath;
}

describe("readOpenCodeRecords", () => {
  it("uses completion time and excludes incomplete current assistant rows", async () => {
    const dbPath = createDatabase();
    try {
      const records = await readOpenCodeRecords(dbPath, 2_000);

      expect(records).toHaveLength(2);
      if (records === null) throw new Error("Expected the OpenCode database to be readable");
      expect(records.map((record) => [record.dedupeKey, record.timestampMs])).toEqual([
        ["current-completed", 4_500],
        ["legacy-completed", 2_500],
      ]);
    } finally {
      rmSync(NodePath.dirname(dbPath), { recursive: true, force: true });
    }
  });
});
