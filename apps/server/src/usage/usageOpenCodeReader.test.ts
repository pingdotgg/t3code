// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import { afterEach, describe, expect, it } from "@effect/vitest";

import { readOpenCodeUsageRecords, resolveOpenCodeDataDir } from "./usageOpenCodeReader.ts";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) NodeFS.rmSync(dir, { recursive: true, force: true });
});

function makeDatabase(): { readonly database: NodeSqlite.DatabaseSync; readonly path: string } {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-opencode-usage-"));
  tempDirs.push(dir);
  const path = NodePath.join(dir, "opencode.db");
  return { database: new NodeSqlite.DatabaseSync(path), path };
}

function createCurrentTable(database: NodeSqlite.DatabaseSync): void {
  database.exec(`
    CREATE TABLE session_message (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      type TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      data TEXT NOT NULL
    );
    CREATE INDEX session_message_time_created_idx ON session_message (time_created);
  `);
}

function createLegacyTable(database: NodeSqlite.DatabaseSync): void {
  database.exec(`
    CREATE TABLE message (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      data TEXT NOT NULL
    );
    CREATE INDEX message_session_time_created_id_idx
      ON message (session_id, time_created, id);
  `);
}

describe("resolveOpenCodeDataDir", () => {
  it("uses the XDG data home when configured", () => {
    expect(resolveOpenCodeDataDir({ XDG_DATA_HOME: "/var/data" }, "/home/test")).toBe(
      "/var/data/opencode",
    );
  });

  it("uses OpenCode's default data home", () => {
    expect(resolveOpenCodeDataDir({}, "/home/test")).toBe("/home/test/.local/share/opencode");
  });
});

