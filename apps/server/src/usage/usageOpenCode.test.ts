// @effect-diagnostics nodeBuiltinImport:off - the reader test seeds a fake
// opencode home with a real SQLite database on disk.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import * as NodeTimersPromises from "node:timers/promises";

import { describe, expect, it } from "vite-plus/test";

import { OPENCODE_DB_FILENAME, readOpenCodeRecords } from "./usageOpenCode.ts";

import { resolveOpenCodeDataDir } from "../provider/openCodePaths.ts";

describe("resolveOpenCodeDataDir", () => {
  it("mirrors opencode's own data dir on every platform", () => {
    expect(resolveOpenCodeDataDir({ XDG_DATA_HOME: "/data", HOME: "/home/u" })).toBe(
      NodePath.join("/data", "opencode"),
    );
    expect(resolveOpenCodeDataDir({ HOME: "/home/u" })).toBe(
      NodePath.join("/home/u", ".local", "share", "opencode"),
    );
  });
});

function goMessage(modelId: string, completed: number, cost = 0.001, created = completed - 1000) {
  return JSON.stringify({
    time: { created, completed },
    agent: "build",
    model: { id: modelId, providerID: "opencode-go", variant: "default" },
    cost,
    tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 1000, write: 0 } },
  });
}

/** Runs `test` against a seeded database in a throwaway dir, then removes it. */
async function withSeededDb(test: (dbPath: string) => Promise<void>): Promise<void> {
  const home = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "usage-opencode-test-"));
  try {
    const dbPath = NodePath.join(home, OPENCODE_DB_FILENAME);
    const db = new NodeSqlite.DatabaseSync(dbPath);
    try {
      db.exec(
        "CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, type TEXT NOT NULL, data TEXT NOT NULL)",
      );
      db.exec(
        "CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, data TEXT NOT NULL)",
      );
      const insertCurrent = db.prepare(
        "INSERT INTO session_message (id, session_id, type, data) VALUES (?, ?, ?, ?)",
      );
      // In-window Go row.
      insertCurrent.run(
        "msg_go_1",
        "ses_1",
        "assistant",
        goMessage("glm-5.3-flash", 1_787_000_000_000),
      );
      // Out-of-window Go row.
      insertCurrent.run(
        "msg_go_old",
        "ses_1",
        "assistant",
        goMessage("glm-5.3-flash", 1_700_000_000_000),
      );
      // Turns routed to other upstreams count too; user rows never do.
      insertCurrent.run(
        "msg_oauth_1",
        "ses_1",
        "assistant",
        goMessage("gpt-5.3-codex", 1_787_000_000_000).replace("opencode-go", "openai"),
      );
      insertCurrent.run("msg_user_1", "ses_1", "user", '{"role":"user"}');
      // Corrupt JSON never reaches the parser; valid JSON without a usage
      // payload counts as malformed.
      insertCurrent.run("msg_bad_1", "ses_1", "assistant", "{oops");
      insertCurrent.run(
        "msg_empty_1",
        "ses_1",
        "assistant",
        '{"model":{"id":"x","providerID":"opencode-go"},"time":{"completed":1787000000000}}',
      );
      // Pre-migration history only in the legacy table.
      db.prepare("INSERT INTO message (id, session_id, data) VALUES (?, ?, ?)").run(
        "msg_legacy_1",
        "ses_old",
        '{"role":"assistant","time":{"created":1786900000000,"completed":1786900001000},' +
          '"providerID":"opencode-go","modelID":"kimi-k2.6","cost":0.002,' +
          '"tokens":{"input":50,"output":10,"reasoning":0,"cache":{"read":500,"write":0}}}',
      );
    } finally {
      db.close();
    }
    await test(dbPath);
  } finally {
    await NodeFSP.rm(home, { recursive: true, force: true });
  }
}

function alterDb(dbPath: string, sql: string): void {
  const db = new NodeSqlite.DatabaseSync(dbPath);
  try {
    db.exec(sql);
  } finally {
    db.close();
  }
}

describe("readOpenCodeRecords", () => {
  it("reads assistant rows from both tables and skips the rest", () =>
    withSeededDb(async (dbPath) => {
      const result = await readOpenCodeRecords(dbPath, 1_786_000_000_000);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.records.map((record) => record.dedupeKey).sort()).toEqual([
        "msg_go_1",
        "msg_legacy_1",
        "msg_oauth_1",
      ]);
      expect(result.records[0]?.provider).toBe("opencode");
      expect(result.records[0]?.model).toBe("glm-5.3-flash");
      expect(result.records[0]?.reportedCostUsd).toBe(0.001);
      expect(result.malformedRecords).toBe(1);
    }));

  it.each(["session_message", "message"])("reads a database with only %s", (table) =>
    withSeededDb(async (dbPath) => {
      alterDb(dbPath, `DROP TABLE ${table === "message" ? "session_message" : "message"}`);
      const result = await readOpenCodeRecords(dbPath, 1_786_000_000_000);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.records.map((record) => record.dedupeKey)).toEqual(
        table === "message" ? ["msg_legacy_1"] : ["msg_go_1", "msg_oauth_1"],
      );
      expect(result.partial).toBe(false);
    }),
  );

  it("yields through nonmatching history and keeps turns completed inside the window", () =>
    withSeededDb(async (dbPath) => {
      const db = new NodeSqlite.DatabaseSync(dbPath);
      const insert = db.prepare("INSERT INTO session_message VALUES (?, ?, ?, ?)");
      db.exec("BEGIN");
      for (let index = 0; index < 600; index += 1) {
        insert.run(`old_${index}`, "ses_old", "assistant", goMessage("old", 1_700_000_000_000));
      }
      insert.run(
        "long_turn",
        "ses_long",
        "assistant",
        goMessage("long-turn", 1_787_000_000_000, 0.001, 1_700_000_000_000),
      );
      db.exec("COMMIT");
      db.close();
      let finished = false;
      const reading = readOpenCodeRecords(dbPath, 1_786_000_000_000).then((result) => {
        finished = true;
        return result;
      });
      await NodeTimersPromises.setImmediate();
      expect(finished).toBe(false);
      const result = await reading;
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.records.map((record) => record.dedupeKey).sort()).toEqual([
        "long_turn",
        "msg_go_1",
        "msg_legacy_1",
        "msg_oauth_1",
      ]);
    }));

  it("reports a partial read when a present table cannot be read", () =>
    withSeededDb(async (dbPath) => {
      // A future opencode schema that renames the payload column.
      alterDb(dbPath, "ALTER TABLE session_message RENAME COLUMN data TO payload");
      const result = await readOpenCodeRecords(dbPath, 1_786_000_000_000);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.partial).toBe(true);
      expect(result.records.map((record) => record.dedupeKey)).toEqual(["msg_legacy_1"]);
    }));

  it("reports failure when neither table exists", () =>
    withSeededDb(async (dbPath) => {
      alterDb(dbPath, "DROP TABLE session_message; DROP TABLE message");
      expect(await readOpenCodeRecords(dbPath, 0)).toEqual({ ok: false });
    }));

  it("reports failure for a missing or unreadable database", async () => {
    expect(await readOpenCodeRecords("/nonexistent/opencode.db", 0)).toEqual({ ok: false });
  });
});
