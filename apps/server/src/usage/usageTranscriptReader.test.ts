// @effect-diagnostics nodeBuiltinImport:off - resume coverage writes, appends
// to, and truncates real transcript files byte-exactly, mirroring the reader's
// own deliberate node:fs usage.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, assert, beforeEach, describe, it } from "@effect/vitest";

import { vi } from "vite-plus/test";

vi.mock("node:fs/promises", { spy: true });

import { listTranscriptFiles, readTranscriptRecords } from "./usageTranscriptReader.ts";

let dir: string;

beforeEach(async () => {
  dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "usage-reader-test-"));
});

afterEach(async () => {
  vi.restoreAllMocks();
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
  it("keeps cumulative counters and malformed counts correct across cache and tentative tails", async () => {
    const { encodeScanCache, decodeScanCache } = await import("./usageScanCache.ts");
    const path = NodePath.join(dir, "counter-rollout.jsonl");
    const usage = (input: number, output: number) => ({
      input_tokens: input,
      output_tokens: output,
      total_tokens: input + output,
    });
    const line = (last: unknown, total: unknown) =>
      JSON.stringify({
        type: "event_msg",
        timestamp: "2026-08-01T10:00:05Z",
        payload: {
          type: "token_count",
          info: { last_token_usage: last, total_token_usage: total },
        },
      });
    const firstLine = line(usage(100, 20), usage(100, 20));
    const stale = line(usage(20, 5), usage(100, 20));
    const bad = line(usage(10, 2), usage(130, 28));
    await NodeFSP.writeFile(
      path,
      codexModelLine("gpt-5.4") + firstLine + "\n" + stale + "\n" + bad,
    );
    const first = await readTranscriptRecords(path, "codex");
    assert.isNotNull(first);
    assert.strictEqual(first.records.length, 1);
    assert.strictEqual(first.malformedRecords, 1);
    assert.strictEqual(first.position.codexState?.malformedRecords, 0);
    const stats = await NodeFSP.stat(path);
    const cache = decodeScanCache(
      JSON.parse(
        JSON.stringify(
          encodeScanCache(
            new Map([
              [
                path,
                {
                  ...first,
                  provider: "codex",
                  size: stats.size,
                  mtimeMs: stats.mtimeMs,
                },
              ],
            ]),
          ),
        ),
      ),
    );
    const cached = cache.get(path);
    assert.isDefined(cached);
    assert.strictEqual(cached.malformedRecords, 1);
    const good = line(usage(10, 2), usage(140, 30));
    await NodeFSP.appendFile(path, "\n" + good);
    const resumed = await readTranscriptRecords(path, "codex", cached.position);
    assert.isNotNull(resumed);
    assert.isTrue(resumed.resumed);
    assert.strictEqual(resumed.malformedRecords, 1);
    assert.strictEqual(resumed.position.codexState?.malformedRecords, 1);
    assert.strictEqual(resumed.tailRecords[0]?.totals.outputTokens, 2);
    assert.strictEqual(resumed.position.codexState?.lastCumulativeUsage?.output_tokens, 28);
    await NodeFSP.appendFile(path, "\n");
    const completed = await readTranscriptRecords(path, "codex", resumed.position);
    const full = await readTranscriptRecords(path, "codex");
    assert.isNotNull(completed);
    assert.isNotNull(full);
    assert.deepStrictEqual(
      [...cached.records, ...resumed.records, ...completed.records],
      full.records,
    );
    assert.strictEqual(completed.malformedRecords, full.malformedRecords);
    assert.strictEqual(completed.malformedRecords, 1);
  });

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

describe("transcript listing coverage", () => {
  it("distinguishes a missing root from one that cannot be listed", async () => {
    assert.strictEqual(
      (await listTranscriptFiles(NodePath.join(dir, "missing"), 0)).status,
      "missing",
    );
    const file = NodePath.join(dir, "not-a-directory");
    await NodeFSP.writeFile(file, "x");
    assert.strictEqual((await listTranscriptFiles(file, 0)).status, "failed");
  });

  it("retains readable files when a nested directory cannot be listed", async () => {
    await NodeFSP.mkdir(NodePath.join(dir, "nested"));
    const readable = NodePath.join(dir, "readable.jsonl");
    await NodeFSP.writeFile(readable, claudeLine(1, 5));
    const actual = await vi.importActual<typeof NodeFSP>("node:fs/promises");
    vi.mocked(NodeFSP.readdir)
      .mockImplementationOnce((...args) => actual.readdir(...args))
      .mockRejectedValueOnce(Object.assign(new Error("private detail"), { code: "EACCES" }));
    const result = await listTranscriptFiles(dir, 0);
    assert.strictEqual(result.status, "partial");
    assert.strictEqual(result.failedEntries, 1);
    assert.deepStrictEqual(
      result.files.map((file) => file.path),
      [readable],
    );
  });

  it.each(["EACCES", "EIO", "ENOENT"])(
    "reports %s stat failures while allowing vanished files",
    async (code) => {
      await NodeFSP.writeFile(NodePath.join(dir, "entry.jsonl"), claudeLine(1, 5));
      vi.mocked(NodeFSP.stat).mockRejectedValueOnce(
        Object.assign(new Error("private detail"), { code }),
      );
      const result = await listTranscriptFiles(dir, 0);
      assert.strictEqual(result.status, code === "ENOENT" ? "ok" : "partial");
      assert.strictEqual(result.failedEntries, code === "ENOENT" ? 0 : 1);
      assert.deepStrictEqual(result.files, []);
    },
  );
});