describe("readOpenCodeUsageRecords", () => {
  it("reads exact current-schema message usage", () => {
    const { database, path } = makeDatabase();
    createCurrentTable(database);
    database
      .prepare(
        "INSERT INTO session_message (id, session_id, type, time_created, data) VALUES (?, ?, ?, ?, ?)",
      )
      .run(
        "message-1",
        "session-1",
        "assistant",
        Date.parse("2026-08-15T10:00:00.000Z"),
        JSON.stringify({
          time: { completed: Date.parse("2026-08-15T10:00:05.000Z") },
          model: { providerID: "anthropic", id: "claude-opus-4-1" },
          cost: 1.25,
          tokens: {
            input: 100,
            output: 50,
            reasoning: 20,
            cache: { read: 1000, write: 10 },
          },
          content: [{ type: "text", text: "This large field is never selected." }],
        }),
      );
    database.close();

    const result = readOpenCodeUsageRecords(path, Date.parse("2026-08-01T00:00:00.000Z"));

    expect(result).toEqual({
      status: "ok",
      schema: "current",
      malformedRecords: 0,
      records: [
        {
          provider: "opencode",
          timestampMs: Date.parse("2026-08-15T10:00:05.000Z"),
          model: "anthropic/claude-opus-4-1",
          sessionId: "session-1",
          totals: {
            uncachedInputTokens: 100,
            cachedInputTokens: 1000,
            cacheCreationTokens: 10,
            outputTokens: 70,
            reasoningTokens: 20,
          },
          reportedCostUsd: 1.25,
          dedupeKey: "opencode:message-1",
        },
      ],
    });
  });

  it("uses per-session migration boundaries for nonmatching dual-write IDs", () => {
    const { database, path } = makeDatabase();
    createCurrentTable(database);
    createLegacyTable(database);
    database
      .prepare(
        "INSERT INTO session_message (id, session_id, type, time_created, data) VALUES (?, ?, 'assistant', ?, ?)",
      )
      .run(
        "step-start-event",
        "session-1",
        1100,
        JSON.stringify({
          time: { completed: 1200 },
          model: { providerID: "openai", id: "gpt-5" },
          tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
        }),
      );
    database
      .prepare("INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)")
      .run(
        "legacy-before-migration",
        "session-1",
        900,
        JSON.stringify({
          role: "assistant",
          time: { completed: 1000 },
          providerID: "openai",
          modelID: "gpt-4.1",
          tokens: { input: 4, output: 2, reasoning: 0, cache: { read: 0, write: 0 } },
        }),
      );
    database
      .prepare("INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)")
      .run(
        "legacy-dual-write-message",
        "session-1",
        1050,
        JSON.stringify({
          role: "assistant",
          time: { completed: 1201 },
          providerID: "openai",
          modelID: "gpt-5",
          tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
        }),
      );
    database
      .prepare("INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)")
      .run(
        "legacy-only",
        "session-old",
        1300,
        JSON.stringify({
          role: "assistant",
          providerID: "anthropic",
          modelID: "claude-sonnet-4",
          tokens: { input: 20, output: 8, reasoning: 0, cache: { read: 0, write: 0 } },
        }),
      );
    database.close();

    const result = readOpenCodeUsageRecords(path, 0);

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.schema).toBe("mixed");
    expect(result.records.map((record) => record.dedupeKey).sort()).toEqual([
      "opencode:legacy-before-migration",
      "opencode:legacy-only",
      "opencode:step-start-event",
    ]);
  });

  it("counts inherited legacy history once across repeated forks", () => {
    const { database, path } = makeDatabase();
    createLegacyTable(database);
    const insert = database.prepare(
      "INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)",
    );
    const inherited = JSON.stringify({
      role: "assistant",
      time: { completed: 1100 },
      providerID: "anthropic",
      modelID: "claude-sonnet-4",
      cost: 0.25,
      tokens: { input: 20, output: 8, reasoning: 2, cache: { read: 100, write: 0 } },
    });
    insert.run("original-message", "original-session", 1000, inherited);
    insert.run("first-fork-clone", "first-fork", 1000, inherited);
    insert.run("second-fork-clone", "second-fork", 1000, inherited);
    insert.run(
      "post-fork-call",
      "second-fork",
      2000,
      JSON.stringify({
        role: "assistant",
        time: { completed: 2100 },
        providerID: "anthropic",
        modelID: "claude-sonnet-4",
        cost: 0.1,
        tokens: { input: 7, output: 3, reasoning: 0, cache: { read: 0, write: 0 } },
      }),
    );
    database.close();

    const result = readOpenCodeUsageRecords(path, 0);

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.records.map((record) => record.dedupeKey)).toEqual([
      "opencode:original-message",
      "opencode:post-fork-call",
    ]);
  });

  it("does not resurrect a current-owned call through legacy fork clones", () => {
    const { database, path } = makeDatabase();
    createCurrentTable(database);
    createLegacyTable(database);
    database
      .prepare(
        "INSERT INTO session_message (id, session_id, type, time_created, data) VALUES (?, ?, 'assistant', ?, ?)",
      )
      .run(
        "step-start-event",
        "original-session",
        1010,
        JSON.stringify({
          time: { completed: 1090 },
          model: { providerID: "openai", id: "gpt-5" },
          cost: 0.4,
          tokens: { input: 30, output: 10, reasoning: 0, cache: { read: 0, write: 0 } },
        }),
      );
    const insert = database.prepare(
      "INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)",
    );
    const inherited = JSON.stringify({
      role: "assistant",
      time: { completed: 1100 },
      providerID: "openai",
      modelID: "gpt-5",
      cost: 0.4,
      tokens: { input: 30, output: 10, reasoning: 0, cache: { read: 0, write: 0 } },
    });
    insert.run("legacy-original", "original-session", 1000, inherited);
    insert.run("legacy-fork-one", "fork-one", 1000, inherited);
    insert.run("legacy-fork-two", "fork-two", 1000, inherited);
    database.close();

    const result = readOpenCodeUsageRecords(path, 0);

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.records.map((record) => record.dedupeKey)).toEqual(["opencode:step-start-event"]);
  });

  it("falls back to legacy message rows", () => {
    const { database, path } = makeDatabase();
    createLegacyTable(database);
    database
      .prepare("INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)")
      .run(
        "legacy-message",
        "session-legacy",
        2000,
        JSON.stringify({
          role: "assistant",
          providerID: "google",
          modelID: "gemini-2.5-pro",
          cost: 0,
          tokens: {
            input: 15,
            output: 7,
            reasoning: 3,
            cache: { read: 4, write: 2 },
          },
        }),
      );
    database.close();

    const result = readOpenCodeUsageRecords(path, 0);

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.schema).toBe("legacy");
    expect(result.records[0]).toMatchObject({
      model: "google/gemini-2.5-pro",
      reportedCostUsd: 0,
      totals: { outputTokens: 10, reasoningTokens: 3 },
    });
  });

  it("uses the indexed creation time as a prefilter and counts unusable rows", () => {
    const { database, path } = makeDatabase();
    createCurrentTable(database);
    const insert = database.prepare(
      "INSERT INTO session_message (id, session_id, type, time_created, data) VALUES (?, 'session-1', 'assistant', ?, ?)",
    );
    insert.run(
      "before-window",
      999,
      JSON.stringify({
        model: { providerID: "openai", id: "gpt-5" },
        tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
      }),
    );
    insert.run("malformed", 1000, JSON.stringify({ model: { providerID: "openai" } }));
    insert.run(
      "interrupted",
      1001,
      JSON.stringify({ model: { providerID: "openai", id: "gpt-5" } }),
    );
    insert.run(
      "cancelled",
      1002,
      JSON.stringify({
        model: { providerID: "openai", id: "gpt-5" },
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      }),
    );
    database.close();

    const result = readOpenCodeUsageRecords(path, 1000);

    expect(result).toMatchObject({ status: "ok", records: [], malformedRecords: 1 });
  });

  it("reuses unchanged database results and invalidates them after a write", () => {
    const { database, path } = makeDatabase();
    createLegacyTable(database);
    const insert = database.prepare(
      "INSERT INTO message (id, session_id, time_created, data) VALUES (?, 'session-1', ?, ?)",
    );
    const usage = (input: number) =>
      JSON.stringify({
        role: "assistant",
        providerID: "openai",
        modelID: "gpt-5",
        tokens: { input, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
      });
    insert.run("first", 1000, usage(1));
    database.close();

    const first = readOpenCodeUsageRecords(path, 0);
    expect(readOpenCodeUsageRecords(path, 0)).toBe(first);

    const writer = new NodeSqlite.DatabaseSync(path);
    writer
      .prepare(
        "INSERT INTO message (id, session_id, time_created, data) VALUES (?, 'session-1', ?, ?)",
      )
      .run("second", 2000, usage(2));
    writer.close();

    const afterWrite = readOpenCodeUsageRecords(path, 0);
    expect(afterWrite).not.toBe(first);
    expect(afterWrite.status).toBe("ok");
    if (afterWrite.status !== "ok") return;
    expect(afterWrite.records).toHaveLength(2);
  });

  it("reports unsupported databases without presenting zero usage as valid", () => {
    const { database, path } = makeDatabase();
    database.exec("CREATE TABLE unrelated (id TEXT PRIMARY KEY)");
    database.close();

    expect(readOpenCodeUsageRecords(path, 0)).toEqual({
      status: "failed",
      message: "The OpenCode database uses an unsupported session schema.",
    });
  });
});
