// @effect-diagnostics nodeBuiltinImport:off -- SQLite integration coverage needs a real temporary file.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import { describe, expect, it } from "@effect/vitest";

import {
  parseOpenCodeUsageRow,
  readOpenCodeUsage,
  resolveOpenCodeDatabasePaths,
} from "./usageOpenCode.ts";

function row(overrides: Record<string, unknown> = {}) {
  return {
    messageId: "msg_01",
    sessionId: "ses_01",
    timestampMs: 1_786_053_607_405,
    providerId: "github-copilot",
    modelId: "gpt-5.6-sol",
    inputTokens: 4194,
    outputTokens: 91,
    reasoningTokens: 263,
    cacheReadTokens: 22_912,
    cacheWriteTokens: 17,
    costUsd: 0.42,
    ...overrides,
  };
}

describe("parseOpenCodeUsageRow", () => {
  it("maps OpenCode assistant usage into the shared token convention", () => {
    const record = parseOpenCodeUsageRow(row());

    expect(record).toEqual({
      provider: "opencode",
      timestampMs: 1_786_053_607_405,
      model: "github-copilot/gpt-5.6-sol",
      sessionId: "ses_01",
      totals: {
        uncachedInputTokens: 4194,
        cachedInputTokens: 22_912,
        cacheCreationTokens: 17,
        outputTokens: 354,
        reasoningTokens: 263,
      },
      reportedCostUsd: 0.42,
      dedupeKey: "opencode:msg_01",
    });
  });

  it("keeps a reported zero cost for free OpenCode models", () => {
    expect(parseOpenCodeUsageRow(row({ costUsd: 0 }))?.reportedCostUsd).toBe(0);
  });

  it("falls back to model pricing when cost is absent", () => {
    expect(parseOpenCodeUsageRow(row({ costUsd: null }))?.reportedCostUsd).toBeNull();
  });

  it("ignores malformed rows and empty assistant attempts", () => {
    expect(parseOpenCodeUsageRow(row({ modelId: null }))).toBeNull();
    expect(
      parseOpenCodeUsageRow(
        row({
          inputTokens: 0,
          outputTokens: 0,
          reasoningTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          costUsd: 0,
        }),
      ),
    ).toBeNull();
  });
});

describe("resolveOpenCodeDatabasePaths", () => {
  const dataDir = NodePath.resolve("opencode-data");

  it("honors absolute and data-directory-relative OPENCODE_DB overrides", () => {
    const absoluteOverride = NodePath.resolve("custom-opencode.db");
    expect(
      resolveOpenCodeDatabasePaths({
        dataDir,
        databaseOverride: absoluteOverride,
        disableChannelDatabase: undefined,
        directoryEntries: ["opencode.db"],
        path: NodePath,
      }),
    ).toEqual([absoluteOverride]);
    expect(
      resolveOpenCodeDatabasePaths({
        dataDir,
        databaseOverride: "custom/opencode.db",
        disableChannelDatabase: undefined,
        directoryEntries: ["opencode.db"],
        path: NodePath,
      }),
    ).toEqual([NodePath.join(dataDir, "custom/opencode.db")]);
  });

  it("discovers stable and channel databases while ignoring SQLite sidecars", () => {
    expect(
      resolveOpenCodeDatabasePaths({
        dataDir,
        databaseOverride: undefined,
        disableChannelDatabase: undefined,
        directoryEntries: [
          "opencode-nightly.db",
          "opencode.db-wal",
          "opencode.db",
          "opencode-canary.db",
          "notes.txt",
        ],
        path: NodePath,
      }),
    ).toEqual([
      NodePath.join(dataDir, "opencode-canary.db"),
      NodePath.join(dataDir, "opencode-nightly.db"),
      NodePath.join(dataDir, "opencode.db"),
    ]);
  });

  it("uses only the stable database when channels are disabled", () => {
    expect(
      resolveOpenCodeDatabasePaths({
        dataDir,
        databaseOverride: undefined,
        disableChannelDatabase: "true",
        directoryEntries: ["opencode-canary.db"],
        path: NodePath,
      }),
    ).toEqual([NodePath.join(dataDir, "opencode.db")]);
  });

  it("does not try to attach to another process's in-memory database", () => {
    expect(
      resolveOpenCodeDatabasePaths({
        dataDir,
        databaseOverride: ":memory:",
        disableChannelDatabase: undefined,
        directoryEntries: [],
        path: NodePath,
      }),
    ).toEqual([]);
  });
});

