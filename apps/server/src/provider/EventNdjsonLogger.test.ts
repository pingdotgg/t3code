// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { ThreadId } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { RotatingFileSinkError } from "@t3tools/shared/logging";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Logger from "effect/Logger";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import {
  makeEventNdjsonLogStore,
  type PendingRecord,
  writeBatchedMessages,
} from "./EventNdjsonLogger.ts";

const encodeUnknownJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const decodeUnknownJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

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

it.layer(NodeServices.layer)("EventNdjsonLogger", (it) => {
  it.effect("summarizes circular events without exposing their contents in diagnostics", () => {
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
        const store = yield* makeEventNdjsonLogStore(basePath);
        const logger = store.logger("native");
        yield* logger.write(circular, ThreadId.make("thread-1"));
        yield* store.close();

        const serialized = encodeUnknownJson(messages);
        assert.notInclude(serialized, secret);
        const line = parseLogLine(
          NodeFS.readFileSync(ownedLogPath(basePath, "thread-1"), "utf8").trim(),
        );
        assert.equal(line.payload, '{"truncated":true}');
      } finally {
        NodeFS.rmSync(tempDir, { recursive: true, force: true });
      }
    }).pipe(Effect.provide(Logger.layer([logCapture], { mergeWithExisting: false })));
  });

  it.effect(
    "falls back to a global segment when orchestration thread id is missing or invalid",
    () =>
      Effect.gen(function* () {
        const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-provider-log-"));
        const basePath = NodePath.join(tempDir, "provider-canonical.ndjson");

        try {
          const store = yield* makeEventNdjsonLogStore(basePath);
          const logger = store.logger("orchestration");

          yield* logger.write({ id: "evt-no-thread" }, null);
          yield* logger.write({ id: "evt-invalid-thread" }, "!!!" as unknown as ThreadId);
          yield* store.close();

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
        yield* store.close();

        assert.equal(NodeFS.existsSync(threadPath), true);
        assert.include(NodeFS.readFileSync(threadPath, "utf8"), '{"id":"accepted"}');
      } finally {
        NodeFS.rmSync(tempDir, { recursive: true, force: true });
      }
    }),
  );

  it.effect("summarizes large histories without reading their items", () =>
    Effect.gen(function* () {
      const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-provider-log-"));
      const basePath = NodePath.join(tempDir, "events.log");
      const turns = Array.from({ length: 10_000 });
      Object.defineProperty(turns, 0, {
        get: () => {
          throw new Error("history must not be serialized");
        },
      });

      try {
        const store = yield* makeEventNdjsonLogStore(basePath);
        yield* store.logger("native").write(
          {
            provider: "codex",
            event: {
              direction: "incoming",
              stage: "decoded",
              payload: { id: 42, result: { thread: { id: "native-thread", turns } } },
            },
          },
          ThreadId.make("large-history"),
        );
        yield* store.close();

        const contents = NodeFS.readFileSync(ownedLogPath(basePath, "large-history"), "utf8");
        assert.isBelow(Buffer.byteLength(contents), 2_048);
        const record = decodeUnknownJson(parseLogLine(contents.trim()).payload);
        assert.nestedPropertyVal(record, "event.payload.id", 42);
        assert.nestedPropertyVal(record, "event.payload.result.thread.id", "native-thread");
        assert.nestedPropertyVal(record, "event.payload.result.thread.turns.itemCount", 10_000);
      } finally {
        NodeFS.rmSync(tempDir, { recursive: true, force: true });
      }
    }),
  );

  it.effect("bounds oversized records while retaining failure details", () =>
    Effect.gen(function* () {
      const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-provider-log-"));
      const basePath = NodePath.join(tempDir, "events.log");

      try {
        const store = yield* makeEventNdjsonLogStore(basePath);
        const logger = store.logger("native");
        const threadId = ThreadId.make("large-error");
        const failure = {
          method: "error",
          params: {
            threadId: "native-thread",
            turnId: "native-turn",
            error: { message: "The provider is unavailable.", code: "overloaded" },
            output: "x".repeat(128 * 1_024),
          },
        };
        yield* logger.write(failure, threadId);
        yield* logger.write({ id: "escaped", output: "\u0000".repeat(20_000) }, threadId);
        yield* store.close();

        const contents = NodeFS.readFileSync(ownedLogPath(basePath, "large-error"), "utf8");
        const records = contents
          .trim()
          .split("\n")
          .map((line) => decodeUnknownJson(parseLogLine(line).payload));
        assert.isBelow(Buffer.byteLength(contents), 64 * 1_024);
        assert.equal(records.length, 2);
        assert.nestedPropertyVal(records[0], "params.threadId", "native-thread");
        assert.nestedPropertyVal(records[0], "params.turnId", "native-turn");
        assert.nestedPropertyVal(
          records[0],
          "params.error.message",
          "The provider is unavailable.",
        );
        assert.nestedPropertyVal(records[0], "params.error.code", "overloaded");
        assert.propertyVal(records[1], "id", "escaped");
      } finally {
        NodeFS.rmSync(tempDir, { recursive: true, force: true });
      }
    }),
  );

  it.effect("bounds canonical diff snapshots before serializing their duplicate payloads", () =>
    Effect.gen(function* () {
      const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-provider-log-"));
      const basePath = NodePath.join(tempDir, "events.log");
      const threadId = ThreadId.make("large-diff");
      const diff = "diff-payload".repeat(128 * 1_024);
      try {
        const store = yield* makeEventNdjsonLogStore(basePath, { batchWindowMs: 0 });
        yield* store.logger("canonical").write(
          {
            type: "turn.diff.updated",
            threadId,
            turnId: "native-turn",
            raw: { method: "turn/diff/updated", payload: { diff } },
            payload: { unifiedDiff: diff },
          },
          threadId,
        );
        yield* store.close();
        const contents = NodeFS.readFileSync(ownedLogPath(basePath, "large-diff"), "utf8");
        assert.isBelow(Buffer.byteLength(contents), 2_048);
        const record = decodeUnknownJson(parseLogLine(contents.trim()).payload);
        assert.propertyVal(record, "type", "turn.diff.updated");
        assert.propertyVal(record, "threadId", threadId);
        assert.propertyVal(record, "turnId", "native-turn");
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
        const store = yield* makeEventNdjsonLogStore(basePath, { batchWindowMs: 0 });
        const logger = store.logger("canonical");

        yield* Effect.all(
          [
            logger.write({ id: "evt-concurrent-1" }, null),
            logger.write({ id: "evt-concurrent-2" }, null),
          ],
          { concurrency: "unbounded" },
        );
        yield* store.close();

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

  it.effect("retires a thread log once a retention interval passes without writes", () =>
    Effect.gen(function* () {
      const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-provider-log-"));
      const basePath = NodePath.join(tempDir, "events.log");
      const finishedPath = ownedLogPath(basePath, "finished");
      const activePath = ownedLogPath(basePath, "active");

      try {
        const store = yield* makeEventNdjsonLogStore(basePath, {
          batchWindowMs: 0,
        });
        const logger = store.logger("native");

        yield* logger.write({ id: "finished-first" }, ThreadId.make("finished"));
        yield* TestClock.adjust("5 minutes");
        yield* logger.write({ id: "active-first" }, ThreadId.make("active"));
        assert.equal(NodeFS.existsSync(finishedPath), true);
        NodeFS.truncateSync(finishedPath, 512 * 1024 * 1024 + 1);

        yield* TestClock.adjust("5 minutes");
        yield* logger.write({ id: "active-second" }, ThreadId.make("active"));
        assert.equal(NodeFS.existsSync(finishedPath), false);
        assert.equal(NodeFS.existsSync(activePath), true);

        yield* logger.write({ id: "finished-again" }, ThreadId.make("finished"));
        yield* store.close();
        assert.deepEqual(
          NodeFS.readFileSync(finishedPath, "utf8")
            .trim()
            .split("\n")
            .map((line) => parseLogLine(line).payload),
          ['{"id":"finished-again"}'],
        );
      } finally {
        NodeFS.rmSync(tempDir, { recursive: true, force: true });
      }
    }),
  );

  it.effect("attributes batches that were written before a later chunk fails", () =>
    Effect.gen(function* () {
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

      const result = yield* writeBatchedMessages(
        {
          write: () => {
            writes += 1;
            return writes === 2
              ? Effect.fail(
                  new RotatingFileSinkError({
                    operation: "write",
                    filePath: "test.log",
                    cause: "simulated disk exhaustion",
                  }),
                )
              : Effect.void;
          },
        },
        records,
        5,
        (written) => attributed.push(...written),
      ).pipe(Effect.result);
      assert.equal(result._tag, "Failure");
      assert.deepEqual(attributed, [records[0]]);
    }),
  );

  it.effect(
    "keeps unrelated work responsive and drains before close while a disk write is held",
    () =>
      Effect.gen(function* () {
        const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-provider-log-"));
        const basePath = NodePath.join(tempDir, "events.log");
        const fs = yield* FileSystem.FileSystem;
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        let writes = 0;
        try {
          const store = yield* makeEventNdjsonLogStore(basePath, { batchWindowMs: 0 }).pipe(
            Effect.provideService(FileSystem.FileSystem, {
              ...fs,
              writeFile: (filePath, content, options) =>
                Effect.gen(function* () {
                  if (++writes === 1) {
                    yield* Deferred.succeed(started, undefined);
                    yield* Deferred.await(release);
                  }
                  yield* fs.writeFile(filePath, content, options);
                }),
            }),
          );
          const first = yield* store
            .logger("native")
            .write({ id: "first" }, ThreadId.make("held"))
            .pipe(Effect.forkChild);
          yield* Deferred.await(started);
          const closed = yield* Deferred.make<void>();
          const close = yield* store
            .close()
            .pipe(Effect.andThen(Deferred.succeed(closed, undefined)), Effect.forkChild);
          assert.equal(yield* Deferred.isDone(closed), false);

          const heartbeat = yield* Deferred.make<void>();
          yield* Effect.forkChild(Deferred.succeed(heartbeat, undefined));
          yield* Deferred.await(heartbeat);
          yield* Deferred.succeed(release, undefined);
          yield* Fiber.join(first);
          yield* Fiber.join(close);
          assert.include(
            NodeFS.readFileSync(ownedLogPath(basePath, "held"), "utf8"),
            '{"id":"first"}',
          );
        } finally {
          NodeFS.rmSync(tempDir, { recursive: true, force: true });
        }
      }),
  );
});
