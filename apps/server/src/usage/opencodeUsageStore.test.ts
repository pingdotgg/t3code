// @effect-diagnostics nodeBuiltinImport:off - the suite seeds a real
// OpenCode-shaped SQLite store on disk.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import { assert, describe, it } from "@effect/vitest";

import { readOpenCodeUsageRecords } from "./opencodeUsageStore.ts";

const TIMESTAMP_MS = Date.parse("2026-08-01T10:00:00Z");

function assistantData(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    role: "assistant",
    modelID: "kimi-latest",
    providerID: "fireworks-ai",
    cost: 0.4,
    tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 1000, write: 10 } },
    time: { created: TIMESTAMP_MS },
    ...overrides,
  });
}

function withStore(run: (dbPath: string) => Promise<void>): Promise<void> {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-opencode-usage-"));
  const dbPath = NodePath.join(dir, "opencode.db");
  return run(dbPath).finally(() => NodeFS.rmSync(dir, { recursive: true, force: true }));
}

function seed(dbPath: string, rows: readonly [string, string][]): void {
  const db = new NodeSqlite.DatabaseSync(dbPath);
  db.exec(
    "CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL)",
  );
  const insert = db.prepare(
    "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, 'ses_oc1', ?, ?, ?)",
  );
  for (const [id, data] of rows) insert.run(id, TIMESTAMP_MS, TIMESTAMP_MS, data);
  db.close();
}

describe("readOpenCodeUsageRecords", () => {
  it("returns one normalized record per assistant row", () =>
    withStore(async (dbPath) => {
      seed(dbPath, [
        ["msg_1", assistantData()],
        ["msg_2", assistantData({ role: "user" })],
        ["msg_3", "not json"],
        [
          "msg_4",
          assistantData({
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          }),
        ],
      ]);

      const result = await readOpenCodeUsageRecords(dbPath);

      assert.isNotNull(result);
      assert.strictEqual(result?.records.length, 1);
      const record = result?.records[0];
      assert.strictEqual(record?.provider, "opencode");
      assert.strictEqual(record?.dedupeKey, "msg_1");
      assert.deepEqual(record?.totals, {
        uncachedInputTokens: 100,
        cachedInputTokens: 1000,
        cacheCreationTokens: 10,
        outputTokens: 25,
        reasoningTokens: 5,
      });
      assert.strictEqual(record?.reportedCostUsd, 0.4);
      assert.deepEqual(result?.position, {
        resumeOffset: 0,
        guardLength: 0,
        guardHash: 0,
        codexState: null,
      });
    }));

  it("returns null for a missing database so the scan does not cache it", () =>
    withStore(async (dbPath) => {
      assert.isNull(await readOpenCodeUsageRecords(dbPath));
    }));

  it("reflects in-place updates on the next read", () =>
    withStore(async (dbPath) => {
      seed(dbPath, [["msg_1", assistantData()]]);

      const db = new NodeSqlite.DatabaseSync(dbPath);
      db.prepare("UPDATE message SET data = ? WHERE id = 'msg_1'").run(
        assistantData({
          tokens: { input: 200, output: 40, reasoning: 10, cache: { read: 0, write: 0 } },
        }),
      );
      db.close();

      const result = await readOpenCodeUsageRecords(dbPath);
      assert.strictEqual(result?.records[0]?.totals.uncachedInputTokens, 200);
      assert.strictEqual(result?.records[0]?.totals.outputTokens, 50);
    }));
});
