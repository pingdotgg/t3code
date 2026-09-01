// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import { afterEach, describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  parseOpenCodeUsageRow,
  readOpenCodeUsage,
  resolveOpenCodeDatabasePaths,
} from "./usageOpenCode.ts";

const temporaryDirectories: string[] = [];
const encodeUnknownJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => NodeFSP.rm(directory, { recursive: true, force: true })),
  );
});

function projectedRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    messageId: "message-1",
    sessionId: "session-1",
    timestampMs: 1_800_000_000_000,
    providerId: "anthropic",
    modelId: "claude-sonnet-4-5",
    inputTokens: 10,
    outputTokens: 20,
    reasoningTokens: 5,
    cacheReadTokens: 30,
    cacheWriteTokens: 40,
    costUsd: 0.123,
    ...overrides,
  };
}

describe("parseOpenCodeUsageRow", () => {
  it("normalises OpenCode's disjoint reasoning tokens and qualifies the model", () => {
    const record = parseOpenCodeUsageRow(projectedRow());

    expect(record).toMatchObject({
      provider: "opencode",
      model: "anthropic/claude-sonnet-4-5",
      reportedCostUsd: 0.123,
      dedupeKey: "opencode:message-1",
      totals: {
        uncachedInputTokens: 10,
        cachedInputTokens: 30,
        cacheCreationTokens: 40,
        outputTokens: 25,
        reasoningTokens: 5,
      },
    });
  });

  it("lets shared model pricing estimate subscription-backed zero-cost rows", () => {
    expect(parseOpenCodeUsageRow(projectedRow({ costUsd: 0 }))?.reportedCostUsd).toBeNull();
  });

  it("skips placeholders and malformed projections", () => {
    expect(
      parseOpenCodeUsageRow(
        projectedRow({
          inputTokens: 0,
          outputTokens: 0,
          reasoningTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        }),
      ),
    ).toBeNull();
    expect(parseOpenCodeUsageRow({ messageId: "missing-everything-else" })).toBeNull();
  });
});

describe("resolveOpenCodeDatabasePaths", () => {
  const resolve = (overrides: Partial<Parameters<typeof resolveOpenCodeDatabasePaths>[0]> = {}) =>
    resolveOpenCodeDatabasePaths({
      dataDirectory: "/data/opencode",
      databaseOverride: undefined,
      disableChannelDatabase: undefined,
      directoryEntries: [],
      path: NodePath,
      ...overrides,
    });

  it("honours absolute, relative, and in-memory database overrides", () => {
    expect(resolve({ databaseOverride: "/custom/usage.db" })).toEqual(["/custom/usage.db"]);
    expect(resolve({ databaseOverride: "custom.db" })).toEqual(["/data/opencode/custom.db"]);
    expect(resolve({ databaseOverride: ":memory:" })).toEqual([]);
  });

  it("discovers stable and channel databases without unrelated files", () => {
    expect(
      resolve({
        directoryEntries: ["opencode-beta.db", "README.md", "opencode.db", "opencode-beta.db"],
      }),
    ).toEqual(["/data/opencode/opencode-beta.db", "/data/opencode/opencode.db"]);
  });

  it("uses only the stable path when channel databases are disabled", () => {
    expect(
      resolve({
        disableChannelDatabase: "true",
        directoryEntries: ["opencode-beta.db"],
      }),
    ).toEqual(["/data/opencode/opencode.db"]);
  });
});

