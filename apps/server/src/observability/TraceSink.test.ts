import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";

import type { TraceRecord } from "./TraceRecord.ts";
import { makeTraceSink } from "./TraceSink.ts";

const makeRecord = (name: string, suffix = ""): TraceRecord => ({
  type: "effect-span",
  name,
  traceId: `trace-${name}-${suffix}`,
  spanId: `span-${name}-${suffix}`,
  sampled: true,
  kind: "internal",
  startTimeUnixNano: "1",
  endTimeUnixNano: "2",
  durationMs: 1,
  attributes: {
    payload: suffix,
  },
  events: [],
  links: [],
  exit: {
    _tag: "Success",
  },
});

describe("TraceSink", () => {
  it.effect("flushes buffered records on close", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "t3-trace-sink-"));
        const tracePath = path.join(tempDir, "server.trace.ndjson");

        try {
          const sink = yield* makeTraceSink({
            filePath: tracePath,
            maxBytes: 1024,
            maxFiles: 2,
            batchWindowMs: 10_000,
          });

          sink.push(makeRecord("alpha"));
          sink.push(makeRecord("beta"));
          yield* sink.close();

          const lines = fs
            .readFileSync(tracePath, "utf8")
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line) as TraceRecord);

          assert.equal(lines.length, 2);
          assert.equal(lines[0]?.name, "alpha");
          assert.equal(lines[1]?.name, "beta");
        } finally {
          fs.rmSync(tempDir, { recursive: true, force: true });
        }
      }),
    ),
  );

  it.effect("rotates the trace file when the configured max size is exceeded", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "t3-trace-sink-"));
        const tracePath = path.join(tempDir, "server.trace.ndjson");

        try {
          const sink = yield* makeTraceSink({
            filePath: tracePath,
            maxBytes: 180,
            maxFiles: 2,
            batchWindowMs: 10_000,
          });

          for (let index = 0; index < 8; index += 1) {
            sink.push(makeRecord("rotate", `${index}-${"x".repeat(48)}`));
            yield* sink.flush;
          }
          yield* sink.close();

          const matchingFiles = fs
            .readdirSync(tempDir)
            .filter(
              (entry) =>
                entry === "server.trace.ndjson" || entry.startsWith("server.trace.ndjson."),
            )
            .toSorted();

          assert.equal(
            matchingFiles.some((entry) => entry === "server.trace.ndjson.1"),
            true,
          );
          assert.equal(
            matchingFiles.some((entry) => entry === "server.trace.ndjson.3"),
            false,
          );
        } finally {
          fs.rmSync(tempDir, { recursive: true, force: true });
        }
      }),
    ),
  );

  it.effect("drops only the invalid record when serialization fails", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "t3-trace-sink-"));
        const tracePath = path.join(tempDir, "server.trace.ndjson");

        try {
          const sink = yield* makeTraceSink({
            filePath: tracePath,
            maxBytes: 1024,
            maxFiles: 2,
            batchWindowMs: 10_000,
          });

          const circular: Array<unknown> = [];
          circular.push(circular);

          sink.push(makeRecord("alpha"));
          sink.push({
            ...makeRecord("invalid"),
            attributes: {
              circular,
            },
          } as TraceRecord);
          sink.push(makeRecord("beta"));
          yield* sink.close();

          const lines = fs
            .readFileSync(tracePath, "utf8")
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line) as TraceRecord);

          assert.deepStrictEqual(
            lines.map((line) => line.name),
            ["alpha", "beta"],
          );
        } finally {
          fs.rmSync(tempDir, { recursive: true, force: true });
        }
      }),
    ),
  );
});
