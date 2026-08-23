// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodePerfHooks from "node:perf_hooks";
import * as NodeSqlite from "node:sqlite";

import { describe, expect, it } from "@effect/vitest";

import { listTranscriptFiles, readOpenCodeRecords } from "./usageTranscriptReader.ts";

function createDatabase(): string {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-opencode-"));
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
      NodeFS.rmSync(NodePath.dirname(dbPath), { recursive: true, force: true });
    }
  });

  it("skips malformed JSON rows without discarding valid usage", async () => {
    const dbPath = createDatabase();
    const database = new NodeSqlite.DatabaseSync(dbPath);
    try {
      database
        .prepare(
          "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)",
        )
        .run("legacy-malformed", "session-1", 5_000, 5_000, "{not-json");
      database
        .prepare(
          "INSERT INTO session_message (id, session_id, type, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run("current-malformed", "session-1", "assistant", 5_000, 5_000, "{not-json");
    } finally {
      database.close();
    }

    try {
      const records = await readOpenCodeRecords(dbPath, 2_000);

      expect(records?.map((record) => record.dedupeKey)).toEqual([
        "current-completed",
        "legacy-completed",
      ]);
    } finally {
      NodeFS.rmSync(NodePath.dirname(dbPath), { recursive: true, force: true });
    }
  });

  it("waits briefly for a writer before reporting a locked database", async () => {
    const dbPath = createDatabase();
    const writer = new NodeSqlite.DatabaseSync(dbPath);
    writer.exec("BEGIN EXCLUSIVE");
    const startedAt = NodePerfHooks.performance.now();
    try {
      expect(await readOpenCodeRecords(dbPath, 2_000)).toBeNull();
      expect(NodePerfHooks.performance.now() - startedAt).toBeGreaterThanOrEqual(500);
    } finally {
      writer.exec("ROLLBACK");
      writer.close();
      NodeFS.rmSync(NodePath.dirname(dbPath), { recursive: true, force: true });
    }
  });
});

describe("listTranscriptFiles", () => {
  it("reports a traversal error separately from an empty transcript set", async () => {
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-transcripts-"));
    try {
      const listing = await listTranscriptFiles(NodePath.join(directory, "missing"), 0);
      expect(listing.files).toEqual([]);
      expect(listing.hadReadError).toBe(true);
    } finally {
      NodeFS.rmSync(directory, { recursive: true, force: true });
    }
  });
});
