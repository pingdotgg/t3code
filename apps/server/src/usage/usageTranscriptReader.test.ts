import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { readTranscriptRecords } from "./usageTranscriptReader.ts";

function codexUsageLine(options: {
  readonly timestamp: string;
  readonly total: {
    readonly input: number;
    readonly cached: number;
    readonly cacheWrite: number;
    readonly output: number;
    readonly reasoning: number;
    readonly all: number;
  };
  readonly last: {
    readonly input: number;
    readonly cached: number;
    readonly cacheWrite: number;
    readonly output: number;
    readonly reasoning: number;
    readonly all: number;
  };
}): string {
  const counters = (usage: typeof options.total) => ({
    input_tokens: usage.input,
    cached_input_tokens: usage.cached,
    cache_write_input_tokens: usage.cacheWrite,
    output_tokens: usage.output,
    reasoning_output_tokens: usage.reasoning,
    total_tokens: usage.all,
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

it.layer(NodeServices.layer)("usage transcript reader", (it) => {
  it.effect("returns Codex records with rejected counter diagnostics", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-usage-reader-codex-",
        });
        const transcriptPath = path.join(directory, "rollout.jsonl");

        yield* fileSystem.writeFileString(
          transcriptPath,
          [
            // @effect-diagnostics-next-line preferSchemaOverJson:off -- Raw provider JSONL fixture.
            JSON.stringify({
              timestamp: "2026-08-07T12:00:00.000Z",
              type: "turn_context",
              payload: { model: "gpt-5.4" },
            }),
            codexUsageLine({
              timestamp: "2026-08-07T12:00:01.000Z",
              total: {
                input: 100,
                cached: 0,
                cacheWrite: 0,
                output: 10,
                reasoning: 2,
                all: 110,
              },
              last: {
                input: 100,
                cached: 0,
                cacheWrite: 0,
                output: 10,
                reasoning: 2,
                all: 110,
              },
            }),
            // The cumulative checkpoint is plausible, but the per-request
            // cached subset exceeds its input total and must be rejected.
            codexUsageLine({
              timestamp: "2026-08-07T12:00:02.000Z",
              total: {
                input: 150,
                cached: 60,
                cacheWrite: 0,
                output: 15,
                reasoning: 2,
                all: 165,
              },
              last: {
                input: 50,
                cached: 60,
                cacheWrite: 0,
                output: 5,
                reasoning: 0,
                all: 55,
              },
            }),
          ].join("\n"),
        );

        const result = yield* Effect.promise(() => readTranscriptRecords(transcriptPath, "codex"));

        expect(result).not.toBeNull();
        expect(result?.records).toHaveLength(1);
        expect(result?.malformedRecords).toBe(1);
      }),
    ),
  );

  it.effect("returns zero counter diagnostics for Claude transcripts", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-usage-reader-claude-",
        });
        const transcriptPath = path.join(directory, "session.jsonl");

        yield* fileSystem.writeFileString(
          transcriptPath,
          // @effect-diagnostics-next-line preferSchemaOverJson:off -- Raw provider JSONL fixture.
          JSON.stringify({
            timestamp: "2026-08-07T12:00:00.000Z",
            type: "assistant",
            sessionId: "claude-session",
            message: {
              id: "msg_1",
              model: "claude-opus-4-1",
              usage: {
                input_tokens: 10,
                cache_read_input_tokens: 2,
                cache_creation_input_tokens: 1,
                output_tokens: 5,
              },
            },
          }),
        );

        const result = yield* Effect.promise(() => readTranscriptRecords(transcriptPath, "claude"));

        expect(result).not.toBeNull();
        expect(result?.records).toHaveLength(1);
        expect(result?.malformedRecords).toBe(0);
      }),
    ),
  );
});
