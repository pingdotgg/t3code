// @effect-diagnostics nodeBuiltinImport:off - resume coverage writes, appends
// to, and truncates real transcript files byte-exactly, mirroring the reader's
// own deliberate node:fs usage.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, assert, beforeEach, describe, it } from "@effect/vitest";

import { TEST_FORMATS } from "./usageTestFormats.ts";
import { readTranscriptRecords, transcriptLineGate } from "./usageTranscriptReader.ts";

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

function codexTierLine(serviceTier: string): string {
  return `${JSON.stringify({
    type: "event_msg",
    timestamp: "2026-08-01T10:00:01Z",
    payload: { type: "thread_settings_applied", thread_settings: { service_tier: serviceTier } },
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
    const first = await readTranscriptRecords(path, TEST_FORMATS.claude);
    assert.isNotNull(first);
    assert.strictEqual(first.records.length, 2);
    assert.isFalse(first.resumed);

    await NodeFSP.appendFile(path, claudeLine(3, 11));
    const second = await readTranscriptRecords(path, TEST_FORMATS.claude, first.position);
    assert.isNotNull(second);
    assert.isTrue(second.resumed);
    assert.strictEqual(second.records.length, 1);
    assert.strictEqual(second.records[0]?.totals.outputTokens, 11);

    // The stitched result matches a from-scratch parse of the whole file.
    const full = await readTranscriptRecords(path, TEST_FORMATS.claude);
    assert.isNotNull(full);
    assert.deepStrictEqual([...first.records, ...second.records], [...full.records]);
  });

  it("carries the Codex reducer state across the resume boundary", async () => {
    const path = NodePath.join(dir, "rollout.jsonl");
    await NodeFSP.writeFile(
      path,
      codexMetaLine() + codexModelLine("gpt-5.2-codex") + codexTierLine("ultrafast"),
    );
    const first = await readTranscriptRecords(path, TEST_FORMATS.codex);
    assert.isNotNull(first);
    assert.strictEqual(first.records.length, 0);

    // The appended usage event has no turn_context, thread settings, or
    // session_meta of its own; model, tier, and session must come from the
    // state captured before the boundary.
    await NodeFSP.appendFile(path, codexUsageLine(9, 5));
    const second = await readTranscriptRecords(path, TEST_FORMATS.codex, first.position);
    assert.isNotNull(second);
    assert.isTrue(second.resumed);
    assert.strictEqual(second.records.length, 1);
    assert.strictEqual(second.records[0]?.model, "gpt-5.2-codex");
    assert.strictEqual(second.records[0]?.speed, "ultrafast");
    assert.strictEqual(second.records[0]?.sessionId, "codex-session-1");
  });

  it("suppresses a Codex duplicate usage event that straddles the boundary", async () => {
    const path = NodePath.join(dir, "rollout.jsonl");
    await NodeFSP.writeFile(
      path,
      codexMetaLine() + codexModelLine("gpt-5.2-codex") + codexUsageLine(9, 5),
    );
    const first = await readTranscriptRecords(path, TEST_FORMATS.codex);
    assert.isNotNull(first);
    assert.strictEqual(first.records.length, 1);

    // Codex re-emits an unchanged token_count on stream boundaries; the copy
    // lands after the resume point and must still be dropped.
    await NodeFSP.appendFile(path, codexUsageLine(9, 5) + codexUsageLine(21, 8));
    const second = await readTranscriptRecords(path, TEST_FORMATS.codex, first.position);
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
    const first = await readTranscriptRecords(path, TEST_FORMATS.claude);
    assert.isNotNull(first);
    assert.strictEqual(first.records.length, 1);
    assert.strictEqual(first.tailRecords.length, 1);
    assert.strictEqual(first.tailRecords[0]?.totals.outputTokens, 7);

    // Completing the line and appending another re-reads from the resume
    // point, so the once-tail record arrives exactly once as a line record.
    await NodeFSP.appendFile(path, `\n${claudeLine(3, 11)}`);
    const second = await readTranscriptRecords(path, TEST_FORMATS.claude, first.position);
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
    const first = await readTranscriptRecords(path, TEST_FORMATS.claude);
    assert.isNotNull(first);

    // Same path, larger size, different content: a replaced file, not growth.
    await NodeFSP.writeFile(path, claudeLine(4, 13) + claudeLine(5, 17));
    const second = await readTranscriptRecords(path, TEST_FORMATS.claude, first.position);
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
    const first = await readTranscriptRecords(path, TEST_FORMATS.claude);
    assert.isNotNull(first);

    await NodeFSP.writeFile(path, claudeLine(3, 11));
    const second = await readTranscriptRecords(path, TEST_FORMATS.claude, first.position);
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

    const parsed = await readTranscriptRecords(path, TEST_FORMATS.claude);
    assert.isNotNull(parsed);
    assert.deepStrictEqual(
      parsed.records.map((record) => record.totals.outputTokens),
      [42, 7],
    );
  });

  it("keeps a CRLF Codex reducer line whose marker straddles a stream chunk", async () => {
    const path = NodePath.join(dir, "rollout.jsonl");
    const crlf = (line: string) => line.replace("\n", "\r\n");
    const modelLine = crlf(codexModelLine("gpt-5.2-codex"));
    // Multi-byte tool output that fails the gate, sized so the 256 KiB chunk
    // boundary falls inside the model line's `"turn_context"` marker.
    const head = crlf(codexMetaLine());
    const fillerBytes =
      256 * 1024 - Buffer.byteLength(head) - modelLine.indexOf("turn_context") - 4;
    const fillerEnvelope = crlf(`${JSON.stringify({ type: "response_item", output: "" })}\n`);
    const padding = "é".repeat((fillerBytes - Buffer.byteLength(fillerEnvelope)) / 2);
    const filler = crlf(`${JSON.stringify({ type: "response_item", output: padding })}\n`);
    const content = head + filler + modelLine + crlf(codexUsageLine(40, 2));
    await NodeFSP.writeFile(path, content);

    const result = await readTranscriptRecords(path, TEST_FORMATS.codex);
    assert.isNotNull(result);
    assert.strictEqual(result.records.length, 1);
    assert.strictEqual(result.records[0]?.model, "gpt-5.2-codex");
    assert.strictEqual(result.records[0]?.sessionId, "codex-session-1");
    assert.strictEqual(result.position.resumeOffset, Buffer.byteLength(content));
  });

  it("returns null for an unreadable file", async () => {
    assert.isNull(
      await readTranscriptRecords(NodePath.join(dir, "missing.jsonl"), TEST_FORMATS.claude),
    );
  });
});

describe("transcriptLineGate", () => {
  const gates = {
    one: transcriptLineGate(['"usage"']),
    several: transcriptLineGate(['"token_count"', '"session_meta"', '"a.b(c)"']),
  };
  const markers = { one: ['"usage"'], several: ['"token_count"', '"session_meta"', '"a.b(c)"'] };

  it("passes only lines containing one of its markers", () => {
    for (const kind of ["one", "several"] as const) {
      for (const marker of markers[kind]) {
        assert.isTrue(gates[kind](Buffer.from(`{"payload":{${marker}:1}}`)));
        // The same text without its quotes, or with one character changed.
        assert.isFalse(gates[kind](Buffer.from(`{"text":"see ${marker.slice(1, -1)} here"}`)));
        assert.isFalse(gates[kind](Buffer.from(`{${marker.replace(/[._]|usage/, "x")}:1}`)));
      }
      assert.isFalse(gates[kind](Buffer.alloc(0)));
    }
  });

  it("matches markers beside multi-byte and malformed UTF-8", () => {
    const invalid = Buffer.from([0xff, 0xc3]);
    for (const kind of ["one", "several"] as const) {
      for (const marker of markers[kind]) {
        assert.isTrue(gates[kind](Buffer.from(`{"text":"日本語 é",${marker}:1}`)));
        assert.isTrue(gates[kind](Buffer.concat([invalid, Buffer.from(marker), invalid])));
        assert.isFalse(gates[kind](Buffer.from(`{"text":"日本語 é ${marker.slice(1, -1)}"}`)));
      }
    }
  });
});