describe("readOpenCodeUsage", () => {
  it("reads current and legacy tables, preferring the current copy of a message", async () => {
    const temporaryDirectory = await NodeFSP.mkdtemp(
      NodePath.join(NodeOS.tmpdir(), "t3-opencode-usage-"),
    );
    temporaryDirectories.push(temporaryDirectory);
    const databasePath = NodePath.join(temporaryDirectory, "opencode.db");
    const database = new NodeSqlite.DatabaseSync(databasePath);
    database.exec(`
      CREATE TABLE message (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        time_updated INTEGER NOT NULL,
        data TEXT NOT NULL
      );
      CREATE TABLE session_message (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        type TEXT NOT NULL,
        time_updated INTEGER NOT NULL,
        data TEXT NOT NULL
      );
    `);

    const sinceMs = 1_800_000_000_000;
    const insertLegacy = database.prepare("INSERT INTO message VALUES (?, ?, ?, ?)");
    const insertCurrent = database.prepare("INSERT INTO session_message VALUES (?, ?, ?, ?, ?)");
    insertCurrent.run(
      "shared-message",
      "current-session",
      "assistant",
      sinceMs + 100,
      encodeUnknownJson({
        time: { completed: sinceMs + 100 },
        model: { providerID: "anthropic", id: "claude-sonnet-4-5" },
        tokens: {
          input: 10,
          output: 20,
          reasoning: 5,
          cache: { read: 30, write: 40 },
        },
        cost: 0.123,
        parts: [{ type: "text", text: "must remain inside SQLite" }],
      }),
    );
    insertCurrent.run(
      "placeholder",
      "current-session",
      "assistant",
      sinceMs + 110,
      encodeUnknownJson({
        time: { completed: sinceMs + 110 },
        model: { providerID: "anthropic", id: "claude-sonnet-4-5" },
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        cost: 0,
      }),
    );
    insertCurrent.run(
      "incomplete",
      "current-session",
      "assistant",
      sinceMs + 120,
      encodeUnknownJson({
        time: { created: sinceMs + 120 },
        model: { providerID: "anthropic", id: "claude-sonnet-4-5" },
        tokens: { input: 100, output: 100, reasoning: 0, cache: { read: 0, write: 0 } },
        cost: 1,
      }),
    );
    insertLegacy.run(
      "shared-message",
      "legacy-session",
      sinceMs + 100,
      encodeUnknownJson({
        role: "assistant",
        time: { completed: sinceMs + 100 },
        providerID: "anthropic",
        modelID: "claude-sonnet-4-5",
        tokens: { input: 999, output: 999, reasoning: 0, cache: { read: 0, write: 0 } },
        cost: 99,
      }),
    );
    insertLegacy.run(
      "legacy-message",
      "legacy-session",
      sinceMs + 200,
      encodeUnknownJson({
        role: "assistant",
        time: { completed: sinceMs + 200 },
        providerID: "openai",
        modelID: "gpt-5.4",
        tokens: { input: 7, output: 8, reasoning: 3, cache: { read: 6, write: 5 } },
        cost: 0,
      }),
    );
    insertLegacy.run(
      "old-message",
      "old-session",
      sinceMs - 1,
      encodeUnknownJson({
        role: "assistant",
        time: { completed: sinceMs - 1 },
        providerID: "openai",
        modelID: "gpt-5.4",
        tokens: { input: 100, output: 100, reasoning: 0, cache: { read: 0, write: 0 } },
      }),
    );
    insertLegacy.run("malformed", "legacy-session", sinceMs + 300, "{");
    database.close();

    const result = await readOpenCodeUsage(databasePath, sinceMs);

    expect(result?.malformedRecords).toBe(1);
    expect(result?.records).toHaveLength(2);
    expect(result?.records.map((record) => record.dedupeKey).sort()).toEqual([
      "opencode:legacy-message",
      "opencode:shared-message",
    ]);
    const current = result?.records.find(
      (record) => record.dedupeKey === "opencode:shared-message",
    );
    const legacy = result?.records.find((record) => record.dedupeKey === "opencode:legacy-message");
    expect(current?.sessionId).toBe("current-session");
    expect(current?.totals.uncachedInputTokens).toBe(10);
    expect(legacy?.model).toBe("openai/gpt-5.4");
    expect(legacy?.reportedCostUsd).toBeNull();
    expect(encodeUnknownJson(result)).not.toContain("must remain inside SQLite");
    expect(await NodeFSP.readdir(temporaryDirectory)).toEqual(["opencode.db"]);
  });

  it("returns null when the database cannot be opened", async () => {
    expect(await readOpenCodeUsage("/definitely/missing/opencode.db", 0)).toBeNull();
  });
});
