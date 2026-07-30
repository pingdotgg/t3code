// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { ThreadId } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Logger from "effect/Logger";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import * as ResourceAttribution from "../../resourceTelemetry/ResourceAttribution.ts";
import {
  makeEventNdjsonLogger,
  makeEventNdjsonLogStore,
  type PendingRecord,
  writeBatchedMessages,
} from "./EventNdjsonLogger.ts";

const encodeUnknownJson = Schema.encodeUnknownSync(Schema.UnknownFromJsonString);

function ownedLogPath(basePath: string, segment: string): string {
  const basename = NodePath.basename(basePath);
  const extension = NodePath.extname(basename);
  const stem = extension.length > 0 ? basename.slice(0, -extension.length) : basename;
  return NodePath.join(NodePath.dirname(basePath), `${stem}.${segment}.log`);
}

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

        const threadOnePath = ownedLogPath(basePath, "thread-1");
        const threadTwoPath = ownedLogPath(basePath, "thread-2");
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

          const globalPath = ownedLogPath(basePath, "_global");
          assert.equal(NodeFS.existsSync(globalPath), true);
          const lines = NodeFS.readFileSync(globalPath, "utf8")
            .trim()
            .split("\n")
            .map((line) => parseLogLine(line));
          assert.equal(lines.length, 2);
          assert.equal(Number.isNaN(Date.parse(lines[0]?.observedAt ?? "")), false);
          assert.equal(Number.isNaN(Date.parse(lines[1]?.observedAt ?? "")), false);
          assert.equal(lines[0]?.stream, "ORCH");
          assert.equal(lines[0]?.payload, '{"id":"evt-no-thread"}');
          assert.equal(lines[1]?.stream, "ORCH");
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

        const lines = NodeFS.readFileSync(ownedLogPath(basePath, "thread-shared"), "utf8")
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

  it.effect("keeps shared store views non-owning when one adapter closes", () =>
    Effect.gen(function* () {
      const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-provider-log-"));
      const basePath = NodePath.join(tempDir, "events.log");

      try {
        const store = yield* makeEventNdjsonLogStore(basePath, { batchWindowMs: 0 });
        const native = store.logger("native");
        const canonical = store.logger("canonical");
        const threadId = ThreadId.make("thread-shared-close");

        yield* native.write({ id: "before-close" }, threadId);
        yield* native.close();
        yield* canonical.write({ type: "item.completed", id: "after-close" }, threadId);
        yield* store.close();

        const lines = NodeFS.readFileSync(ownedLogPath(basePath, "thread-shared-close"), "utf8")
          .trim()
          .split("\n")
          .map(parseLogLine);

        assert.deepEqual(
          lines.map(({ stream, payload }) => ({ stream, payload })),
          [
            { stream: "NTIVE", payload: '{"id":"before-close"}' },
            {
              stream: "CANON",
              payload: '{"type":"item.completed","id":"after-close"}',
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
      const threadPath = ownedLogPath(basePath, "thread-batched");

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

  it.effect("does not strand a later batch after an interrupted write", () =>
    Effect.gen(function* () {
      const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-provider-log-"));
      const basePath = NodePath.join(tempDir, "events.log");
      const threadPath = ownedLogPath(basePath, "thread-interrupted");

      try {
        const store = yield* makeEventNdjsonLogStore(basePath, { batchWindowMs: 1_000 });
        const logger = store.logger("native");
        const interruptedWrite = yield* logger
          .write({ id: "possibly-interrupted" }, ThreadId.make("thread-interrupted"))
          .pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        yield* Fiber.interrupt(interruptedWrite);
        yield* logger.write({ id: "accepted" }, ThreadId.make("thread-interrupted"));

        yield* TestClock.adjust(1_000);

        assert.equal(NodeFS.existsSync(threadPath), true);
        assert.include(NodeFS.readFileSync(threadPath, "utf8"), '{"id":"accepted"}');
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

        const lines = NodeFS.readFileSync(ownedLogPath(basePath, "thread-filtered"), "utf8")
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

  it.effect("contains hostile event accessors inside guarded serialization", () =>
    Effect.gen(function* () {
      const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-provider-log-"));
      const basePath = NodePath.join(tempDir, "events.log");

      try {
        const logger = yield* makeEventNdjsonLogger(basePath, {
          stream: "canonical",
          batchWindowMs: 0,
        });
        assert.exists(logger);
        if (!logger) return;
        const hostile = new Proxy(
          { id: "hostile" },
          {
            get(_target, property) {
              if (property === "type") throw new Error("blocked");
              return undefined;
            },
          },
        );

        yield* logger.write(hostile, ThreadId.make("thread-hostile"));
        yield* logger.close();

        const contents = NodeFS.readFileSync(ownedLogPath(basePath, "thread-hostile"), "utf8");
        assert.notInclude(contents, "blocked");
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

        const globalPath = ownedLogPath(basePath, "_global");
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

        const fileStem = NodePath.basename(ownedLogPath(basePath, "thread-rotate"));
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
      const expiredPath = ownedLogPath(basePath, "expired");
      const oldPath = ownedLogPath(basePath, "old");
      const newPath = ownedLogPath(basePath, "new");
      const unrelatedLogPath = NodePath.join(tempDir, "unrelated.log");
      const legacyLogPath = NodePath.join(tempDir, "legacy-thread.log");
      const ignoredPath = NodePath.join(tempDir, "ignored.txt");

      try {
        yield* TestClock.setTime(1_800_000_000_000);
        const now = yield* Clock.currentTimeMillis;
        for (const filePath of [expiredPath, oldPath, newPath, unrelatedLogPath, ignoredPath]) {
          NodeFS.writeFileSync(filePath, "x".repeat(40));
        }
        NodeFS.writeFileSync(
          legacyLogPath,
          "[2026-01-01T00:00:00.000Z] CANON: legacy provider event\n",
        );
        NodeFS.utimesSync(expiredPath, (now - 20_000) / 1_000, (now - 20_000) / 1_000);
        NodeFS.utimesSync(legacyLogPath, (now - 20_000) / 1_000, (now - 20_000) / 1_000);
        NodeFS.utimesSync(oldPath, (now - 5_000) / 1_000, (now - 5_000) / 1_000);
        NodeFS.utimesSync(newPath, now / 1_000, now / 1_000);

        const store = yield* makeEventNdjsonLogStore(basePath, {
          maxAgeMs: 10_000,
          maxTotalBytes: 60,
        });
        yield* store.close();

        assert.equal(NodeFS.existsSync(expiredPath), false);
        assert.equal(NodeFS.existsSync(legacyLogPath), false);
        assert.equal(NodeFS.existsSync(oldPath), false);
        assert.equal(NodeFS.existsSync(newPath), true);
        assert.equal(NodeFS.existsSync(unrelatedLogPath), true);
        assert.equal(NodeFS.existsSync(ignoredPath), true);
      } finally {
        NodeFS.rmSync(tempDir, { recursive: true, force: true });
      }
    }),
  );

  it.effect("does not prune an active thread sink during an unrelated flush", () =>
    Effect.gen(function* () {
      const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-provider-log-"));
      const basePath = NodePath.join(tempDir, "events.log");
      const activePath = ownedLogPath(basePath, "active");

      try {
        yield* TestClock.setTime(1_800_000_000_000);
        const store = yield* makeEventNdjsonLogStore(basePath, {
          batchWindowMs: 0,
          maxAgeMs: 1,
          retentionCheckIntervalMs: 1,
        });
        const logger = store.logger("native");

        yield* logger.write({ id: "active-before-retention" }, ThreadId.make("active"));
        assert.equal(NodeFS.existsSync(activePath), true);

        yield* TestClock.adjust("2 millis");
        yield* logger.write({ id: "retention-trigger" }, ThreadId.make("other"));

        assert.equal(NodeFS.existsSync(activePath), true);
        yield* store.close();
      } finally {
        NodeFS.rmSync(tempDir, { recursive: true, force: true });
      }
    }),
  );

  it("attributes batches that were written before a later chunk fails", () => {
    const records: ReadonlyArray<PendingRecord> = [
      {
        stream: "native",
        threadSegment: "thread",
        line: "first",
        bytes: 5,
      },
      {
        stream: "canonical",
        threadSegment: "thread",
        line: "second",
        bytes: 6,
      },
    ];
    const attributed: Array<PendingRecord> = [];
    let writes = 0;

    assert.throws(() =>
      writeBatchedMessages(
        {
          write: () => {
            writes += 1;
            if (writes === 2) throw new Error("simulated disk exhaustion");
          },
        },
        records,
        5,
        (written) => attributed.push(...written),
      ),
    );
    assert.deepEqual(attributed, [records[0]]);
  });

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
