// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "@effect/vitest";

import { readTranscriptRecords } from "./usageTranscriptReader.ts";

const temporaryDirectories: string[] = [];

async function writeTranscript(lines: readonly string[], trailingNewline = true): Promise<string> {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-usage-reader-"));
  temporaryDirectories.push(directory);
  const filePath = NodePath.join(directory, "rollout.jsonl");
  await NodeFSP.writeFile(filePath, lines.join("\n") + (trailingNewline ? "\n" : ""));
  return filePath;
}

const sessionMeta = JSON.stringify({
  type: "session_meta",
  timestamp: "2026-08-01T05:17:41.289Z",
  payload: { type: "session_meta", id: "session-1" },
});

const turnContext = JSON.stringify({
  type: "turn_context",
  timestamp: "2026-08-01T05:17:42.694Z",
  payload: { type: "turn_context", model: "gpt-5.6-sol" },
});

const tokenCount = JSON.stringify({
  type: "event_msg",
  timestamp: "2026-08-01T05:17:49.919Z",
  payload: {
    type: "token_count",
    info: {
      last_token_usage: {
        input_tokens: 1200,
        cached_input_tokens: 200,
        cache_write_input_tokens: 0,
        output_tokens: 100,
        reasoning_output_tokens: 25,
      },
    },
  },
});

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => NodeFSP.rm(directory, { recursive: true, force: true })),
  );
});

describe("readTranscriptRecords", () => {
  it("skips an oversized irrelevant line and continues with later usage", async () => {
    const oversizedToolResult = JSON.stringify({
      type: "event_msg",
      payload: { type: "patch_apply_end", output: `token_count:${"x".repeat(2048)}` },
    });
    const filePath = await writeTranscript([
      sessionMeta,
      turnContext,
      oversizedToolResult,
      tokenCount,
    ]);

    const records = await readTranscriptRecords(filePath, "codex", { maxLineBytes: 512 });

    expect(records).toHaveLength(1);
    expect(records?.[0]).toMatchObject({
      model: "gpt-5.6-sol",
      sessionId: "session-1",
      totals: {
        uncachedInputTokens: 1000,
        cachedInputTokens: 200,
        outputTokens: 100,
        reasoningTokens: 25,
      },
    });
  });

  it("preserves CRLF records and an unterminated final line", async () => {
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-usage-reader-"));
    temporaryDirectories.push(directory);
    const filePath = NodePath.join(directory, "rollout.jsonl");
    await NodeFSP.writeFile(filePath, [sessionMeta, turnContext, tokenCount].join("\r\n"));

    const records = await readTranscriptRecords(filePath, "codex");

    expect(records).toHaveLength(1);
    expect(records?.[0]?.totals.outputTokens).toBe(100);
  });
});
