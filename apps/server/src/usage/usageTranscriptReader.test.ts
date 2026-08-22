// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import { describe, expect, it } from "@effect/vitest";

import {
  listTranscriptFiles,
  probeMcodeUsageStore,
  readTranscriptRecords,
  statSqliteUsageStore,
} from "./usageTranscriptReader.ts";

interface McodeRow {
  readonly id: number;
  readonly sessionId?: string;
  readonly model?: string | null;
  readonly timestampMs?: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly reasoningTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly costUsd?: number | null;
}

function createMcodeDb(rows: readonly McodeRow[]): { dbPath: string; cleanup: () => void } {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-mcode-usage-"));
  const dbPath = NodePath.join(dir, "runtime-state.sqlite");
  const db = new NodeSqlite.DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE local_runtime_token_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      agent_name TEXT NOT NULL,
      framework_type TEXT NOT NULL,
      turn_id TEXT,
      model TEXT,
      ts INTEGER NOT NULL,
      input_tokens INTEGER NOT NULL,
      output_tokens INTEGER NOT NULL,
      reasoning_tokens INTEGER NOT NULL,
      cache_read_tokens INTEGER NOT NULL,
      cache_write_tokens INTEGER NOT NULL,
      cost_usd REAL,
      raw TEXT
    );
    CREATE INDEX idx_local_runtime_token_usage_ts
      ON local_runtime_token_usage(ts, id);
  `);
  const insert = db.prepare(`
    INSERT INTO local_runtime_token_usage (
      id, session_id, agent_name, framework_type, turn_id, model, ts,
      input_tokens, output_tokens, reasoning_tokens,
      cache_read_tokens, cache_write_tokens, cost_usd, raw
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const row of rows) {
    insert.run(
      row.id,
      row.sessionId ?? "session-1",
      "general",
      "pi-agent",
      "turn-1",
      row.model === undefined ? "minimax/MiniMax-M3" : row.model,
      row.timestampMs ?? 1_786_000_000_000,
      row.inputTokens ?? 0,
      row.outputTokens ?? 0,
      row.reasoningTokens ?? 0,
      row.cacheReadTokens ?? 0,
      row.cacheWriteTokens ?? 0,
      row.costUsd ?? 0,
      "{}",
    );
  }
  db.close();
  return {
    dbPath,
    cleanup: () => NodeFS.rmSync(dir, { recursive: true, force: true }),
  };
}

describe("readTranscriptRecords for mcode", () => {
  it("reads only token rows inside the requested window", async () => {
    const cutoffMs = 1_786_000_000_000;
    const { dbPath, cleanup } = createMcodeDb([
      { id: 1, timestampMs: cutoffMs - 1, outputTokens: 10 },
      {
        id: 2,
        sessionId: "session-a",
        timestampMs: cutoffMs,
        inputTokens: 120,
        outputTokens: 45,
        reasoningTokens: 12,
        cacheReadTokens: 900,
        cacheWriteTokens: 30,
      },
    ]);
    try {
      expect(await readTranscriptRecords(dbPath, "mcode", cutoffMs)).toEqual([
        {
          provider: "mcode",
          timestampMs: cutoffMs,
          model: "minimax/MiniMax-M3",
          sessionId: "session-a",
          totals: {
            uncachedInputTokens: 120,
            cachedInputTokens: 900,
            cacheCreationTokens: 30,
            outputTokens: 45,
            reasoningTokens: 12,
          },
          reportedCostUsd: null,
          dedupeKey: "mcode:2",
        },
      ]);
    } finally {
      cleanup();
    }
  });

  it("detects which compatibility database has canonical usage accounting", async () => {
    const { dbPath, cleanup } = createMcodeDb([]);
    const emptyPath = NodePath.join(NodePath.dirname(dbPath), "empty.sqlite");
    const corruptPath = NodePath.join(NodePath.dirname(dbPath), "corrupt.sqlite");
    const missingPath = NodePath.join(NodePath.dirname(dbPath), "missing.sqlite");
    new NodeSqlite.DatabaseSync(emptyPath).close();
    NodeFS.writeFileSync(corruptPath, "not a sqlite database");
    try {
      expect(await probeMcodeUsageStore(dbPath)).toBe("ready");
      expect(await probeMcodeUsageStore(emptyPath)).toBe("absent");
      expect(await probeMcodeUsageStore(corruptPath)).toBe("failed");
      expect(await probeMcodeUsageStore(missingPath)).toBe("absent");
    } finally {
      cleanup();
    }
  });

  it("does not turn transient failures into cacheable empty usage", async () => {
    expect(
      await readTranscriptRecords(
        NodePath.join(NodeOS.tmpdir(), "t3-mcode-no-such-dir", "runtime-state.sqlite"),
        "mcode",
        0,
      ),
    ).toBeNull();
  });

  it("treats a pre-accounting database as an empty store", async () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-mcode-empty-"));
    const dbPath = NodePath.join(dir, "runtime-state.sqlite");
    new NodeSqlite.DatabaseSync(dbPath).close();
    try {
      expect(await readTranscriptRecords(dbPath, "mcode", 0)).toEqual([]);
    } finally {
      NodeFS.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("includes the SQLite WAL in the scan fingerprint", async () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-mcode-wal-"));
    const dbPath = NodePath.join(dir, "runtime-state.sqlite");
    const db = new NodeSqlite.DatabaseSync(dbPath);
    try {
      db.exec("PRAGMA journal_mode = WAL; CREATE TABLE usage (id TEXT)");
      db.prepare("INSERT INTO usage VALUES (?)").run("new-row");

      const dbStats = NodeFS.statSync(dbPath);
      const walStats = NodeFS.statSync(`${dbPath}-wal`);
      expect(await statSqliteUsageStore(dbPath, 0)).toEqual([
        {
          path: dbPath,
          size: dbStats.size + walStats.size,
          mtimeMs: Math.max(dbStats.mtimeMs, walStats.mtimeMs),
        },
      ]);
    } finally {
      db.close();
      NodeFS.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("distinguishes a stat failure from an empty in-window store", async () => {
    expect(
      await statSqliteUsageStore(
        NodePath.join(NodeOS.tmpdir(), "t3-mcode-missing-stat", "runtime-state.sqlite"),
        0,
      ),
    ).toBeNull();
  });

  it("reports a transcript root that disappears before the walk", async () => {
    const missingRoot = NodePath.join(NodeOS.tmpdir(), "t3-usage-missing-transcript-root");
    expect(await listTranscriptFiles(missingRoot, 0)).toEqual({
      files: [],
      failedEntries: 1,
    });
  });
});
