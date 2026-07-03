import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ThreadId } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";

import { makeGlobalProviderEventSink } from "./GlobalProviderEventSink.ts";

describe("GlobalProviderEventSink", () => {
  it.effect("writes NDJSON lines tagged with stream + threadId", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "t3-global-provider-log-"));
        const filePath = path.join(tempDir, "provider-events.ndjson");

        try {
          const sink = yield* makeGlobalProviderEventSink({
            filePath,
            maxBytes: 10 * 1024 * 1024,
            maxFiles: 10,
            batchWindowMs: 5,
          });

          sink.push("native", ThreadId.make("thread-1"), { id: "evt-1" });
          sink.push("canonical", null, { id: "evt-2" });
          yield* sink.flush;

          const lines = fs
            .readFileSync(filePath, "utf8")
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line) as Record<string, unknown>);

          assert.equal(lines.length, 2);
          assert.equal(lines[0]?.stream, "native");
          assert.equal(lines[0]?.threadId, "thread-1");
          assert.deepStrictEqual(lines[0]?.event, { id: "evt-1" });
          assert.equal(Number.isNaN(Date.parse(String(lines[0]?.observedAt))), false);

          assert.equal(lines[1]?.stream, "canonical");
          assert.equal(lines[1]?.threadId, null);
          assert.deepStrictEqual(lines[1]?.event, { id: "evt-2" });
        } finally {
          fs.rmSync(tempDir, { recursive: true, force: true });
        }
      }),
    ),
  );

  it.effect("flushes buffered lines when its scope closes", () =>
    Effect.gen(function* () {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "t3-global-provider-log-"));
      const filePath = path.join(tempDir, "provider-events.ndjson");

      try {
        yield* Effect.scoped(
          Effect.gen(function* () {
            const sink = yield* makeGlobalProviderEventSink({
              filePath,
              maxBytes: 10 * 1024 * 1024,
              maxFiles: 10,
              batchWindowMs: 60_000,
            });
            sink.push("native", ThreadId.make("thread-1"), { id: "evt-1" });
          }),
        );

        const content = fs.readFileSync(filePath, "utf8").trim();
        assert.notEqual(content.length, 0);
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    }),
  );
});
