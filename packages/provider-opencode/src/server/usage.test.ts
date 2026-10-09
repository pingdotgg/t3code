// @effect-diagnostics nodeBuiltinImport:off - the reader under test opens real
// SQLite databases and walks a real legacy JSON store.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import { afterEach, assert, beforeEach, describe, it } from "@effect/vitest";

import { readOpenCodeUsage } from "./usage.ts";

let dir: string;

beforeEach(async () => {
  dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "usage-reader-test-"));
});

afterEach(async () => {
  await NodeFSP.rm(dir, { recursive: true, force: true });
});

describe("readOpenCodeUsage", () => {
  it("counts migrated OpenCode messages once and sees subsequent WAL writes", async () => {
    const db = new NodeSqlite.DatabaseSync(NodePath.join(dir, "opencode.db"));
    try {
      db.exec(
        "PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0; CREATE TABLE message (id TEXT, session_id TEXT, data TEXT)",
      );
      const message = {
        id: "msg-1",
        sessionID: "session-1",
        role: "assistant",
        modelID: "claude-sonnet-4-5",
        time: { created: 1780000000000 },
        cost: 0.25,
        tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 30, write: 10 } },
      };
      const insert = db.prepare("INSERT INTO message VALUES (?, ?, ?)");
      insert.run(message.id, message.sessionID, JSON.stringify(message));
      const legacy = NodePath.join(dir, "storage", "message", message.sessionID);
      await NodeFSP.mkdir(legacy, { recursive: true });
      await NodeFSP.writeFile(NodePath.join(legacy, "msg-1.json"), JSON.stringify(message));
      const first = await readOpenCodeUsage(dir, 0);
      assert.isFalse(first.error);
      const records = first.files.flatMap((file) => file.records);
      assert.strictEqual(records.length, 1);
      assert.deepStrictEqual(records[0]?.totals, {
        uncachedInputTokens: 100,
        cachedInputTokens: 30,
        cacheCreationTokens: 10,
        outputTokens: 25,
        reasoningTokens: 5,
      });
      assert.strictEqual(records[0]?.reportedCostUsd, 0.25);
      insert.run(
        "msg-2",
        message.sessionID,
        JSON.stringify({ ...message, id: "msg-2", time: { created: 1780000001000 } }),
      );
      const next = await readOpenCodeUsage(dir, 1780000001000);
      assert.isFalse(next.error);
      assert.deepStrictEqual(
        next.files.flatMap((file) => file.records).map((record) => record.dedupeKey),
        ["opencode:msg-2"],
      );
      assert.isAbove((await NodeFSP.stat(NodePath.join(dir, "opencode.db-wal"))).size, 0);
    } finally {
      db.close();
    }
  });
});
