// @effect-diagnostics nodeBuiltinImport:off - resume coverage writes, appends
// to, and truncates real transcript files byte-exactly, mirroring the reader's
// own deliberate node:fs usage.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeZlib from "node:zlib";

import { afterEach, assert, beforeEach, describe, it } from "@effect/vitest";
import type { TranscriptUsageFormat } from "@t3tools/provider-core/server/usage";
import * as Schema from "effect/Schema";

import { TEST_FORMATS } from "./usageTestFormats.ts";
import {
  listTranscriptFiles,
  readTranscriptRecords,
  transcriptLineGate,
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

describe("compressed transcripts", () => {
  it("discovers nested plain and zstd JSONL files within the requested window", async () => {
    const nested = NodePath.join(dir, "nested");
    await NodeFSP.mkdir(nested);
    const plain = NodePath.join(dir, "active.jsonl");
    const compressed = NodePath.join(nested, "archived.jsonl.zst");
    const old = NodePath.join(nested, "old.jsonl.zst");
    await NodeFSP.writeFile(plain, claudeLine(1, 5));
    await NodeFSP.writeFile(compressed, NodeZlib.zstdCompressSync(claudeLine(2, 7)));
    await NodeFSP.writeFile(old, NodeZlib.zstdCompressSync(claudeLine(3, 11)));
    await NodeFSP.writeFile(NodePath.join(nested, "unrelated.zst"), "ignored");
    await NodeFSP.writeFile(NodePath.join(nested, "partial.jsonl.zst.tmp"), "ignored");
    await NodeFSP.utimes(old, 1, 1);

    const listed = await listTranscriptFiles(dir, Date.parse("2026-01-01T00:00:00Z"));
    assert.deepStrictEqual(
      listed.files.map((file) => file.path).sort(),
      [plain, compressed].sort(),
    );
    assert.strictEqual(listed.failedPaths, 0);
    assert.isAbove(listed.files.find((file) => file.path === compressed)?.size ?? 0, 0);
  });

  it.each([
    { parser: "native", streamingThresholdBytes: undefined },
    { parser: "projected", streamingThresholdBytes: 1024 },
  ])(
    "matches plain Codex records and unfinished tails through long lines ($parser)",
    async ({ streamingThresholdBytes }) => {
      const plain = NodePath.join(dir, "rollout.jsonl");
      const compressed = plain + ".zst";
      const large = codexUsageLine(9, 5).replace(
        '"payload":',
        '"padding":' + JSON.stringify("日本語 é".repeat(128 * 1024)) + ',"payload":',
      );
      const content =
        codexMetaLine() +
        codexModelLine("gpt-6-astra") +
        codexTierLine("ultrafast") +
        large +
        codexUsageLine(13, 6).replace('"output_tokens":13', '"output_tokens":"invalid"') +
        codexUsageLine(21, 8).trimEnd();
      await NodeFSP.writeFile(plain, content);
      await NodeFSP.writeFile(compressed, NodeZlib.zstdCompressSync(content));

      const options =
        streamingThresholdBytes === undefined ? undefined : { streamingThresholdBytes };
      const expected = await readTranscriptRecords(plain, TEST_FORMATS.codex, undefined, options);
      const actual = await readTranscriptRecords(
        compressed,
        TEST_FORMATS.codex,
        undefined,
        options,
      );
      assert.isNotNull(expected);
      assert.isNotNull(actual);
      assert.strictEqual(expected.records.length, 1);
      assert.strictEqual(expected.tailRecords.length, 1);
      assert.deepStrictEqual(actual.records, expected.records);
      assert.deepStrictEqual(actual.tailRecords, expected.tailRecords);
      assert.strictEqual(expected.malformedRecords, 1);
      assert.strictEqual(actual.malformedRecords, expected.malformedRecords);
      assert.strictEqual(actual.records[0]?.speed, "ultrafast");
      assert.isFalse(actual.resumed);
      assert.strictEqual(actual.position.resumeOffset, 0);
    },
  );

  it("ignores a prior resume position and rereads compressed rollouts from their start", async () => {
    const plain = NodePath.join(dir, "rollout.jsonl");
    const content = codexMetaLine() + codexModelLine("gpt-6-astra") + codexUsageLine(9, 5);
    await NodeFSP.writeFile(plain, content);
    const first = await readTranscriptRecords(plain, TEST_FORMATS.codex);
    assert.isNotNull(first);

    const compressed = plain + ".zst";
    await NodeFSP.writeFile(compressed, NodeZlib.zstdCompressSync(content + codexUsageLine(21, 8)));
    const actual = await readTranscriptRecords(compressed, TEST_FORMATS.codex, first.position);
    assert.isNotNull(actual);
    assert.isFalse(actual.resumed);
    assert.deepStrictEqual(
      actual.records.map((record) => record.totals.outputTokens),
      [9, 21],
    );
    const repeated = await readTranscriptRecords(compressed, TEST_FORMATS.codex, actual.position);
    assert.isNotNull(repeated);
    assert.isFalse(repeated.resumed);
    assert.deepStrictEqual(repeated.records, actual.records);
  });

  it("returns null for zstd decoder errors rather than caching an empty parse", async () => {
    const path = NodePath.join(dir, "corrupt.jsonl.zst");
    await NodeFSP.writeFile(path, "not a zstd frame");
    assert.isNull(await readTranscriptRecords(path, TEST_FORMATS.claude));
  });
});

describe("readTranscriptRecords resume", () => {
  it.each([
    { mode: "buffered", streamingThresholdBytes: Infinity },
    { mode: "streaming", streamingThresholdBytes: 0 },
  ])("counts malformed tails once across $mode reads and resume", async (options) => {
    const format: TranscriptUsageFormat<{ errors: number }> = {
      ...TEST_FORMATS.claude,
      selectFields: { ...TEST_FORMATS.claude.selectFields, usage: true },
      state: {
        initial: () => ({ errors: 0 }),
        schema: Schema.Struct({ errors: Schema.Number }),
      },
      parseLine(line, state) {
        return this.parseProjected(JSON.parse(line), state);
      },
      parseProjected(value, state) {
        if (
          typeof value === "object" &&
          value !== null &&
          "usage" in value &&
          value.usage === "malformed"
        ) {
          state.errors += 1;
          return [];
        }
        return TEST_FORMATS.claude.parseProjected(value, undefined);
      },
      readMalformedRecords: (state: { errors: number }) => state.errors,
    };
    const path = NodePath.join(dir, "diagnostics.jsonl");
    const malformed = JSON.stringify({ usage: "malformed" });
    // Completed lines enter the projected parser only when they cross a stream chunk.
    const committed = `${JSON.stringify({ usage: "malformed", padding: "x".repeat(256 * 1024) })}\n${claudeLine(1, 5)}`;
    await NodeFSP.writeFile(path, committed + malformed);

    const first = await readTranscriptRecords(path, format, undefined, options);
    assert.isNotNull(first);
    assert.deepStrictEqual(
      first.records.map((record) => record.totals.outputTokens),
      [5],
    );
    assert.deepStrictEqual(first.tailRecords, []);
    assert.strictEqual(first.position.resumeOffset, Buffer.byteLength(committed));
    assert.deepStrictEqual(first.position.state, { errors: 1 });
    assert.strictEqual(first.malformedRecords, 2);

    const savedPosition = JSON.parse(JSON.stringify(first.position));
    await NodeFSP.appendFile(path, `\n${claudeLine(2, 7)}${malformed}\n`);
    const resumed = await readTranscriptRecords(path, format, savedPosition, options);
    assert.isNotNull(resumed);
    assert.isTrue(resumed.resumed);
    assert.deepStrictEqual(
      resumed.records.map((record) => record.totals.outputTokens),
      [7],
    );
    assert.deepStrictEqual(resumed.position.state, { errors: 3 });
    assert.strictEqual(resumed.malformedRecords, 3);

    const full = await readTranscriptRecords(path, format, undefined, options);
    assert.isNotNull(full);
    assert.deepStrictEqual([...first.records, ...resumed.records], full.records);
    assert.deepStrictEqual(resumed.tailRecords, full.tailRecords);
    assert.deepStrictEqual(resumed.position, full.position);
    assert.strictEqual(resumed.malformedRecords, full.malformedRecords);
  });

  it("parses only appended lines when resuming a grown file", async () => {
    const path = NodePath.join(dir, "claude.jsonl");
    await NodeFSP.writeFile(path, claudeLine(1, 5) + claudeLine(2, 7));
    const first = await readTranscriptRecords(path, TEST_FORMATS.claude);
    assert.isNotNull(first);
    assert.strictEqual(first.records.length, 2);
    assert.isFalse(first.resumed);
    assert.strictEqual(first.malformedRecords, 0);

    await NodeFSP.appendFile(path, claudeLine(3, 11));
    const second = await readTranscriptRecords(path, TEST_FORMATS.claude, first.position);
    assert.isNotNull(second);
    assert.isTrue(second.resumed);
    assert.strictEqual(second.records.length, 1);
    assert.strictEqual(second.records[0]?.totals.outputTokens, 11);

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

    // Codex duplicates token_count at stream boundaries, including after resume points.
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

  it.each([
    { mode: "buffered", streamingThresholdBytes: Infinity },
    { mode: "streaming", streamingThresholdBytes: 0 },
  ])(
    "resumes an initial Codex carried-total tail without rebilling it ($mode)",
    async (options) => {
      const path = NodePath.join(dir, "continuation.jsonl");
      const usage = (input: number, output: number) => ({
        input_tokens: input,
        output_tokens: output,
      });
      const event = (last: unknown, cumulative: unknown) =>
        JSON.stringify({
          type: "event_msg",
          timestamp: "2026-08-01T10:00:05Z",
          payload: {
            type: "token_count",
            info: { last_token_usage: last, total_token_usage: cumulative },
          },
        });
      const firstLine = event(usage(100, 20), usage(500, 60));
      await NodeFSP.writeFile(
        path,
        codexMetaLine() + codexModelLine("gpt-6-astra") + codexTierLine("ultrafast") + firstLine,
      );
      const first = await readTranscriptRecords(path, TEST_FORMATS.codex, undefined, options);
      assert.isNotNull(first);
      assert.strictEqual(first.records.length, 0);
      assert.deepStrictEqual(
        first.tailRecords.map((r) => [r.totals.outputTokens, r.speed]),
        [[20, "ultrafast"]],
      );
      assert.strictEqual(first.malformedRecords, 0);

      await NodeFSP.appendFile(path, `\n${firstLine}\n${event(usage(10, 2), usage(510, 62))}\n`);
      const resumed = await readTranscriptRecords(
        path,
        TEST_FORMATS.codex,
        JSON.parse(JSON.stringify(first.position)),
        options,
      );
      const full = await readTranscriptRecords(path, TEST_FORMATS.codex, undefined, options);
      assert.isNotNull(resumed);
      assert.isNotNull(full);
      assert.isTrue(resumed.resumed);
      assert.deepStrictEqual(resumed.records, full.records);
      assert.deepStrictEqual(
        resumed.records.map((r) => [r.totals.outputTokens, r.speed]),
        [
          [20, "ultrafast"],
          [2, "ultrafast"],
        ],
      );
      assert.deepStrictEqual(resumed.tailRecords, []);
      assert.strictEqual(resumed.malformedRecords, 0);
      assert.deepStrictEqual(resumed.position, full.position);
    },
  );

  it("re-parses from the start when the guard bytes no longer match", async () => {
    const path = NodePath.join(dir, "claude.jsonl");
    await NodeFSP.writeFile(path, claudeLine(1, 5));
    const first = await readTranscriptRecords(path, TEST_FORMATS.claude);
    assert.isNotNull(first);

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
});

describe("transcriptLineGate", () => {
  const gates = {
    one: transcriptLineGate(['"usage"']),
    several: transcriptLineGate(['"token_count"', '"session_meta"', '"a.b(c)"']),
  };
  const markers = { one: ['"usage"'], several: ['"token_count"', '"session_meta"', '"a.b(c)"'] };

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
