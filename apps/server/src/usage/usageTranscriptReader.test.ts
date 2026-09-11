// @effect-diagnostics nodeBuiltinImport:off globalDate:off - resume coverage writes, appends
// to, and truncates real transcript files byte-exactly, mirroring the reader's
// own deliberate node:fs usage.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import { afterEach, assert, beforeEach, describe, expect, it } from "@effect/vitest";

import {
  listTranscriptFiles,
  readAntigravityDbRecords,
  readCopilotDbRecords,
  readTranscriptRecords,
} from "./usageTranscriptReader.ts";

let dir: string;

beforeEach(async () => {
  dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "usage-reader-test-"));
});

afterEach(async () => {
  await NodeFSP.rm(dir, { recursive: true, force: true });
});

function claudeLine(id: number, outputTokens: number): string {
  return `${JSON.stringify({
    type: "assistant",
    timestamp: "2026-08-01T10:00:00Z",
    requestId: `req_${id}`,
    sessionId: "session-1",
    message: {
      id: `msg_${id}`,
      model: "claude-fable-5",
      usage: { input_tokens: 10, output_tokens: outputTokens },
    },
  })}\n`;
}

function codexMetaLine(): string {
  return `${JSON.stringify({
    type: "session_meta",
    timestamp: "2026-08-01T10:00:00Z",
    payload: { type: "session_meta", id: "codex-session-1" },
  })}\n`;
}

function codexModelLine(model: string): string {
  return `${JSON.stringify({
    type: "turn_context",
    timestamp: "2026-08-01T10:00:01Z",
    payload: { type: "turn_context", model },
  })}\n`;
}

function codexUsageLine(outputTokens: number, secondsOffset: number): string {
  return `${JSON.stringify({
    type: "event_msg",
    timestamp: `2026-08-01T10:00:${String(secondsOffset).padStart(2, "0")}Z`,
    payload: {
      type: "token_count",
      info: { last_token_usage: { input_tokens: 100, output_tokens: outputTokens } },
    },
  })}\n`;
}

