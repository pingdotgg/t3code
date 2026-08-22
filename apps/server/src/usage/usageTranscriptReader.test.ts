// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import { describe, expect, it } from "@effect/vitest";

import { readTranscriptRecords, statSqliteUsageStore } from "./usageTranscriptReader.ts";

interface ZcodeRow {
  readonly id: string;
  readonly sessionId?: string;
  readonly modelId?: string;
  readonly status?: string;
  readonly startedAt?: number;
  readonly completedAt?: number | null;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly reasoningTokens?: number;
  readonly cacheCreationInputTokens?: number;
  readonly cacheReadInputTokens?: number;
}

/** Writes a minimal `model_usage` fixture db, shaped after ZCode's real store. */
function createZcodeDb(rows: readonly ZcodeRow[]): { dbPath: string; cleanup: () => void } {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-zcode-usage-"));
  const dbPath = NodePath.join(dir, "db.sqlite");
  const db = new NodeSqlite.DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE model_usage (
      id TEXT PRIMARY KEY,
      session_id TEXT,
      turn_id TEXT,
      model_id TEXT,
      status TEXT,
      started_at INTEGER,
      completed_at INTEGER,
      input_tokens INTEGER,
      output_tokens INTEGER,
      reasoning_tokens INTEGER,
      cache_creation_input_tokens INTEGER,
      cache_read_input_tokens INTEGER,
      query_source TEXT
    )
  `);
  const insert = db.prepare(`
    INSERT INTO model_usage (
      id, session_id, turn_id, model_id, status, started_at, completed_at,
      input_tokens, output_tokens, reasoning_tokens,
      cache_creation_input_tokens, cache_read_input_tokens, query_source
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const row of rows) {
    insert.run(
      row.id,
      row.sessionId ?? "session-1",
      "turn-1",
      row.modelId ?? "kimi-k3",
      row.status ?? "completed",
      row.startedAt ?? 1_786_000_000_000,
      row.completedAt === undefined ? 1_786_000_001_000 : row.completedAt,
      row.inputTokens ?? 0,
      row.outputTokens ?? 0,
      row.reasoningTokens ?? 0,
      row.cacheCreationInputTokens ?? 0,
      row.cacheReadInputTokens ?? 0,
      "main_turn",
    );
  }
  db.close();
  return {
    dbPath,
    cleanup: () => NodeFS.rmSync(dir, { recursive: true, force: true }),
  };
}

