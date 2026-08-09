// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { UsageSummaryInput } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as UsageService from "./UsageService.ts";

const summaryInput = Schema.decodeSync(UsageSummaryInput)({
  sinceDay: "2026-08-01",
  untilDay: "2026-08-31",
  timeZone: "UTC",
});
const decodeUnknownJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

function codexUsageLine(options: {
  readonly timestamp: string;
  readonly total: readonly [number, number, number, number, number, number];
  readonly last: readonly [number, number, number, number, number, number];
}): string {
  const counters = (usage: typeof options.total) => ({
    input_tokens: usage[0],
    cached_input_tokens: usage[1],
    cache_write_input_tokens: usage[2],
    output_tokens: usage[3],
    reasoning_output_tokens: usage[4],
    total_tokens: usage[5],
  });

  return JSON.stringify({
    timestamp: options.timestamp,
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: counters(options.total),
        last_token_usage: counters(options.last),
      },
    },
  });
}

function codexTranscript(): string {
  return [
    JSON.stringify({
      timestamp: "2026-08-07T12:00:00.000Z",
      type: "session_meta",
      payload: { id: "codex-session" },
    }),
    JSON.stringify({
      timestamp: "2026-08-07T12:00:00.000Z",
      type: "turn_context",
      payload: { model: "gpt-5.4" },
    }),
    codexUsageLine({
      timestamp: "2026-08-07T12:00:01.000Z",
      total: [100, 0, 0, 10, 2, 110],
      last: [100, 0, 0, 10, 2, 110],
    }),
    // Cached input is a subset of input. This impossible per-request value is
    // rejected, while its plausible cumulative checkpoint becomes the resync.
    codexUsageLine({
      timestamp: "2026-08-07T12:00:02.000Z",
      total: [150, 60, 0, 15, 2, 165],
      last: [50, 60, 0, 5, 0, 55],
    }),
  ].join("\n");
}

const noRatesHttpLayer = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({}))),
  ),
);

it.layer(NodeServices.layer)("UsageService parser diagnostics", (it) => {
  it.effect("reports rejected Codex counters on cold and warm cache reads", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const baseDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-usage-service-",
        });
        const codexHome = path.join(baseDir, "codex-home");
        const codexSessions = path.join(codexHome, "sessions", "2026", "08", "07");
        const claudeHome = path.join(baseDir, "claude-home");
        const claudeProjects = path.join(claudeHome, "projects");
        const transcriptPaths = [
          path.join(codexSessions, "rollout-a.jsonl"),
          path.join(codexSessions, "rollout-b.jsonl"),
        ] as const;
        const transcript = codexTranscript();

        yield* fileSystem.makeDirectory(codexSessions, { recursive: true });
        yield* fileSystem.makeDirectory(claudeProjects, { recursive: true });
        yield* Effect.forEach(transcriptPaths, (transcriptPath) =>
          fileSystem.writeFileString(transcriptPath, transcript),
        );

        const dependencies = Layer.mergeAll(
          ServerConfig.layerTest(process.cwd(), baseDir),
          ServerSettings.layerTest({
            providers: {
              claudeAgent: { homePath: claudeHome },
              codex: { homePath: codexHome },
            },
          }),
          noRatesHttpLayer,
        ).pipe(Layer.provideMerge(NodeServices.layer));

        const coldService = yield* UsageService.make.pipe(Effect.provide(dependencies));
        const coldSummary = yield* coldService.readSummary(summaryInput);
        const coldCodex = coldSummary.sources.find(
          (source) => source.fingerprint.provider === "codex",
        );

        expect(coldCodex).toMatchObject({
          status: "partial",
          scannedFiles: 2,
          malformedRecords: 2,
          message: "Skipped 2 malformed or inconsistent usage records.",
        });
        expect(coldSummary.buckets).toHaveLength(1);

        const cacheDocument = (yield* decodeUnknownJson(
          yield* fileSystem.readFileString(path.join(baseDir, "userdata", "usage-scan-cache.json")),
        )) as { readonly files: Readonly<Record<string, { readonly e?: number }>> };
        expect(
          transcriptPaths.map((transcriptPath) => cacheDocument.files[transcriptPath]?.e),
        ).toEqual([1, 1]);

        // Preserve the cache identity but erase every usage marker. A cold
        // parse would now return no records or diagnostics; the second service
        // must restore both from its durable cache.
        const originalStats = yield* Effect.forEach(transcriptPaths, (transcriptPath) =>
          Effect.promise(() => NodeFSP.stat(transcriptPath)),
        );
        yield* Effect.forEach(transcriptPaths, (transcriptPath, index) =>
          Effect.gen(function* () {
            const original = originalStats[index]!;
            yield* fileSystem.writeFileString(transcriptPath, " ".repeat(transcript.length));
            yield* Effect.promise(() =>
              NodeFSP.utimes(transcriptPath, original.atimeMs / 1000, original.mtimeMs / 1000),
            );
            const restored = yield* Effect.promise(() => NodeFSP.stat(transcriptPath));
            expect(restored.size).toBe(original.size);
            expect(restored.mtimeMs).toBe(original.mtimeMs);
          }),
        );

        const warmService = yield* UsageService.make.pipe(Effect.provide(dependencies));
        const warmSummary = yield* warmService.readSummary(summaryInput);
        const warmCodex = warmSummary.sources.find(
          (source) => source.fingerprint.provider === "codex",
        );

        expect(warmCodex).toMatchObject({
          status: "partial",
          scannedFiles: 2,
          malformedRecords: 2,
          message: "Skipped 2 malformed or inconsistent usage records.",
        });
        expect(warmSummary.buckets).toHaveLength(1);
      }),
    ),
  );
});
