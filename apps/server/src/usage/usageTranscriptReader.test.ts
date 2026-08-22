// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";

import {
  listTranscriptFiles,
  readTranscriptRecords,
  statUsageFile,
} from "./usageTranscriptReader.ts";

function createOpenCodexLedger(lines: readonly string[]): {
  readonly filePath: string;
  readonly cleanup: () => void;
} {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-opencodex-usage-"));
  const filePath = NodePath.join(dir, "usage.jsonl");
  NodeFS.writeFileSync(filePath, `${lines.join("\n")}\n`);
  return {
    filePath,
    cleanup: () => NodeFS.rmSync(dir, { recursive: true, force: true }),
  };
}

describe("readTranscriptRecords for opencodex", () => {
  it("streams only measurable rows inside the requested window", async () => {
    const cutoffMs = 1_786_000_000_000;
    const before = JSON.stringify({
      requestId: "before",
      timestamp: cutoffMs - 1,
      provider: "openai",
      model: "gpt-5.4",
      usage: { inputTokens: 10, outputTokens: 5 },
    });
    const inside = JSON.stringify({
      requestId: "req-2",
      timestamp: cutoffMs,
      provider: "openai-p372059",
      model: "gpt-5.4",
      conversationId: "session-a",
      usage: {
        inputTokens: 1_050,
        outputTokens: 45,
        reasoningOutputTokens: 12,
        cachedInputTokens: 900,
        cacheReadInputTokens: 900,
        cacheCreationInputTokens: 30,
      },
    });
    const { filePath, cleanup } = createOpenCodexLedger([before, "{broken", inside]);

    try {
      expect(await readTranscriptRecords(filePath, "opencodex", cutoffMs)).toEqual([
        {
          provider: "opencodex",
          timestampMs: cutoffMs,
          model: "openai/gpt-5.4",
          sessionId: "session-a",
          totals: {
            uncachedInputTokens: 120,
            cachedInputTokens: 900,
            cacheCreationTokens: 30,
            outputTokens: 45,
            reasoningTokens: 12,
          },
          reportedCostUsd: null,
          dedupeKey: "opencodex:req-2",
        },
      ]);
    } finally {
      cleanup();
    }
  });

  it("does not turn read failures into cacheable empty usage", async () => {
    expect(
      await readTranscriptRecords(
        NodePath.join(NodeOS.tmpdir(), "t3-opencodex-no-such-dir", "usage.jsonl"),
        "opencodex",
        0,
      ),
    ).toBeNull();
  });

  it("fingerprints the append-only ledger", async () => {
    const { filePath, cleanup } = createOpenCodexLedger([]);
    try {
      const stats = NodeFS.statSync(filePath);
      expect(await statUsageFile(filePath, 0)).toEqual([
        { path: filePath, size: stats.size, mtimeMs: stats.mtimeMs },
      ]);
      expect(await statUsageFile(filePath, stats.mtimeMs + 1)).toEqual([]);
    } finally {
      cleanup();
    }
  });

  it("distinguishes a stat failure from an empty in-window ledger", async () => {
    expect(
      await statUsageFile(
        NodePath.join(NodeOS.tmpdir(), "t3-opencodex-missing-stat", "usage.jsonl"),
        0,
      ),
    ).toBeNull();
  });

  it("reports a transcript root that disappears before the walk", async () => {
    const missingRoot = NodePath.join(NodeOS.tmpdir(), "t3-usage-missing-transcript-root");
    expect(await listTranscriptFiles(missingRoot, 0)).toEqual({
      files: [],
      failedEntries: 1,
    });
  });
});
