// @effect-diagnostics nodeBuiltinImport:off - resume coverage writes, appends
// to, and truncates real transcript files byte-exactly, mirroring the reader's
// own deliberate node:fs usage.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import { afterEach, assert, beforeEach, describe, it } from "@effect/vitest";

import { readTranscriptRecords } from "./usageTranscriptReader.ts";
import { readOpenCodeUsage } from "./opencodeUsageReader.ts";
import { readCursorAccountUsage } from "./cursorUsageReader.ts";
import { readAntigravityUsage } from "./antigravityUsageReader.ts";

let dir: string;

function protoNumber(field: number, value: number): number[] {
  const varint = (number: number) => {
    const bytes: number[] = [];
    do {
      const byte = number % 128;
      number = Math.floor(number / 128);
      bytes.push(byte + (number > 0 ? 128 : 0));
    } while (number > 0);
    return bytes;
  };
  return [...varint(field * 8), ...varint(value)];
}

function protoBytes(field: number, bytes: readonly number[]): number[] {
  const encoded = protoNumber(field, bytes.length);
  encoded[0] = encoded[0]! + 2;
  return [...encoded, ...bytes];
}

function protoText(field: number, value: string): number[] {
  return protoBytes(field, [...Buffer.from(value)]);
}

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

describe("SQLite usage readers", () => {
  it("reads paginated Cursor account history including headless calls with separate cache tokens", async () => {
    const authPath = NodePath.join(dir, "auth.json");
    const accessToken = `header.${Buffer.from(JSON.stringify({ sub: "auth|demo", exp: 4102444800 })).toString("base64url")}.signature`;
    await NodeFSP.writeFile(authPath, JSON.stringify({ accessToken }));
    const pages: number[] = [];
    const request = async (url: string, init: RequestInit) => {
      assert.strictEqual(String(url), "https://cursor.com/api/dashboard/get-filtered-usage-events");
      assert.strictEqual(init?.redirect, "error");
      const headers = new Headers(init?.headers);
      assert.strictEqual(headers.get("origin"), "https://cursor.com");
      assert.include(headers.get("cookie") ?? "", "WorkosCursorSessionToken=demo%3A%3A");
      const body = JSON.parse(String(init?.body));
      pages.push(body.page);
      return Response.json({
        totalUsageEventsCount: 1001,
        usageEventsDisplay: Array.from({ length: body.page === 1 ? 1000 : 1 }, (_, index) => ({
          timestamp: String(1780000000000 + ((body.page - 1) * 1000 + index) * 1000),
          model: "claude-sonnet-4-5",
          conversationId: `conversation-${body.page}`,
          isHeadless: body.page === 2,
          chargedCents: 0,
          tokenUsage: {
            inputTokens: 10,
            outputTokens: 5,
            cacheReadTokens: 30,
            cacheWriteTokens: 2,
            totalCents: 25,
          },
        })),
      });
    };
    const result = await readCursorAccountUsage(authPath, 0, 1781000000000, request);
    assert.isNull(result.error);
    assert.deepStrictEqual(pages, [1, 2]);
    assert.strictEqual(result.records.length, 1001);
    assert.strictEqual(result.records.at(-1)?.sessionId, "conversation-2");
    assert.deepStrictEqual(result.records[0]?.totals, {
      uncachedInputTokens: 10,
      cachedInputTokens: 30,
      cacheCreationTokens: 2,
      outputTokens: 5,
      reasoningTokens: 0,
    });
    assert.strictEqual(result.records[0]?.reportedCostUsd, 0.25);
    assert.isFalse(result.accountKey?.includes("demo") ?? true);
  });

  it("accepts confirmed empty Cursor usage but rejects error envelopes", async () => {
    const authPath = NodePath.join(dir, "auth.json");
    const accessToken = `header.${Buffer.from(JSON.stringify({ sub: "auth|demo" })).toString("base64url")}.signature`;
    await NodeFSP.writeFile(authPath, JSON.stringify({ accessToken }));
    for (const body of [
      {},
      { totalUsageEventsCount: 0 },
      { totalUsageEventsCount: 0, usageEventsDisplay: [] },
    ]) {
      const result = await readCursorAccountUsage(authPath, 0, 1781000000000, async () =>
        Response.json(body),
      );
      assert.isNull(result.error);
      assert.deepStrictEqual(result.records, []);
      assert.isFalse(result.missing);
    }
    for (const body of [
      { error: "upstream error" },
      { detail: "unknown error envelope" },
      { totalUsageEventsCount: 0, error: "upstream error" },
      null,
      [],
      "invalid",
      0,
    ]) {
      const result = await readCursorAccountUsage(authPath, 0, 1781000000000, async () =>
        Response.json(body),
      );
      assert.isNotNull(result.error);
      assert.deepStrictEqual(result.records, []);
    }
  });

  it("requires a terminal Cursor page after a full page reaches the reported count", async () => {
    const authPath = NodePath.join(dir, "auth.json");
    const accessToken = `header.${Buffer.from(JSON.stringify({ sub: "auth|demo" })).toString("base64url")}.signature`;
    await NodeFSP.writeFile(authPath, JSON.stringify({ accessToken }));
    let requests = 0;
    const result = await readCursorAccountUsage(authPath, 0, 1781000000000, async () => {
      requests++;
      return Response.json(
        requests === 1
          ? {
              totalUsageEventsCount: 1000,
              usageEventsDisplay: Array.from({ length: 1000 }, (_, index) => ({
                timestamp: String(1780000000000 + index),
                model: "gpt-5",
                tokenUsage: { inputTokens: 10, outputTokens: 5 },
              })),
            }
          : { totalUsageEventsCount: 1000 },
      );
    });
    assert.isNull(result.error);
    assert.strictEqual(result.records.length, 1000);
    assert.strictEqual(requests, 2);
  });

  it("removes only count-proven Cursor boundary copies and preserves identical billed events", async () => {
    const authPath = NodePath.join(dir, "auth.json");
    const accessToken = `header.${Buffer.from(JSON.stringify({ sub: "auth|demo" })).toString("base64url")}.signature`;
    await NodeFSP.writeFile(authPath, JSON.stringify({ accessToken }));
    const event = (index: number) => ({
      timestamp: String(1780000000000 + index),
      model: "gpt-5",
      tokenUsage: { inputTokens: 10, outputTokens: 5, totalCents: 1 },
    });
    for (const total of [2000, 2001]) {
      let requests = 0;
      const result = await readCursorAccountUsage(authPath, 0, 1781000000000, async () => {
        requests++;
        return Response.json({
          totalUsageEventsCount: total,
          usageEventsDisplay:
            requests === 1
              ? Array.from({ length: 1000 }, (_, index) => event(index))
              : requests === 2
                ? Array.from({ length: 1000 }, (_, index) => event(999 + index))
                : [event(1999)],
        });
      });
      assert.isNull(result.error);
      assert.strictEqual(result.records.length, total);
      assert.strictEqual(requests, 3);
      assert.strictEqual(result.records.at(-1)?.timestampMs, 1780000001999);
      assert.strictEqual(
        result.records.filter((record) => record.timestampMs === 1780000000999).length,
        total === 2000 ? 1 : 2,
      );
      assert.strictEqual(new Set(result.records.map((record) => record.dedupeKey)).size, total);
    }
    let requests = 0;
    const inconsistent = await readCursorAccountUsage(authPath, 0, 1781000000000, async () => {
      requests++;
      return Response.json({
        totalUsageEventsCount: 1001,
        usageEventsDisplay:
          requests === 1
            ? Array.from({ length: 1000 }, (_, index) => event(index))
            : [event(500), event(1000)],
      });
    });
    assert.isNotNull(inconsistent.error);
    assert.deepStrictEqual(inconsistent.records, []);
  });

  it("does not present truncated Cursor account pages or authentication failures as complete history", async () => {
    const authPath = NodePath.join(dir, "auth.json");
    const accessToken = `header.${Buffer.from(JSON.stringify({ sub: "auth|demo", exp: 4102444800 })).toString("base64url")}.signature`;
    await NodeFSP.writeFile(authPath, JSON.stringify({ accessToken }));
    const truncated = await readCursorAccountUsage(authPath, 0, 1781000000000, async () =>
      Response.json({ totalUsageEventsCount: 101, usageEventsDisplay: [] }),
    );
    assert.isNotNull(truncated.error);
    assert.deepStrictEqual(truncated.records, []);
    const denied = await readCursorAccountUsage(
      authPath,
      0,
      1781000000000,
      async () => new Response(accessToken, { status: 401 }),
    );
    assert.isNotNull(denied.error);
    assert.isFalse(denied.error?.includes(accessToken) ?? true);
    assert.deepStrictEqual(denied.records, []);
    let requested = false;
    const missing = await readCursorAccountUsage(
      NodePath.join(dir, "missing.json"),
      0,
      1781000000000,
      async () => {
        requested = true;
        return Response.json({});
      },
    );
    assert.isTrue(missing.missing);
    assert.isFalse(requested);
  });

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

  it("deduplicates Antigravity generation and step usage while preserving retry model and token buckets", async () => {
    const db = new NodeSqlite.DatabaseSync(NodePath.join(dir, "session-1.db"));
    const stamp = protoNumber(1, 1780000000);
    const usage = [
      ...protoNumber(2, 100),
      ...protoNumber(3, 40),
      ...protoNumber(4, 5),
      ...protoNumber(5, 20),
      ...protoNumber(9, 10),
      ...protoText(11, "response-1"),
    ];
    const retry = [
      ...protoNumber(1, 1026),
      ...protoNumber(2, 12),
      ...protoNumber(3, 3),
      ...protoText(11, "retry-1"),
    ];
    const generation = protoBytes(1, [
      ...protoBytes(4, usage),
      ...protoText(19, "Gemini 3 Pro"),
      ...protoBytes(9, protoBytes(4, stamp)),
    ]);
    const step = [
      ...protoBytes(9, usage),
      ...protoBytes(8, stamp),
      ...protoBytes(28, protoBytes(2, retry)),
    ];
    try {
      db.exec(
        "CREATE TABLE gen_metadata (idx INTEGER, data BLOB); CREATE TABLE steps (idx INTEGER, metadata BLOB)",
      );
      db.prepare("INSERT INTO gen_metadata VALUES (?, ?)").run(0, new Uint8Array(generation));
      db.prepare("INSERT INTO steps VALUES (?, ?)").run(0, new Uint8Array(step));
    } finally {
      db.close();
    }
    const result = await readAntigravityUsage(dir, 0);
    assert.deepStrictEqual(result.errors, []);
    const records = result.files.flatMap((file) => file.records);
    assert.strictEqual(records.length, 2);
    const main = records.find((record) => record.model === "gemini-3-pro");
    assert.isDefined(main);
    assert.strictEqual(main?.timestampMs, 1780000000000);
    assert.strictEqual(main?.sessionId, "session-1");
    assert.deepStrictEqual(main?.totals, {
      uncachedInputTokens: 100,
      cachedInputTokens: 20,
      cacheCreationTokens: 5,
      outputTokens: 40,
      reasoningTokens: 10,
    });
    assert.strictEqual(
      records.find((record) => record.model === "claude-opus-4-6")?.totals.uncachedInputTokens,
      12,
    );
    assert.deepStrictEqual(
      (await readAntigravityUsage(dir, 1780000000001)).files.flatMap((file) => file.records),
      [],
    );
  });

  it("merges Antigravity aliases that bridge previously separate step records", async () => {
    const db = new NodeSqlite.DatabaseSync(NodePath.join(dir, "bridge.db"));
    try {
      db.exec(
        "CREATE TABLE gen_metadata (idx INTEGER, data BLOB); CREATE TABLE steps (idx INTEGER, metadata BLOB)",
      );
      const step = db.prepare("INSERT INTO steps VALUES (?, ?)");
      step.run(
        0,
        new Uint8Array(protoBytes(9, [...protoNumber(2, 100), ...protoText(11, "response")])),
      );
      step.run(
        1,
        new Uint8Array(protoBytes(9, [...protoNumber(3, 40), ...protoText(12, "provider")])),
      );
      db.prepare("INSERT INTO gen_metadata VALUES (?, ?)").run(
        0,
        new Uint8Array(
          protoBytes(1, [
            ...protoText(19, "Gemini 3 Pro"),
            ...protoBytes(4, [
              ...protoNumber(2, 50),
              ...protoNumber(5, 20),
              ...protoText(11, "response"),
              ...protoText(12, "provider"),
            ]),
          ]),
        ),
      );
    } finally {
      db.close();
    }
    const result = await readAntigravityUsage(dir, 0);
    assert.deepStrictEqual(result.errors, []);
    const records = result.files.flatMap((file) => file.records);
    assert.strictEqual(records.length, 1);
    assert.deepStrictEqual(records[0]?.totals, {
      uncachedInputTokens: 100,
      cachedInputTokens: 20,
      cacheCreationTokens: 0,
      outputTokens: 40,
      reasoningTokens: 0,
    });
  });

  it("merges Antigravity provider and message aliases across configured roots while keeping original ownership", async () => {
    const roots = [NodePath.join(dir, "first"), NodePath.join(dir, "second")];
    for (const [index, root] of roots.entries()) {
      await NodeFSP.mkdir(root);
      const db = new NodeSqlite.DatabaseSync(NodePath.join(root, `session-${index}.db`));
      try {
        db.exec("CREATE TABLE steps (idx INTEGER, metadata BLOB)");
        for (const identity of [7, 12]) {
          const usage = [
            ...protoNumber(1, 246),
            ...protoNumber(2, index === 0 ? 100 : 150),
            ...protoText(11, `response-${index}-${identity}`),
            ...protoText(identity, `shared-${identity}`),
          ];
          db.prepare("INSERT INTO steps VALUES (?, ?)").run(
            identity,
            new Uint8Array(protoBytes(9, usage)),
          );
        }
      } finally {
        db.close();
      }
    }
    const result = await readAntigravityUsage(roots, 0);
    assert.deepStrictEqual(result.errors, []);
    assert.strictEqual(result.files.length, 2);
    assert.strictEqual(result.files[0]?.root, roots[0]);
    assert.strictEqual(result.files[0]?.records.length, 2);
    assert.strictEqual(result.files[1]?.records.length, 0);
    assert.deepStrictEqual(
      result.files[0]?.records.map((record) => record.totals.uncachedInputTokens),
      [150, 150],
    );
    assert.isTrue(result.files[0]?.records.every((record) => record.sessionId === "session-0"));
  });

  it("upgrades Antigravity fallback timestamps before applying the date window", async () => {
    for (const fallback of ["mtime", "trajectory"]) {
      const path = NodePath.join(dir, `${fallback}.db`);
      const db = new NodeSqlite.DatabaseSync(path);
      try {
        db.exec(
          "CREATE TABLE gen_metadata (idx INTEGER, data BLOB); CREATE TABLE steps (idx INTEGER, metadata BLOB)",
        );
        if (fallback === "trajectory") {
          db.exec("CREATE TABLE trajectory_metadata_blob (data BLOB)");
          db.prepare("INSERT INTO trajectory_metadata_blob VALUES (?)").run(
            new Uint8Array(protoBytes(2, protoNumber(1, 1780000200))),
          );
        }
        for (const [index, seconds] of [1780000000, 1780000200].entries()) {
          const usage = [...protoNumber(2, 10), ...protoText(11, `${fallback}-${index}`)];
          db.prepare("INSERT INTO steps VALUES (?, ?)").run(
            index,
            new Uint8Array(protoBytes(9, usage)),
          );
          db.prepare("INSERT INTO gen_metadata VALUES (?, ?)").run(
            index,
            new Uint8Array(
              protoBytes(1, [
                ...protoBytes(4, usage),
                ...protoBytes(9, protoBytes(4, protoNumber(1, seconds))),
              ]),
            ),
          );
        }
      } finally {
        db.close();
      }
      await NodeFSP.utimes(path, 1780000000, 1780000000);
    }
    const result = await readAntigravityUsage(dir, 1780000100000);
    assert.deepStrictEqual(result.errors, []);
    const records = result.files.flatMap((file) => file.records);
    assert.strictEqual(records.length, 2);
    assert.deepStrictEqual(
      records.map((record) => record.timestampMs),
      [1780000200000, 1780000200000],
    );
  });

  it("reads Antigravity step-only stores and reports malformed databases", async () => {
    const db = new NodeSqlite.DatabaseSync(NodePath.join(dir, "steps.db"));
    try {
      db.exec("CREATE TABLE steps (idx INTEGER, metadata BLOB)");
      const usage = [...protoNumber(1, 246), ...protoNumber(2, 10), ...protoNumber(3, 5)];
      db.prepare("INSERT INTO steps VALUES (?, ?)").run(
        0,
        new Uint8Array([...protoBytes(9, usage), ...protoBytes(8, protoNumber(1, 1780000000))]),
      );
    } finally {
      db.close();
    }
    await NodeFSP.writeFile(NodePath.join(dir, "broken.db"), "not a sqlite database");
    const result = await readAntigravityUsage(dir, 0);
    assert.strictEqual(result.errors.length, 1);
    assert.strictEqual(result.files.flatMap((file) => file.records)[0]?.model, "gemini-2.5-pro");
    assert.strictEqual(result.files.flatMap((file) => file.records)[0]?.totals.outputTokens, 5);
  });
});
