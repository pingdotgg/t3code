// @effect-diagnostics nodeBuiltinImport:off - fixture stores must be real
// SQLite databases so the reader's own deliberate node:sqlite usage is
// exercised end to end.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest";

import { readOpenCodeUsageRecords } from "./opencodeUsageStore.ts";

let dir: string;

beforeEach(async () => {
  dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "opencode-store-test-"));
});

afterEach(async () => {
  await NodeFSP.rm(dir, { recursive: true, force: true });
});

/** The store's real schema is one JSON payload column keyed by message id. */
function createMessageStore(dbPath: string): NodeSqlite.DatabaseSync {
  const database = new NodeSqlite.DatabaseSync(dbPath);
  database.exec(
    "CREATE TABLE `message` (`id` text PRIMARY KEY, `session_id` text NOT NULL, `time_created` integer NOT NULL, `data` text NOT NULL)",
  );
  return database;
}

function assistantRow(overrides?: {
  id?: string;
  sessionId?: string;
  createdMs?: number;
  input?: number;
  output?: number;
  cacheRead?: number;
  cost?: number;
  data?: string;
}): { sessionId: string; createdMs: number; data: string } {
  const createdMs = overrides?.createdMs ?? 1_788_951_671_960;
  return {
    sessionId: overrides?.sessionId ?? "ses_1",
    createdMs,
    data:
      overrides?.data ??
      JSON.stringify({
        role: "assistant",
        cost: overrides?.cost ?? 0.001,
        tokens: {
          input: overrides?.input ?? 375,
          output: overrides?.output ?? 123,
          reasoning: 0,
          cache: { read: overrides?.cacheRead ?? 65_856, write: 0 },
        },
        modelID: "z-ai/glm-5.3-flash",
        providerID: "openrouter",
        time: { created: createdMs },
      }),
  };
}

describe("readOpenCodeUsageRecords", () => {
  it("reads in-window assistant rows oldest first and skips the rest", async () => {
    const dbPath = NodePath.join(dir, "opencode.db");
    const database = createMessageStore(dbPath);
    const insert = database.prepare(
      "INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)",
    );
    const old = assistantRow({ createdMs: 1_000 });
    const user = assistantRow({ createdMs: 2_000, data: JSON.stringify({ role: "user" }) });
    const first = assistantRow({ createdMs: 3_000, sessionId: "ses_a" });
    const second = assistantRow({ createdMs: 4_000, input: 10, output: 1, cacheRead: 0 });
    for (const [id, row] of [
      ["msg_old", old],
      ["msg_user", user],
      ["msg_a", first],
      ["msg_b", second],
    ] as const) {
      insert.run(id, row.sessionId, row.createdMs, row.data);
    }
    database.close();

    const read = await readOpenCodeUsageRecords(dbPath, 2_000);

    expect(read.kind).toBe("ok");
    if (read.kind !== "ok") return;
    expect(read.records).toHaveLength(2);
    expect(read.records[0]?.sessionId).toBe("ses_a");
    expect(read.records[0]?.timestampMs).toBe(3_000);
    expect(read.records[1]?.totals.outputTokens).toBe(1);
  });

  it("reads past a page boundary without losing or reordering records", async () => {
    const dbPath = NodePath.join(dir, "opencode.db");
    const database = createMessageStore(dbPath);
    const insert = database.prepare(
      "INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)",
    );
    const base = 1_788_951_671_960;
    for (let index = 0; index < 1201; index += 1) {
      const createdMs = base + index;
      insert.run(
        `msg_${index}`,
        "ses_1",
        createdMs,
        JSON.stringify({
          role: "assistant",
          cost: 0.001,
          tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
          modelID: "m",
          providerID: "p",
          time: { created: createdMs },
        }),
      );
    }
    database.close();

    const read = await readOpenCodeUsageRecords(dbPath, base);

    expect(read.kind).toBe("ok");
    if (read.kind !== "ok") return;
    expect(read.records).toHaveLength(1201);
    expect(read.records[0]?.timestampMs).toBe(base);
    expect(read.records.at(-1)?.timestampMs).toBe(base + 1200);
  });

  it("orders records by message time, not insertion order", async () => {
    const dbPath = NodePath.join(dir, "opencode.db");
    const database = createMessageStore(dbPath);
    const insert = database.prepare(
      "INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)",
    );
    // A backfilled message lands later in the table than an older instant.
    const late = assistantRow({ createdMs: 5_000 });
    const backfilled = assistantRow({ createdMs: 2_000, input: 10 });
    insert.run("msg_late", late.sessionId, late.createdMs, late.data);
    insert.run("msg_backfill", backfilled.sessionId, backfilled.createdMs, backfilled.data);
    database.close();

    const read = await readOpenCodeUsageRecords(dbPath, 0);

    expect(read.kind).toBe("ok");
    if (read.kind !== "ok") return;
    expect(read.records.map((record) => record.timestampMs)).toEqual([2_000, 5_000]);
  });

  it("reports a store that was never created as missing", async () => {
    const read = await readOpenCodeUsageRecords(NodePath.join(dir, "absent.db"), 0);
    expect(read.kind).toBe("missing");
  });

  it("reports a store it cannot read as failed", async () => {
    const dbPath = NodePath.join(dir, "opencode.db");
    await NodeFSP.writeFile(dbPath, "this is not a sqlite database");
    const read = await readOpenCodeUsageRecords(dbPath, 0);

    expect(read.kind).toBe("failed");
    if (read.kind !== "failed") return;
    expect(read.message).toMatch(/^OpenCode store read failed/);
  });
});
