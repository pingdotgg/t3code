// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import { describe, expect, it } from "@effect/vitest";

import {
  listOpenCodeDatabaseFiles,
  parseOpenCodeAssistantData,
  readOpenCodeDatabaseRecords,
  resolveOpenCodeDataDir,
} from "./usageOpenCode.ts";

describe("resolveOpenCodeDataDir", () => {
  it("defaults under ~/.local/share/opencode", () => {
    expect(resolveOpenCodeDataDir({})).toBe(
      NodePath.join(NodeOS.homedir(), ".local", "share", "opencode"),
    );
  });

  it("honours XDG_DATA_HOME", () => {
    expect(resolveOpenCodeDataDir({ XDG_DATA_HOME: "/tmp/xdg-data" })).toBe(
      NodePath.resolve("/tmp/xdg-data", "opencode"),
    );
  });
});

describe("parseOpenCodeAssistantData", () => {
  it("parses legacy message.data tokens as Claude-shaped input", () => {
    const record = parseOpenCodeAssistantData(
      {
        role: "assistant",
        modelID: "gpt-5.4",
        providerID: "openai",
        cost: 0.12,
        tokens: {
          total: 16517,
          input: 5700,
          output: 705,
          reasoning: 195,
          cache: { write: 0, read: 10112 },
        },
        time: { created: 1_775_407_280_527, completed: 1_775_407_294_619 },
      },
      { messageId: "msg_1", sessionId: "ses_1", columnTimeMs: 1_775_407_280_527 },
    );

    expect(record).not.toBeNull();
    expect(record?.provider).toBe("opencode");
    expect(record?.model).toBe("gpt-5.4");
    expect(record?.reportedCostUsd).toBeCloseTo(0.12, 9);
    expect(record?.totals).toEqual({
      uncachedInputTokens: 5700,
      cachedInputTokens: 10112,
      cacheCreationTokens: 0,
      outputTokens: 705,
      reasoningTokens: 195,
    });
    expect(record?.dedupeKey).toBe("opencode:msg_1");
  });

  it("parses next-schema session_message payloads", () => {
    const record = parseOpenCodeAssistantData(
      {
        model: { id: "gpt-5.6-luna", providerID: "openai", variant: "medium" },
        cost: 0,
        tokens: {
          input: 4356,
          output: 20,
          reasoning: 16,
          cache: { read: 100, write: 50 },
        },
        time: { created: 1_785_786_225_026 },
      },
      { messageId: "msg_next", sessionId: "ses_next", columnTimeMs: null },
    );

    expect(record?.model).toBe("gpt-5.6-luna");
    expect(record?.reportedCostUsd).toBeNull();
    expect(record?.totals.cacheCreationTokens).toBe(50);
    expect(record?.totals.cachedInputTokens).toBe(100);
  });

  it("ignores non-assistant legacy rows", () => {
    expect(
      parseOpenCodeAssistantData(
        { role: "user", tokens: { input: 1, output: 1 } },
        { messageId: "u", sessionId: "s", columnTimeMs: 1 },
      ),
    ).toBeNull();
  });
});

describe("readOpenCodeDatabaseRecords", () => {
  it("reads assistant rows from both legacy and next tables", async () => {
    const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-opencode-usage-"));
    const dbPath = NodePath.join(dir, "opencode.db");
    const database = new NodeSqlite.DatabaseSync(dbPath);
    database.exec(`
      CREATE TABLE message (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        time_created INTEGER,
        time_updated INTEGER,
        data TEXT NOT NULL
      );
      CREATE TABLE session_message (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        type TEXT NOT NULL,
        time_created INTEGER,
        time_updated INTEGER,
        data TEXT NOT NULL,
        seq INTEGER
      );
    `);
    database
      .prepare(
        `INSERT INTO message (id, session_id, time_created, time_updated, data)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        "legacy_1",
        "ses_legacy",
        1_800_000_000_000,
        1_800_000_000_000,
        JSON.stringify({
          role: "assistant",
          modelID: "gpt-5.4",
          cost: 0,
          tokens: {
            input: 10,
            output: 5,
            reasoning: 1,
            cache: { read: 2, write: 0 },
          },
          time: { created: 1_800_000_000_000 },
        }),
      );
    database
      .prepare(
        `INSERT INTO session_message (id, session_id, type, time_created, time_updated, data, seq)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "next_1",
        "ses_next",
        "assistant",
        1_800_000_100_000,
        1_800_000_100_000,
        JSON.stringify({
          model: { id: "gpt-5.6-sol", providerID: "openai" },
          cost: 1.5,
          tokens: {
            input: 20,
            output: 8,
            reasoning: 2,
            cache: { read: 0, write: 0 },
          },
          time: { created: 1_800_000_100_000 },
        }),
        1,
      );
    database.close();

    const records = await readOpenCodeDatabaseRecords(dbPath, 0);
    expect(records).not.toBeNull();
    expect(records?.map((record) => record.model).sort()).toEqual(["gpt-5.4", "gpt-5.6-sol"]);
    expect(records?.find((record) => record.model === "gpt-5.6-sol")?.reportedCostUsd).toBe(1.5);

    const databaseStats = await NodeFSP.stat(dbPath);
    const walPath = `${dbPath}-wal`;
    await NodeFSP.writeFile(walPath, "new OpenCode writes");
    const walTimeMs = databaseStats.mtimeMs + 10_000;
    await NodeFSP.utimes(walPath, walTimeMs / 1000, walTimeMs / 1000);

    const listed = await listOpenCodeDatabaseFiles(dir);
    expect(listed.map((file) => NodePath.basename(file.path))).toEqual(["opencode.db"]);
    expect(listed[0]?.size).toBe(databaseStats.size + Buffer.byteLength("new OpenCode writes"));
    expect(listed[0]?.mtimeMs).toBeCloseTo(walTimeMs, -2);

    await NodeFSP.rm(dir, { recursive: true, force: true });
  });
});