describe("readTranscriptRecords resume", () => {
  it("parses only appended lines when resuming a grown file", async () => {
    const path = NodePath.join(dir, "claude.jsonl");
    await NodeFSP.writeFile(path, claudeLine(1, 5) + claudeLine(2, 7));
    const first = await readTranscriptRecords(path, "claude");
    assert.isNotNull(first);
    assert.strictEqual(first.records.length, 2);
    assert.isFalse(first.resumed);

    await NodeFSP.appendFile(path, claudeLine(3, 11));
    const second = await readTranscriptRecords(path, "claude", first.position);
    assert.isNotNull(second);
    assert.isTrue(second.resumed);
    assert.strictEqual(second.records.length, 1);
    assert.strictEqual(second.records[0]?.totals.outputTokens, 11);

    // The stitched result matches a from-scratch parse of the whole file.
    const full = await readTranscriptRecords(path, "claude");
    assert.isNotNull(full);
    assert.deepStrictEqual([...first.records, ...second.records], [...full.records]);
  });

  it("carries the Codex reducer state across the resume boundary", async () => {
    const path = NodePath.join(dir, "rollout.jsonl");
    await NodeFSP.writeFile(path, codexMetaLine() + codexModelLine("gpt-5.2-codex"));
    const first = await readTranscriptRecords(path, "codex");
    assert.isNotNull(first);
    assert.strictEqual(first.records.length, 0);

    // The appended usage event has no turn_context or session_meta of its own;
    // model and session must come from the state captured before the boundary.
    await NodeFSP.appendFile(path, codexUsageLine(9, 5));
    const second = await readTranscriptRecords(path, "codex", first.position);
    assert.isNotNull(second);
    assert.isTrue(second.resumed);
    assert.strictEqual(second.records.length, 1);
    assert.strictEqual(second.records[0]?.model, "gpt-5.2-codex");
    assert.strictEqual(second.records[0]?.sessionId, "codex-session-1");
  });

  it("suppresses a Codex duplicate usage event that straddles the boundary", async () => {
    const path = NodePath.join(dir, "rollout.jsonl");
    await NodeFSP.writeFile(
      path,
      codexMetaLine() + codexModelLine("gpt-5.2-codex") + codexUsageLine(9, 5),
    );
    const first = await readTranscriptRecords(path, "codex");
    assert.isNotNull(first);
    assert.strictEqual(first.records.length, 1);

    // Codex re-emits an unchanged token_count on stream boundaries; the copy
    // lands after the resume point and must still be dropped.
    await NodeFSP.appendFile(path, codexUsageLine(9, 5) + codexUsageLine(21, 8));
    const second = await readTranscriptRecords(path, "codex", first.position);
    assert.isNotNull(second);
    assert.isTrue(second.resumed);
    assert.deepStrictEqual(
      second.records.map((record) => record.totals.outputTokens),
      [21],
    );
  });

  it("defers an unterminated trailing line to tailRecords, then consumes it once terminated", async () => {
    const path = NodePath.join(dir, "claude.jsonl");
    const unterminated = claudeLine(2, 7).trimEnd();
    await NodeFSP.writeFile(path, claudeLine(1, 5) + unterminated);
    const first = await readTranscriptRecords(path, "claude");
    assert.isNotNull(first);
    assert.strictEqual(first.records.length, 1);
    assert.strictEqual(first.tailRecords.length, 1);
    assert.strictEqual(first.tailRecords[0]?.totals.outputTokens, 7);

    // Completing the line and appending another re-reads from the resume
    // point, so the once-tail record arrives exactly once as a line record.
    await NodeFSP.appendFile(path, `\n${claudeLine(3, 11)}`);
    const second = await readTranscriptRecords(path, "claude", first.position);
    assert.isNotNull(second);
    assert.isTrue(second.resumed);
    assert.deepStrictEqual(
      second.records.map((record) => record.totals.outputTokens),
      [7, 11],
    );
    assert.strictEqual(second.tailRecords.length, 0);
  });

  it("re-parses from the start when the guard bytes no longer match", async () => {
    const path = NodePath.join(dir, "claude.jsonl");
    await NodeFSP.writeFile(path, claudeLine(1, 5));
    const first = await readTranscriptRecords(path, "claude");
    assert.isNotNull(first);

    // Same path, larger size, different content: a replaced file, not growth.
    await NodeFSP.writeFile(path, claudeLine(4, 13) + claudeLine(5, 17));
    const second = await readTranscriptRecords(path, "claude", first.position);
    assert.isNotNull(second);
    assert.isFalse(second.resumed);
    assert.deepStrictEqual(
      second.records.map((record) => record.totals.outputTokens),
      [13, 17],
    );
  });

  it("re-parses from the start when the file shrank below the resume point", async () => {
    const path = NodePath.join(dir, "claude.jsonl");
    await NodeFSP.writeFile(path, claudeLine(1, 5) + claudeLine(2, 7));
    const first = await readTranscriptRecords(path, "claude");
    assert.isNotNull(first);

    await NodeFSP.writeFile(path, claudeLine(3, 11));
    const second = await readTranscriptRecords(path, "claude", first.position);
    assert.isNotNull(second);
    assert.isFalse(second.resumed);
    assert.deepStrictEqual(
      second.records.map((record) => record.totals.outputTokens),
      [11],
    );
  });

  it("parses a line larger than one stream chunk", async () => {
    // Tool-heavy transcripts carry multi-megabyte single lines; they arrive
    // split across many chunks and must reassemble into one record.
    const path = NodePath.join(dir, "claude.jsonl");
    const bigLine = `${JSON.stringify({
      type: "assistant",
      timestamp: "2026-08-01T10:00:00Z",
      requestId: "req_big",
      sessionId: "session-1",
      padding: "x".repeat(512 * 1024),
      message: {
        id: "msg_big",
        model: "claude-fable-5",
        usage: { input_tokens: 10, output_tokens: 42 },
      },
    })}\n`;
    await NodeFSP.writeFile(path, bigLine + claudeLine(2, 7));

    const parsed = await readTranscriptRecords(path, "claude");
    assert.isNotNull(parsed);
    assert.deepStrictEqual(
      parsed.records.map((record) => record.totals.outputTokens),
      [42, 7],
    );
  });

  it("returns null for an unreadable file", async () => {
    assert.isNull(await readTranscriptRecords(NodePath.join(dir, "missing.jsonl"), "claude"));
  });
});