describe("readOpenCodeUsage", () => {
  it("reads the legacy message schema without selecting conversation content", async () => {
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-opencode-usage-"));
    const databasePath = NodePath.join(directory, "opencode.db");
    let database: NodeSqlite.DatabaseSync | undefined;
    try {
      database = new NodeSqlite.DatabaseSync(databasePath);
      database.exec(`
        CREATE TABLE message (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          time_created INTEGER NOT NULL,
          data TEXT NOT NULL
        )
      `);
      const insert = database.prepare(
        "INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)",
      );
      insert.run(
        "msg_01",
        "ses_01",
        2000,
        JSON.stringify({
          role: "assistant",
          providerID: "openai",
          modelID: "gpt-5",
          tokens: { input: 10, output: 2, reasoning: 3, cache: { read: 4, write: 5 } },
          cost: 0.25,
          hiddenConversationContent: "must never be selected",
        }),
      );
      insert.run(
        "msg_user",
        "ses_01",
        2001,
        JSON.stringify({ role: "user", content: "not usage" }),
      );
      insert.run(
        "msg_placeholder",
        "ses_placeholder",
        2002,
        JSON.stringify({
          role: "assistant",
          providerID: "openai",
          modelID: "gpt-5",
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          cost: 0,
        }),
      );
      database.close();
      database = undefined;

      const result = await readOpenCodeUsage(databasePath, 1500);

      expect(result?.malformedRecords).toBe(0);
      expect(result?.records).toHaveLength(1);
      expect(result?.records[0]).toMatchObject({
        provider: "opencode",
        model: "openai/gpt-5",
        totals: { outputTokens: 5, reasoningTokens: 3 },
      });
      expect(result?.records[0]).not.toHaveProperty("hiddenConversationContent");
    } finally {
      database?.close();
      await NodeFSP.rm(directory, { recursive: true, force: true });
    }
  });

  it("reads the current session_message schema", async () => {
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-opencode-usage-"));
    const databasePath = NodePath.join(directory, "opencode.db");
    let database: NodeSqlite.DatabaseSync | undefined;
    try {
      database = new NodeSqlite.DatabaseSync(databasePath);
      database.exec(`
        CREATE TABLE session_message (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          type TEXT NOT NULL,
          time_created INTEGER NOT NULL,
          data TEXT NOT NULL
        )
      `);
      const insert = database.prepare(
        "INSERT INTO session_message (id, session_id, type, time_created, data) VALUES (?, ?, ?, ?, ?)",
      );
      insert.run(
        "msg_current",
        "ses_current",
        "assistant",
        3000,
        JSON.stringify({
          agent: "build",
          model: { providerID: "anthropic", id: "claude-sonnet-4-5" },
          tokens: { input: 20, output: 4, reasoning: 6, cache: { read: 8, write: 10 } },
          cost: 0.5,
          content: [{ type: "text", text: "must never be selected" }],
        }),
      );
      insert.run("msg_user", "ses_current", "user", 3001, JSON.stringify({ text: "not usage" }));
      database.close();
      database = undefined;

      const result = await readOpenCodeUsage(databasePath, 2500);

      expect(result).toEqual({
        malformedRecords: 0,
        records: [
          {
            provider: "opencode",
            timestampMs: 3000,
            model: "anthropic/claude-sonnet-4-5",
            sessionId: "ses_current",
            totals: {
              uncachedInputTokens: 20,
              cachedInputTokens: 8,
              cacheCreationTokens: 10,
              outputTokens: 10,
              reasoningTokens: 6,
            },
            reportedCostUsd: 0.5,
            dedupeKey: "opencode:msg_current",
          },
        ],
      });
    } finally {
      database?.close();
      await NodeFSP.rm(directory, { recursive: true, force: true });
    }
  });

  it("reads both projections and deduplicates message IDs", async () => {
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-opencode-usage-"));
    const databasePath = NodePath.join(directory, "opencode.db");
    let database: NodeSqlite.DatabaseSync | undefined;
    try {
      database = new NodeSqlite.DatabaseSync(databasePath);
      database.exec(`
        CREATE TABLE message (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          time_created INTEGER NOT NULL,
          data TEXT NOT NULL
        );
        CREATE TABLE session_message (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          type TEXT NOT NULL,
          time_created INTEGER NOT NULL,
          data TEXT NOT NULL
        );
      `);
      const insertLegacy = database.prepare(
        "INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)",
      );
      const insertCurrent = database.prepare(
        "INSERT INTO session_message (id, session_id, type, time_created, data) VALUES (?, ?, ?, ?, ?)",
      );
      insertLegacy.run(
        "msg_shared",
        "ses_shared",
        4000,
        JSON.stringify({
          role: "assistant",
          providerID: "legacy-provider",
          modelID: "legacy-model",
          tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
          cost: 1,
        }),
      );
      insertLegacy.run(
        "msg_legacy",
        "ses_legacy",
        4001,
        JSON.stringify({
          role: "assistant",
          providerID: "openai",
          modelID: "gpt-5",
          tokens: { input: 2, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
          cost: 0.1,
        }),
      );
      insertCurrent.run(
        "msg_shared",
        "ses_shared",
        "assistant",
        4000,
        JSON.stringify({
          model: { providerID: "current-provider", id: "current-model" },
          tokens: { input: 3, output: 2, reasoning: 1, cache: { read: 0, write: 0 } },
          cost: 2,
        }),
      );
      insertCurrent.run(
        "msg_current",
        "ses_current",
        "assistant",
        4002,
        JSON.stringify({
          model: { providerID: "anthropic", id: "claude-sonnet-4-5" },
          tokens: { input: 4, output: 2, reasoning: 0, cache: { read: 0, write: 0 } },
          cost: 0.2,
        }),
      );
      database.close();
      database = undefined;

      const result = await readOpenCodeUsage(databasePath, 3500);

      expect(result?.malformedRecords).toBe(0);
      expect(result?.records).toHaveLength(3);
      expect(result?.records.map((record) => record.model).sort()).toEqual([
        "anthropic/claude-sonnet-4-5",
        "current-provider/current-model",
        "openai/gpt-5",
      ]);
      expect(
        result?.records.find((record) => record.dedupeKey === "opencode:msg_shared"),
      ).toMatchObject({
        model: "current-provider/current-model",
        reportedCostUsd: 2,
      });
    } finally {
      database?.close();
      await NodeFSP.rm(directory, { recursive: true, force: true });
    }
  });
});
