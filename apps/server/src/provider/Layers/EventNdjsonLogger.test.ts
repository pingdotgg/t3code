// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { ThreadId } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Logger from "effect/Logger";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import * as ResourceAttribution from "../../resourceTelemetry/ResourceAttribution.ts";
import { makeEventNdjsonLogger, makeEventNdjsonLogStore } from "./EventNdjsonLogger.ts";

const encodeUnknownJson = Schema.encodeUnknownSync(Schema.UnknownFromJsonString);

function parseLogLine(line: string) {
  const match = /^\[([^\]]+)\] ([A-Z]+): (.+)$/.exec(line);
  assert.notEqual(match, null);
  if (!match) {
    throw new Error(`invalid log line: ${line}`);
  }
  const observedAt = match[1];
  const stream = match[2];
  const payload = match[3];
  if (!observedAt || !stream || payload === undefined) {
    throw new Error(`invalid log line: ${line}`);
  }
  return {
    observedAt,
    stream,
    payload,
  };
}

describe("EventNdjsonLogger", () => {
  it.effect("logs bounded diagnostics when an event cannot be serialized", () => {
    const messages: Array<unknown> = [];
    const logCapture = Logger.make<unknown, void>(({ message }) => {
      if (Array.isArray(message)) {
        messages.push(...message);
      } else {
        messages.push(message);
      }
    });
    const secret = "secret-circular-event-value";

    return Effect.gen(function* () {
      const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-provider-log-"));
      const basePath = NodePath.join(tempDir, "provider-native.ndjson");
      const circular: Record<string, unknown> = { secret };
      circular.self = circular;

      try {
        const logger = yield* makeEventNdjsonLogger(basePath, { stream: "native" });
        assert.exists(logger);
        if (!logger) return;
        yield* logger.write(circular, ThreadId.make("thread-1"));

        const serialized = encodeUnknownJson(messages);
        assert.notInclude(serialized, secret);
        assert.include(serialized, '"errorTag":"SchemaError"');
      } finally {
        NodeFS.rmSync(tempDir, { recursive: true, force: true });
      }
    }).pipe(Effect.provide(Logger.layer([logCapture], { mergeWithExisting: false })));
  });

  it.effect("writes effect-style lines to thread-scoped files", () =>
    Effect.gen(function* () {
      const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-provider-log-"));
      const basePath = NodePath.join(tempDir, "provider-native.ndjson");

      try {
        const logger = yield* makeEventNdjsonLogger(basePath, { stream: "native" });
        assert.notEqual(logger, undefined);
        if (!logger) {
          return;
        }

        yield* logger.write(
          { threadId: "provider-thread-1", id: "evt-1" },
          ThreadId.make("thread-1"),
        );
        yield* logger.write(
          { type: "turn.completed", threadId: "provider-thread-2", id: "evt-2" },
          ThreadId.make("thread-2"),
        );
        yield* logger.close();

        const threadOnePath = NodePath.join(tempDir, "thread-1.log");
        const threadTwoPath = NodePath.join(tempDir, "thread-2.log");
        assert.equal(NodeFS.existsSync(threadOnePath), true);
        assert.equal(NodeFS.existsSync(threadTwoPath), true);

        const first = parseLogLine(NodeFS.readFileSync(threadOnePath, "utf8").trim());
        const second = parseLogLine(NodeFS.readFileSync(threadTwoPath, "utf8").trim());

        assert.equal(Number.isNaN(Date.parse(first.observedAt)), false);
        assert.equal(first.stream, "NTIVE");
        assert.equal(first.payload, '{"threadId":"provider-thread-1","id":"evt-1"}');

        assert.equal(Number.isNaN(Date.parse(second.observedAt)), false);
        assert.equal(second.stream, "NTIVE");
        assert.equal(
          second.payload,
          '{"type":"turn.completed","threadId":"provider-thread-2","id":"evt-2"}',
        );
      } finally {
        NodeFS.rmSync(tempDir, { recursive: true, force: true });
      }
    }),
  );

  it.effect(
    "falls back to a global segment when orchestration thread id is missing or invalid",
    () =>
      Effect.gen(function* () {
        const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-provider-log-"));
        const basePath = NodePath.join(tempDir, "provider-canonical.ndjson");

        try {
          const logger = yield* makeEventNdjsonLogger(basePath, { stream: "orchestration" });
          assert.notEqual(logger, undefined);
          if (!logger) {
            return;
          }

          yield* logger.write({ id: "evt-no-thread" }, null);
          yield* logger.write({ id: "evt-invalid-thread" }, "!!!" as unknown as ThreadId);
          yield* logger.close();

          const globalPath = NodePath.join(tempDir, "_global.log");
          assert.equal(NodeFS.existsSync(globalPath), true);
          const lines = NodeFS.readFileSync(globalPath, "utf8")
            .trim()
            .split("\n")
            .map((line) => parseLogLine(line));
          assert.equal(lines.length, 2);
          assert.equal(Number.isNaN(Date.parse(lines[0]?.observedAt ?? "")), false);
          assert.equal(Number.isNaN(Date.parse(lines[1]?.observedAt ?? "")), false);
          assert.equal(lines[0]?.stream, "CANON");
          assert.equal(lines[0]?.payload, '{"id":"evt-no-thread"}');
          assert.equal(lines[1]?.stream, "CANON");
          assert.equal(lines[1]?.payload, '{"id":"evt-invalid-thread"}');
        } finally {
          NodeFS.rmSync(tempDir, { recursive: true, force: true });
        }
      }),
  );

  it.effect("shares one thread writer across native and canonical streams", () =>
    Effect.gen(function* () {
      const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-provider-log-"));
      const basePath = NodePath.join(tempDir, "events.log");

      try {
        const store = yield* makeEventNdjsonLogStore(basePath, { batchWindowMs: 0 });
        const native = store.logger("native");
        const canonical = store.logger("canonical");
        const threadId = ThreadId.make("thread-shared");

        yield* native.write({ id: "native-event" }, threadId);
        yield* canonical.write({ type: "item.completed", id: "canonical-event" }, threadId);
        yield* store.close();

        const lines = NodeFS.readFileSync(NodePath.join(tempDir, "thread-shared.log"), "utf8")
          .trim()
          .split("\n")
          .map(parseLogLine);

        assert.deepEqual(
          lines.map(({ stream, payload }) => ({ stream, payload })),
          [
            { stream: "NTIVE", payload: '{"id":"native-event"}' },
            {
              stream: "CANON",
              payload: '{"type":"item.completed","id":"canonical-event"}',
            },
          ],
        );
      } finally {
        NodeFS.rmSync(tempDir, { recursive: true, force: true });
      }
    }),
  );

  it.effect("flushes an active batch without a permanent polling loop", () =>
    Effect.gen(function* () {
      const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-provider-log-"));
      const basePath = NodePath.join(tempDir, "events.log");
      const threadPath = NodePath.join(tempDir, "thread-batched.log");

      try {
        const store = yield* makeEventNdjsonLogStore(basePath, { batchWindowMs: 1_000 });
        yield* store
          .logger("native")
          .write({ id: "batched-event" }, ThreadId.make("thread-batched"));

        assert.equal(NodeFS.existsSync(threadPath), false);
        yield* TestClock.adjust(1_000);
        assert.equal(NodeFS.existsSync(threadPath), true);
        yield* store.close();
      } finally {
        NodeFS.rmSync(tempDir, { recursive: true, force: true });
      }
    }),
  );

  it.effect("drops transient canonical events before serialization", () =>
    Effect.gen(function* () {
      const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-provider-log-"));
      const basePath = NodePath.join(tempDir, "events.log");

      try {
        const store = yield* makeEventNdjsonLogStore(basePath, { batchWindowMs: 0 });
        const canonical = store.logger("canonical");
        const native = store.logger("native");
        const threadId = ThreadId.make("thread-filtered");
        const circularDelta: Record<string, unknown> = { type: "content.delta" };
        circularDelta["self"] = circularDelta;

        yield* canonical.write(circularDelta, threadId);
        yield* canonical.write({ type: "item.completed", id: "final" }, threadId);
        yield* native.write({ type: "content.delta", id: "native-delta" }, threadId);
        yield* store.close();

        const lines = NodeFS.readFileSync(NodePath.join(tempDir, "thread-filtered.log"), "utf8")
          .trim()
          .split("\n")
          .map(parseLogLine);

        assert.deepEqual(
          lines.map(({ stream, payload }) => ({ stream, payload })),
          [
            { stream: "CANON", payload: '{"type":"item.completed","id":"final"}' },
            { stream: "NTIVE", payload: '{"type":"content.delta","id":"native-delta"}' },
          ],
        );
      } finally {
        NodeFS.rmSync(tempDir, { recursive: true, force: true });
      }
    }),
  );

  it.effect("serializes concurrent first writes for the same segment", () =>
    Effect.gen(function* () {
      const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-provider-log-"));
      const basePath = NodePath.join(tempDir, "provider-canonical.ndjson");

      try {
        const logger = yield* makeEventNdjsonLogger(basePath, {
          stream: "canonical",
          batchWindowMs: 0,
        });
        assert.notEqual(logger, undefined);
        if (!logger) {
          return;
        }

        yield* Effect.all(
          [
            logger.write({ id: "evt-concurrent-1" }, null),
            logger.write({ id: "evt-concurrent-2" }, null),
          ],
          { concurrency: "unbounded" },
        );
        yield* logger.close();

        const globalPath = NodePath.join(tempDir, "_global.log");
        assert.equal(NodeFS.existsSync(globalPath), true);
        const lines = NodeFS.readFileSync(globalPath, "utf8")
          .trim()
          .split("\n")
          .map((line) => parseLogLine(line));

        assert.equal(lines.length, 2);
        assert.deepEqual(lines.map((line) => line.payload).toSorted(), [
          '{"id":"evt-concurrent-1"}',
          '{"id":"evt-concurrent-2"}',
        ]);
      } finally {
        NodeFS.rmSync(tempDir, { recursive: true, force: true });
      }
    }),
  );

  it.effect("rotates per-thread files when max size is exceeded", () =>
    Effect.gen(function* () {
      const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-provider-log-"));
      const basePath = NodePath.join(tempDir, "provider-native.ndjson");

      try {
        const store = yield* makeEventNdjsonLogStore(basePath, {
          maxBytes: 120,
          maxFiles: 2,
          batchWindowMs: 0,
        });
        const native = store.logger("native");
        const canonical = store.logger("canonical");

        for (let index = 0; index < 10; index += 1) {
          const logger = index % 2 === 0 ? native : canonical;
          yield* logger.write(
            {
              type: "session.started",
              threadId: "provider-thread-rotate",
              id: `evt-${index}`,
              payload: "x".repeat(40),
            },
            ThreadId.make("thread-rotate"),
          );
        }
        yield* store.close();

        const fileStem = "thread-rotate.log";
        const matchingFiles = NodeFS.readdirSync(tempDir)
          .filter((entry) => entry === fileStem || entry.startsWith(`${fileStem}.`))
          .toSorted();

        assert.equal(
          matchingFiles.some((entry) => entry === `${fileStem}.1`),
          true,
        );
        assert.equal(
          matchingFiles.some((entry) => entry === fileStem || entry === `${fileStem}.2`),
          true,
        );
        assert.equal(
          matchingFiles.some((entry) => entry === `${fileStem}.3`),
          false,
        );
      } finally {
        NodeFS.rmSync(tempDir, { recursive: true, force: true });
      }
    }),
  );

  it.effect("enforces aggregate age and byte retention on startup", () =>
    Effect.gen(function* () {
      const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-provider-log-"));
      const basePath = NodePath.join(tempDir, "events.log");
      const expiredPath = NodePath.join(tempDir, "expired.log");
      const oldPath = NodePath.join(tempDir, "old.log");
      const newPath = NodePath.join(tempDir, "new.log");
      const ignoredPath = NodePath.join(tempDir, "ignored.txt");

      try {
        yield* TestClock.setTime(1_800_000_000_000);
        const now = yield* Clock.currentTimeMillis;
        for (const filePath of [expiredPath, oldPath, newPath, ignoredPath]) {
          NodeFS.writeFileSync(filePath, "x".repeat(40));
        }
        NodeFS.utimesSync(expiredPath, (now - 20_000) / 1_000, (now - 20_000) / 1_000);
        NodeFS.utimesSync(oldPath, (now - 5_000) / 1_000, (now - 5_000) / 1_000);
        NodeFS.utimesSync(newPath, now / 1_000, now / 1_000);

        const store = yield* makeEventNdjsonLogStore(basePath, {
          maxAgeMs: 10_000,
          maxTotalBytes: 60,
        });
        yield* store.close();

        assert.equal(NodeFS.existsSync(expiredPath), false);
        assert.equal(NodeFS.existsSync(oldPath), false);
        assert.equal(NodeFS.existsSync(newPath), true);
        assert.equal(NodeFS.existsSync(ignoredPath), true);
      } finally {
        NodeFS.rmSync(tempDir, { recursive: true, force: true });
      }
    }),
  );

  it.effect("reports logical provider log writes to resource attribution", () =>
    Effect.gen(function* () {
      const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-provider-log-"));
      const basePath = NodePath.join(tempDir, "provider-native.ndjson");

      try {
        const attribution = yield* ResourceAttribution.make();
        const logger = yield* makeEventNdjsonLogger(basePath, {
          stream: "native",
          batchWindowMs: 0,
          attribution,
        });
        assert.notEqual(logger, undefined);
        if (!logger) {
          return;
        }

        yield* logger.write({ id: "attributed-event" }, ThreadId.make("thread-attribution"));
        yield* logger.close();

        const snapshot = yield* attribution.snapshot;
        assert.equal(snapshot.entries.length, 1);
        assert.equal(snapshot.entries[0]?.component, "provider-event-log");
        assert.equal(snapshot.entries[0]?.operation, "native.append");
        assert.equal(snapshot.entries[0]?.count, 1);
        assert.isAbove(snapshot.entries[0]?.logicalWriteBytes ?? 0, 0);
      } finally {
        NodeFS.rmSync(tempDir, { recursive: true, force: true });
      }
    }),
  );
});