describe("readTranscriptRecords for zcode", () => {
  it("maps completed model_usage rows to usage records", async () => {
    const { dbPath, cleanup } = createZcodeDb([
      {
        id: "usage_model_main_turn_msg_1_0",
        sessionId: "session-a",
        modelId: "kimi-k3",
        startedAt: 1_786_000_000_000,
        completedAt: 1_786_000_002_500,
        inputTokens: 1_050,
        outputTokens: 45,
        reasoningTokens: 12,
        cacheCreationInputTokens: 30,
        cacheReadInputTokens: 900,
      },
    ]);
    try {
      const records = await readTranscriptRecords(dbPath, "zcode", 0);

      expect(records).toEqual([
        {
          provider: "zcode",
          timestampMs: 1_786_000_000_000,
          model: "kimi-k3",
          sessionId: "session-a",
          totals: {
            uncachedInputTokens: 120,
            cachedInputTokens: 900,
            cacheCreationTokens: 30,
            outputTokens: 45,
            reasoningTokens: 12,
          },
          reportedCostUsd: null,
          dedupeKey: "usage_model_main_turn_msg_1_0",
        },
      ]);
    } finally {
      cleanup();
    }
  });

  it("counts only completed attempts and timestamps them by started_at", async () => {
    const { dbPath, cleanup } = createZcodeDb([
      { id: "row-failed", status: "failed", outputTokens: 10 },
      { id: "row-running", status: "running", outputTokens: 10 },
      {
        id: "row-done",
        status: "completed",
        startedAt: 1_786_000_004_000,
        completedAt: null,
        outputTokens: 10,
      },
    ]);
    try {
      const records = await readTranscriptRecords(dbPath, "zcode", 0);

      expect(records).toHaveLength(1);
      expect(records?.[0]?.dedupeKey).toBe("row-done");
      expect(records?.[0]?.timestampMs).toBe(1_786_000_004_000);
    } finally {
      cleanup();
    }
  });

  it("reads only rows inside the requested prefilter window", async () => {
    const { dbPath, cleanup } = createZcodeDb([
      {
        id: "row-before-cutoff",
        startedAt: 1_785_999_999_000,
        completedAt: 1_785_999_999_500,
        outputTokens: 10,
      },
      { id: "row-at-cutoff", startedAt: 1_786_000_000_000, outputTokens: 20 },
    ]);
    try {
      const records = await readTranscriptRecords(dbPath, "zcode", 1_786_000_000_000);

      expect(records?.map((record) => record.dedupeKey)).toEqual(["row-at-cutoff"]);
    } finally {
      cleanup();
    }
  });

  it("uses started_at as the cutoff even when completion crosses it", async () => {
    const { dbPath, cleanup } = createZcodeDb([
      {
        id: "row-crossing-cutoff",
        startedAt: 1_785_999_999_999,
        completedAt: 1_786_000_000_001,
        outputTokens: 10,
      },
    ]);
    try {
      expect(await readTranscriptRecords(dbPath, "zcode", 1_786_000_000_000)).toEqual([]);
    } finally {
      cleanup();
    }
  });

  it("does not turn read failures into cacheable empty records", async () => {
    const missing = await readTranscriptRecords(
      NodePath.join(NodeOS.tmpdir(), "t3-zcode-usage-no-such-dir", "db.sqlite"),
      "zcode",
      0,
    );
    expect(missing).toBeNull();

    const corruptDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-zcode-corrupt-"));
    const corruptPath = NodePath.join(corruptDir, "db.sqlite");
    NodeFS.writeFileSync(corruptPath, "not a sqlite database");
    try {
      expect(await readTranscriptRecords(corruptPath, "zcode", 0)).toBeNull();
    } finally {
      NodeFS.rmSync(corruptDir, { recursive: true, force: true });
    }
  });

  it("yields zero records for an older db without model_usage", async () => {
    // A db without model_usage (an older or foreign layout) is zero usage,
    // never a failed scan.
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-zcode-usage-empty-"));
    const dbPath = NodePath.join(dir, "db.sqlite");
    new NodeSqlite.DatabaseSync(dbPath).close();
    try {
      expect(await readTranscriptRecords(dbPath, "zcode", 0)).toEqual([]);
    } finally {
      NodeFS.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reads only rows within the retained history", async () => {
    const cutoffMs = 1_786_000_000_000;
    const { dbPath, cleanup } = createZcodeDb([
      { id: "row-before-cutoff", startedAt: cutoffMs - 1, completedAt: cutoffMs },
      { id: "row-at-cutoff", startedAt: cutoffMs, completedAt: cutoffMs + 1 },
    ]);
    try {
      const records = await readTranscriptRecords(dbPath, "zcode", cutoffMs);

      expect(records?.map((record) => record.dedupeKey)).toEqual(["row-at-cutoff"]);
    } finally {
      cleanup();
    }
  });

  it("includes the sqlite WAL in the scan fingerprint", async () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-zcode-usage-wal-"));
    const dbPath = NodePath.join(dir, "db.sqlite");
    const db = new NodeSqlite.DatabaseSync(dbPath);
    try {
      db.exec("PRAGMA journal_mode = WAL; CREATE TABLE usage (id TEXT)");
      db.prepare("INSERT INTO usage VALUES (?)").run("new-row");

      const dbStats = NodeFS.statSync(dbPath);
      const walStats = NodeFS.statSync(`${dbPath}-wal`);
      const [file] = await statSqliteUsageStore(dbPath, 0);

      expect(file).toEqual({
        path: dbPath,
        size: dbStats.size + walStats.size,
        mtimeMs: Math.max(dbStats.mtimeMs, walStats.mtimeMs),
      });
    } finally {
      db.close();
      NodeFS.rmSync(dir, { recursive: true, force: true });
    }
  });
});
