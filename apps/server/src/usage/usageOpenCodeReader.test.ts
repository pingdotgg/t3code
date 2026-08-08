// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalDate:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import { describe, expect, it } from "@effect/vitest";

import {
  parseOpenCodeMessageRow,
  readOpenCodeUsage,
  resolveOpenCodeDataDir,
} from "./usageOpenCodeReader.ts";

function assistantMessage(overrides: Record<string, unknown> = {}) {
  return {
    id: "msg_1",
    sessionID: "ses_1",
    role: "assistant",
    modelID: "deepseek-v4-flash-free",
    providerID: "opencode",
    time: { created: 1_786_211_758_317, completed: 1_786_211_767_010 },
    cost: 0,
    tokens: {
      input: 137,
      output: 851,
      reasoning: 230,
      cache: { read: 99_200, write: 12 },
    },
    ...overrides,
  };
}

describe("parseOpenCodeMessageRow", () => {
  it("maps OpenCode assistant usage without counting cache or reasoning twice", () => {
    const record = parseOpenCodeMessageRow({
      id: "msg_1",
      sessionId: "ses_1",
      timeCreated: 1_786_211_758_317,
      data: JSON.stringify(assistantMessage()),
    });

    expect(record).toEqual({
      provider: "opencode",
      timestampMs: 1_786_211_767_010,
      model: "deepseek-v4-flash-free",
      sessionId: "ses_1",
      totals: {
        uncachedInputTokens: 137,
        cachedInputTokens: 99_200,
        cacheCreationTokens: 12,
        outputTokens: 851,
        reasoningTokens: 230,
      },
      reportedCostUsd: 0,
      dedupeKey: "opencode:msg_1",
    });
  });

  it("ignores non-assistant, malformed, zero-token, and model-less rows", () => {
    const row = (data: unknown) => ({
      id: "msg_1",
      sessionId: "ses_1",
      timeCreated: 1_786_211_758_317,
      data,
    });

    expect(parseOpenCodeMessageRow(row("not json"))).toBeNull();
    expect(
      parseOpenCodeMessageRow(row(JSON.stringify(assistantMessage({ role: "user" })))),
    ).toBeNull();
    expect(
      parseOpenCodeMessageRow(
        row(JSON.stringify(assistantMessage({ tokens: { input: 0, output: 0 } }))),
      ),
    ).toBeNull();
    expect(
      parseOpenCodeMessageRow(row(JSON.stringify(assistantMessage({ modelID: "" })))),
    ).toBeNull();
  });
});

describe("resolveOpenCodeDataDir", () => {
  it("uses XDG_DATA_HOME when configured and the documented default otherwise", () => {
    expect(resolveOpenCodeDataDir("/home/dev", "/mnt/data")).toBe(
      NodePath.join("/mnt/data", "opencode"),
    );
    expect(resolveOpenCodeDataDir("/home/dev", undefined)).toBe(
      NodePath.join("/home/dev", ".local", "share", "opencode"),
    );
  });
});

describe("readOpenCodeUsage", () => {
  it("reads current OpenCode SQLite messages and excludes older rows", async () => {
    const dataDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-opencode-usage-"));
    const databasePath = NodePath.join(dataDir, "opencode.db");
    const database = new NodeSqlite.DatabaseSync(databasePath);
    database.exec(
      "CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT)",
    );
    const insert = database.prepare(
      "INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)",
    );
    insert.run("msg_old", "ses_old", 100, JSON.stringify(assistantMessage()));
    insert.run(
      "msg_new",
      "ses_new",
      2_000,
      JSON.stringify(
        assistantMessage({
          id: "msg_new",
          sessionID: "ses_new",
          time: { created: 2_000, completed: 2_500 },
        }),
      ),
    );
    database.close();

    try {
      const result = await readOpenCodeUsage(dataDir, 1_000);
      expect(result?.storageKind).toBe("sqlite");
      expect(result?.scannedFiles).toBe(1);
      expect(result?.records.map((record) => record.sessionId)).toEqual(["ses_new"]);
    } finally {
      NodeFS.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("falls back to the documented JSON message store when no database exists", async () => {
    const dataDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-opencode-usage-"));
    const messageDir = NodePath.join(dataDir, "storage", "message", "ses_legacy");
    const now = Date.now();
    NodeFS.mkdirSync(messageDir, { recursive: true });
    NodeFS.writeFileSync(
      NodePath.join(messageDir, "msg_legacy.json"),
      JSON.stringify(
        assistantMessage({
          id: "msg_legacy",
          sessionID: "ses_legacy",
          time: { created: now, completed: now },
        }),
      ),
    );

    try {
      const result = await readOpenCodeUsage(dataDir, now - 60_000);
      expect(result?.storageKind).toBe("json");
      expect(result?.records.map((record) => record.sessionId)).toEqual(["ses_legacy"]);
    } finally {
      NodeFS.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
