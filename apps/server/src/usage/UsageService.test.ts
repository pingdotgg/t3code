/**
 * Covers the Codex transcript scan behaviour that was added to `readSummary`:
 * archived rollouts (`archived_sessions`) are scanned in addition to live
 * ones (`sessions`), and a rollout basename present under both roots is
 * counted exactly once instead of twice.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { HttpClient } from "effect/unstable/http";

import type { UsageDay } from "@t3tools/contracts";

import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as UsageService from "./UsageService.ts";
import { totalTokens } from "./usageTranscripts.ts";

const TestHttpClientLive = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make(() => Effect.fail(new Error("network disabled in test") as never)),
);

// All fixture timestamps land "now" so files pass the mtime filter and the
// scan window (`sinceDay`/`untilDay` = today) regardless of what day the
// test actually runs on.
const now = DateTime.nowUnsafe();
const nowParts = DateTime.toParts(now);
const nowIso = DateTime.formatIso(now);
const today = nowIso.slice(0, 10) as UsageDay;

const sessionMeta = (id: string) =>
  JSON.stringify({
    type: "session_meta",
    timestamp: nowIso,
    payload: { type: "session_meta", id },
  });

const turnContext = JSON.stringify({
  type: "turn_context",
  timestamp: nowIso,
  payload: { type: "turn_context", model: "gpt-5.6-sol" },
});

const tokenCount = (inputTokens: number, cached: number, output: number) =>
  JSON.stringify({
    type: "event_msg",
    timestamp: nowIso,
    payload: {
      type: "token_count",
      info: {
        last_token_usage: {
          input_tokens: inputTokens,
          cached_input_tokens: cached,
          cache_write_input_tokens: 0,
          output_tokens: output,
          reasoning_output_tokens: 0,
        },
      },
    },
  });

const rolloutContents = (sessionId: string, inputTokens: number, output: number) =>
  [sessionMeta(sessionId), turnContext, tokenCount(inputTokens, 0, output)].join("\n") + "\n";

const writeRollout = Effect.fn("UsageService.test.writeRollout")(function* (
  filePath: string,
  contents: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fileSystem.makeDirectory(path.dirname(filePath), { recursive: true });
  yield* fileSystem.writeFileString(filePath, contents);
});

describe("UsageService readSummary - Codex transcript scan", () => {
  it.layer(NodeServices.layer)("readSummary", (it) => {
    it.effect("counts sessions, adds archived_sessions, and dedupes shared basenames", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;

        const codexHome = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3code-usage-codex-home-",
        });
        const baseDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3code-usage-state-",
        });

        const year = String(nowParts.year);
        const month = String(nowParts.month).padStart(2, "0");
        const day = String(nowParts.day).padStart(2, "0");

        // Case 1: a rollout that only lives in `sessions/`.
        yield* writeRollout(
          path.join(
            codexHome,
            "sessions",
            year,
            month,
            day,
            "rollout-00000000-0000-0000-0000-000000000001.jsonl",
          ),
          rolloutContents("00000000-0000-0000-0000-000000000001", 1000, 100),
        );

        // Case 2: a different rollout that only lives in `archived_sessions/`
        // (flat layout). This is the behaviour the fix adds.
        yield* writeRollout(
          path.join(
            codexHome,
            "archived_sessions",
            "rollout-00000000-0000-0000-0000-000000000002.jsonl",
          ),
          rolloutContents("00000000-0000-0000-0000-000000000002", 2000, 200),
        );

        // Case 3: the SAME basename present in both roots. Must be counted
        // once, not twice.
        const sharedBasename = "rollout-00000000-0000-0000-0000-000000000003.jsonl";
        const sharedContents = rolloutContents("00000000-0000-0000-0000-000000000003", 4000, 400);
        yield* writeRollout(
          path.join(codexHome, "sessions", year, month, day, sharedBasename),
          sharedContents,
        );
        yield* writeRollout(
          path.join(codexHome, "archived_sessions", sharedBasename),
          sharedContents,
        );

        // Case 4: a rollout that reads empty under `sessions/` (how a rollout
        // moved out mid-scan looks) and holds its records under
        // `archived_sessions/`. The empty read must not claim the basename.
        const movedBasename = "rollout-00000000-0000-0000-0000-000000000004.jsonl";
        yield* writeRollout(path.join(codexHome, "sessions", year, month, day, movedBasename), "");
        yield* writeRollout(
          path.join(codexHome, "archived_sessions", movedBasename),
          rolloutContents("00000000-0000-0000-0000-000000000004", 8000, 800),
        );

        // An empty, isolated Claude home keeps the real machine's own Claude
        // transcripts (if any) out of the token totals asserted below.
        const claudeHome = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3code-usage-claude-home-",
        });

        const settingsLayer = ServerSettings.layerTest({
          providers: { codex: { homePath: codexHome }, claudeAgent: { homePath: claudeHome } },
        });
        const configLayer = ServerConfig.layerTest(baseDir, baseDir);

        const service = yield* Effect.provide(
          UsageService.make,
          Layer.mergeAll(settingsLayer, configLayer, TestHttpClientLive),
        );

        const summary = yield* service.readSummary({
          timeZone: "UTC",
          sinceDay: today,
          untilDay: today,
        });

        const summedTokens = summary.buckets.reduce(
          (sum, bucket) => sum + totalTokens(bucket.totals),
          0,
        );

        // 1000+100 (sessions-only) + 2000+200 (archived-only) + 4000+400
        // (shared, counted once) + 8000+800 (empty live copy, archived copy
        // counted) = 16500. Double counting the shared rollout would make this
        // 21100; dropping the moved rollout would make it 7700.
        expect(summedTokens).toBe(16500);

        const codexSources = summary.sources.filter(
          (source) => source.fingerprint.provider === "codex",
        );
        expect(codexSources).toHaveLength(2);
        expect(codexSources.map((source) => source.fingerprint.resolvedHomePath).sort()).toEqual(
          [path.join(codexHome, "archived_sessions"), path.join(codexHome, "sessions")].sort(),
        );

        const totalScannedFiles = codexSources.reduce(
          (sum, source) => sum + source.scannedFiles,
          0,
        );
        const totalSkippedFiles = codexSources.reduce(
          (sum, source) => sum + source.skippedFiles,
          0,
        );
        // 6 files on disk, 4 counted: the duplicate basename in
        // archived_sessions and the empty live copy of case 4 are skipped.
        expect(totalScannedFiles).toBe(4);
        expect(totalSkippedFiles).toBe(2);
      }),
    );
  });
});