describe("readCopilotDbRecords", () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(async () => {
    tempDir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "copilot-usage-test-"));
    dbPath = NodePath.join(tempDir, "session-store.db");
  });

  afterEach(async () => {
    await NodeFSP.rm(tempDir, { recursive: true, force: true });
  });

  it("reads and maps assistant_usage_events records accurately", () => {
    const db = new NodeSqlite.DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE assistant_usage_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        turn_index INTEGER NOT NULL,
        model TEXT NOT NULL,
        input_tokens INTEGER NOT NULL,
        output_tokens INTEGER NOT NULL,
        cache_read_tokens INTEGER NOT NULL,
        cache_write_tokens INTEGER NOT NULL,
        reasoning_tokens INTEGER NOT NULL,
        total_nano_aiu INTEGER NOT NULL,
        token_details_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);

    db.exec(`
      INSERT INTO assistant_usage_events (
        session_id, turn_index, model, input_tokens, output_tokens,
        cache_read_tokens, cache_write_tokens, reasoning_tokens,
        total_nano_aiu, token_details_json, created_at
      ) VALUES (
        'sess-abc-123', 0, 'gpt-5.4-mini', 1200, 150,
        800, 100, 45,
        15000, '[]', '2026-09-10T14:22:18.431Z'
      );
    `);
    db.close();

    const records = readCopilotDbRecords(dbPath);
    expect(records).not.toBeNull();
    expect(records).toHaveLength(1);

    const first = records?.[0];
    expect(first).toBeDefined();
    if (!first) throw new Error("expected record");

    expect(first.provider).toBe("copilot");
    expect(first.model).toBe("gpt-5.4-mini");
    expect(first.sessionId).toBe("sess-abc-123");
    expect(first.dedupeKey).toBe("copilot:sess-abc-123:1");
    expect(first.totals).toEqual({
      uncachedInputTokens: 300, // 1200 - 800 - 100
      cachedInputTokens: 800,
      cacheCreationTokens: 100,
      outputTokens: 150,
      reasoningTokens: 45,
    });
    expect(first.timestampMs).toBe(Date.parse("2026-09-10T14:22:18.431Z"));
  });

  it("returns null when database cannot be opened or table does not exist", () => {
    const records = readCopilotDbRecords("/nonexistent/path/session-store.db");
    expect(records).toBeNull();
  });

  it("accounts for SQLite WAL file mtime and size in listTranscriptFiles", async () => {
    // Write an older session-store.db
    await NodeFSP.writeFile(dbPath, "dummy-db");
    const oldTime = new Date(Date.now() - 100_000);
    await NodeFSP.utimes(dbPath, oldTime, oldTime);

    // Create a newer WAL file
    const walPath = `${dbPath}-wal`;
    await NodeFSP.writeFile(walPath, "wal-content-1234");
    const newTime = new Date();
    await NodeFSP.utimes(walPath, newTime, newTime);

    const sinceMs = Date.now() - 50_000;
    const files = await listTranscriptFiles(tempDir, sinceMs, { provider: "copilot" });

    expect(files).toHaveLength(1);
    expect(files[0]?.path).toBe(dbPath);
    expect(Math.round(files[0]?.mtimeMs ?? 0)).toBe(newTime.getTime());
    expect(files[0]?.size).toBe("dummy-db".length + "wal-content-1234".length);

    // When both are older than sinceMs
    const futureSinceMs = Date.now() + 100_000;
    const emptyFiles = await listTranscriptFiles(tempDir, futureSinceMs, { provider: "copilot" });
    expect(emptyFiles).toHaveLength(0);
  });
});

