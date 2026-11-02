// @effect-diagnostics nodeBuiltinImport:off - temporary JSONL fixtures exercise the production reader.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { assert, it } from "@effect/vitest";
import { commandCodeUsageFormat } from "./commandCodeUsage.ts";
import { readTranscriptRecords } from "./usageTranscriptReader.ts";

it("reads Command Code history for Usage cost, token and cache breakdown", async () => {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-command-usage-"));
  try {
    const file = NodePath.join(dir, "session.jsonl");
    const lines = [
      { type: "session", id: "thread-1" },
      { type: "message", id: "user-1", message: { role: "user" } },
      {
        type: "message",
        id: "reply-1",
        timestamp: "2026-10-31T19:05:56.089Z",
        model: "deepseek/deepseek-v4-flash",
        usage: {
          inputTokens: 23006,
          outputTokens: 7,
          cacheReadTokens: 6144,
          cacheWriteTokens: 0,
          costUsd: 0.002551932,
        },
      },
      {
        type: "message",
        id: "reply-2",
        timestamp: "2026-10-31T19:06:43.707Z",
        model: "deepseek/deepseek-v4-flash",
        usage: {
          inputTokens: 23353,
          outputTokens: 7,
          cacheReadTokens: 22912,
          cacheWriteTokens: 0,
          costUsd: 0.000139086,
        },
      },
      {
        type: "message",
        id: "reply-2",
        timestamp: "2026-10-31T19:06:43.707000Z",
        model: "deepseek/deepseek-v4-flash",
        usage: {
          inputTokens: 23353,
          outputTokens: 7,
          cacheReadTokens: 22912,
          cacheWriteTokens: 0,
          costUsd: 0.000139086,
        },
      },
      {
        type: "message",
        id: "free-reply",
        timestamp: "2026-10-31T19:06:44.000Z",
        model: "free-model",
        usage: { inputTokens: 1, outputTokens: 2, costUsd: 0 },
      },
      {
        type: "message",
        id: "empty-reply",
        timestamp: "2026-10-31T19:06:45.000Z",
        model: "free-model",
        usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
      },
      {
        type: "message",
        id: "missing-usage-reply",
        timestamp: "2026-10-31T19:06:46.000Z",
        model: "free-model",
        usage: { inputTokens: 0, outputTokens: 0 },
      },
      {
        type: "message",
        id: "inconsistent-cache",
        timestamp: "2026-10-31T19:06:46.500Z",
        model: "free-model",
        usage: { inputTokens: 20, outputTokens: 4, cacheReadTokens: 18, cacheWriteTokens: 5 },
      },
      { type: "message", id: "assistant-without-usage", message: { role: "assistant" } },
    ];
    await NodeFSP.writeFile(file, lines.map((value) => JSON.stringify(value)).join("\n") + "\n");
    const scanned = await readTranscriptRecords(file, commandCodeUsageFormat);
    assert.isNotNull(scanned);
    assert.lengthOf(scanned.records, 4);
    assert.equal(scanned.records[0]?.totals.uncachedInputTokens, 16862);
    assert.equal(scanned.records[0]?.totals.cachedInputTokens, 6144);
    assert.equal(scanned.records[1]?.totals.uncachedInputTokens, 441);
    assert.equal(scanned.records[1]?.totals.cachedInputTokens, 22912);
    assert.equal(scanned.records[1]?.reportedCostUsd, 0.000139086);
    assert.equal(scanned.records[1]?.model, "deepseek/deepseek-v4-flash");
    assert.equal(scanned.records[1]?.sessionId, "thread-1");
    assert.equal(scanned.records[2]?.dedupeKey, scanned.records[1]?.dedupeKey);
    assert.equal(scanned.records[3]?.reportedCostUsd, 0);
    assert.notEqual(scanned.records[3]?.dedupeKey, scanned.records[1]?.dedupeKey);
    // Forked sessions copy the original message and timestamp but have a different session ID.
    const forkFile = NodePath.join(dir, "fork.jsonl");
    await NodeFSP.writeFile(
      forkFile,
      [
        { type: "session", id: "thread-2" },
        {
          type: "message",
          id: "reply-1",
          timestamp: "2026-10-31T19:05:56.089000Z",
          model: "deepseek/deepseek-v4-flash",
          usage: {
            inputTokens: 23006,
            outputTokens: 7,
            cacheReadTokens: 6144,
            cacheWriteTokens: 0,
            costUsd: 0.002551932,
          },
        },
        {
          type: "message",
          id: "reply-1",
          timestamp: "2026-10-31T19:06:47.000Z",
          model: "deepseek/deepseek-v4-flash",
          usage: { inputTokens: 12, outputTokens: 4, costUsd: 0.001 },
        },
      ]
        .map((value) => JSON.stringify(value))
        .join("\n") + "\n",
    );
    const forked = await readTranscriptRecords(forkFile, commandCodeUsageFormat);
    assert.isNotNull(forked);
    assert.lengthOf(forked.records, 2);
    assert.equal(forked.records[0]?.sessionId, "thread-2");
    assert.equal(forked.records[0]?.dedupeKey, scanned.records[0]?.dedupeKey);
    // A reused message ID with a different timestamp is not a copied request.
    assert.notEqual(forked.records[1]?.dedupeKey, scanned.records[0]?.dedupeKey);
    const repeated = await readTranscriptRecords(file, commandCodeUsageFormat, scanned.position);
    assert.isNotNull(repeated);
    assert.lengthOf(repeated.records, 0);
    assert.isTrue(repeated.resumed);
  } finally {
    await NodeFSP.rm(dir, { recursive: true, force: true });
  }
});
