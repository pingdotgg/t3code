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

  it("unions migrated databases by message ID and prefers current duplicates", () => {
    const { database, path } = makeDatabase();
    createCurrentTable(database);
    createLegacyTable(database);
    database
      .prepare(
        "INSERT INTO session_message (id, session_id, type, time_created, data) VALUES (?, ?, 'assistant', ?, ?)",
      )
      .run(
        "shared-message",
        "session-1",
        1000,
        JSON.stringify({
          model: { providerID: "openai", id: "gpt-5" },
          tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
        }),
      );
    database
      .prepare("INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)")
      .run(
        "shared-message",
        "session-1",
        1000,
        JSON.stringify({
          role: "assistant",
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
        1100,
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
      "opencode:legacy-only",
      "opencode:shared-message",
    ]);
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
      "cancelled",
      1001,
      JSON.stringify({
        model: { providerID: "openai", id: "gpt-5" },
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      }),
    );
    database.close();

    const result = readOpenCodeUsageRecords(path, 1000);

    expect(result).toMatchObject({ status: "ok", records: [], malformedRecords: 1 });
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