describe("readAntigravityDbRecords", () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(async () => {
    tempDir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "antigravity-usage-test-"));
    dbPath = NodePath.join(tempDir, "conv-123.db");
  });

  afterEach(async () => {
    await NodeFSP.rm(tempDir, { recursive: true, force: true });
  });

  function makeMockProto(): Buffer {
    function encodeVarint(val: number): Buffer {
      const bytes: number[] = [];
      while (val > 127) {
        bytes.push((val & 0x7f) | 0x80);
        val >>>= 7;
      }
      bytes.push(val);
      return Buffer.from(bytes);
    }
    function encodeTag(tag: number, wire: number): Buffer {
      return encodeVarint((tag << 3) | wire);
    }
    function encodeLengthDelimited(tag: number, payload: Buffer | string): Buffer {
      const buf = typeof payload === "string" ? Buffer.from(payload) : payload;
      return Buffer.concat([encodeTag(tag, 2), encodeVarint(buf.length), buf]);
    }
    function encodeVarintField(tag: number, val: number): Buffer {
      return Buffer.concat([encodeTag(tag, 0), encodeVarint(val)]);
    }

    const timingInner = encodeVarintField(1, 1789046800);
    const timingOuter = encodeLengthDelimited(4, timingInner);
    const timingField = encodeLengthDelimited(9, timingOuter);

    const tokensBuf = Buffer.concat([
      encodeVarintField(2, 1000),
      encodeVarintField(3, 200),
      encodeVarintField(9, 150),
    ]);
    const tokensField = encodeLengthDelimited(4, tokensBuf);
    const modelField = encodeLengthDelimited(19, "gemini-3.8-flash");
    const rootSubmessage = Buffer.concat([modelField, tokensField, timingField]);
    return encodeLengthDelimited(1, rootSubmessage);
  }

  it("reads and maps gen_metadata records accurately", () => {
    const db = new NodeSqlite.DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE gen_metadata (
        idx INTEGER PRIMARY KEY,
        data BLOB NOT NULL,
        size INTEGER NOT NULL
      );
    `);

    const proto = makeMockProto();
    const insert = db.prepare("INSERT INTO gen_metadata (idx, data, size) VALUES (?, ?, ?)");
    insert.run(0, proto, proto.length);
    db.close();

    const records = readAntigravityDbRecords(dbPath);
    expect(records).not.toBeNull();
    expect(records).toHaveLength(1);

    const first = records?.[0];
    expect(first).toBeDefined();
    if (!first) throw new Error("expected record");

    expect(first.provider).toBe("antigravity");
    expect(first.model).toBe("gemini-3.8-flash");
    expect(first.sessionId).toBe("conv-123");
    expect(first.dedupeKey).toBe("antigravity:conv-123:0");
    expect(first.totals).toEqual({
      uncachedInputTokens: 850,
      cachedInputTokens: 150,
      cacheCreationTokens: 0,
      outputTokens: 200,
      reasoningTokens: 0,
    });
    expect(first.timestampMs).toBe(1789046800 * 1000);
  });

  it("accounts for SQLite WAL file in listTranscriptFiles for antigravity", async () => {
    await NodeFSP.writeFile(dbPath, "dummy-db");
    const oldTime = new Date(Date.now() - 100_000);
    await NodeFSP.utimes(dbPath, oldTime, oldTime);

    const walPath = `${dbPath}-wal`;
    await NodeFSP.writeFile(walPath, "wal-bytes");
    const newTime = new Date();
    await NodeFSP.utimes(walPath, newTime, newTime);

    const sinceMs = Date.now() - 50_000;
    const files = await listTranscriptFiles(tempDir, sinceMs, { provider: "antigravity" });

    expect(files).toHaveLength(1);
    expect(files[0]?.path).toBe(dbPath);
    expect(Math.round(files[0]?.mtimeMs ?? 0)).toBe(newTime.getTime());
    expect(files[0]?.size).toBe("dummy-db".length + "wal-bytes".length);
  });
});
