import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as DesktopConfig from "./DesktopConfig.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopObservability from "./DesktopObservability.ts";

const DesktopBackendChildLogRecord = Schema.Struct({
  message: Schema.String,
  level: Schema.Literals(["INFO", "ERROR"]),
  timestamp: Schema.String,
  annotations: Schema.Record(Schema.String, Schema.Unknown),
  spans: Schema.Record(Schema.String, Schema.Unknown),
  fiberId: Schema.String,
});

const decodeDesktopBackendChildLogRecord = Schema.decodeEffect(
  Schema.fromJsonString(DesktopBackendChildLogRecord),
);

const TraceRecordLine = Schema.Struct({
  name: Schema.String,
  attributes: Schema.Record(Schema.String, Schema.Unknown),
  events: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      attributes: Schema.Record(Schema.String, Schema.Unknown),
    }),
  ),
});

const decodeTraceRecordLine = Schema.decodeUnknownSync(Schema.fromJsonString(TraceRecordLine));

const environmentInput = (baseDir: string) =>
  ({
    dirname: "/repo/apps/desktop/dist-electron",
    homeDirectory: baseDir,
    platform: "darwin",
    processArch: "arm64",
    appVersion: "1.2.3",
    appPath: "/repo",
    isPackaged: false,
    resourcesPath: "/repo/resources",
    runningUnderArm64Translation: false,
  }) satisfies DesktopEnvironment.MakeDesktopEnvironmentInput;

const makeEnvironmentLayer = (baseDir: string, isDevelopment = true) =>
  DesktopEnvironment.layer(environmentInput(baseDir)).pipe(
    Layer.provide(
      Layer.mergeAll(
        NodeServices.layer,
        DesktopConfig.layerTest({
          T3CODE_HOME: baseDir,
          VITE_DEV_SERVER_URL: isDevelopment ? "http://127.0.0.1:5733" : undefined,
        }),
      ),
    ),
  );

describe("DesktopObservability", () => {
  it("advances a retained output offset instead of repeatedly copying a full head chunk", () => {
    const maxBufferedBytes = 1024 * 1024;
    const initial = DesktopObservability.appendBoundedOutputChunk(
      {
        runId: "test-run",
        startDetails: "pid=123",
        chunks: [],
        byteLength: 0,
      },
      "stderr",
      new Uint8Array(maxBufferedBytes),
    );
    const initialBackingBuffer = initial.chunks[0]?.chunk.buffer;

    const next = DesktopObservability.appendBoundedOutputChunk(initial, "stderr", Uint8Array.of(1));

    assert.equal(next.chunks[0]?.chunk.buffer, initialBackingBuffer);
    assert.equal(next.chunks[0]?.offset, 1);
    assert.equal(next.byteLength, maxBufferedBytes);
  });

  it.effect("persists desktop Effect logs as span events in desktop.trace.ndjson", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-desktop-observability-test-",
      });
      const environmentLayer = makeEnvironmentLayer(baseDir);
      const tracePath = yield* Effect.gen(function* () {
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        return environment.path.join(environment.logDir, "desktop.trace.ndjson");
      }).pipe(Effect.provide(environmentLayer));
      const logPath = yield* Effect.gen(function* () {
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        return environment.path.join(environment.logDir, "desktop-main.log");
      }).pipe(Effect.provide(environmentLayer));

      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* Effect.annotateCurrentSpan({ "desktop.test": true });
          yield* Effect.logInfo("desktop trace event");
        }).pipe(
          Effect.withSpan("desktop-observability-test"),
          Effect.provide(DesktopObservability.layer.pipe(Layer.provideMerge(environmentLayer))),
        ),
      );

      const records = (yield* fileSystem.readFileString(tracePath))
        .trim()
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => decodeTraceRecordLine(line));
      const record = records.find((entry) => entry.name === "desktop-observability-test");

      assert.notEqual(record, undefined);
      if (!record) {
        return;
      }
      assert.equal(record.attributes["desktop.test"], true);
      assert.equal(
        record.events.some((event) => event.name === "desktop trace event"),
        true,
      );
      assert.isFalse(yield* fileSystem.exists(logPath));
    }).pipe(
      Effect.scoped,
      Effect.provide(Layer.mergeAll(NodeServices.layer, NodeHttpClient.layerUndici)),
    ),
  );

  it.effect("buffers backend child output and persists it only when a failure is reported", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-desktop-backend-output-log-test-",
      });
      const environmentLayer = makeEnvironmentLayer(baseDir, false);
      const logPath = yield* Effect.gen(function* () {
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        return environment.path.join(environment.logDir, "server-child.log");
      }).pipe(Effect.provide(environmentLayer));
      const tracePath = yield* Effect.gen(function* () {
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        return environment.path.join(environment.logDir, "desktop.trace.ndjson");
      }).pipe(Effect.provide(environmentLayer));

      yield* Effect.gen(function* () {
        const factory = yield* DesktopObservability.DesktopBackendOutputLogFactory;
        const outputLog = yield* factory.forInstance("primary");
        yield* outputLog.beginSession({
          details: "pid=123 port=3773 cwd=/repo",
        });
        yield* outputLog.writeOutputChunk("stdout", new TextEncoder().encode("hello server\n"));
        assert.isFalse(yield* fileSystem.exists(logPath));
        yield* outputLog.persistFailure({ details: "code=1" });
        yield* outputLog.beginSession({ details: "pid=456" });
        yield* outputLog.writeOutputChunk("stderr", new TextEncoder().encode("normal shutdown\n"));
        yield* outputLog.discardSession;
      }).pipe(
        Effect.annotateLogs({ runId: "test-run" }),
        Effect.provide(DesktopObservability.layer.pipe(Layer.provideMerge(environmentLayer))),
      );

      const log = yield* fileSystem.readFileString(logPath);
      const lines = log.trimEnd().split("\n");
      const start = yield* decodeDesktopBackendChildLogRecord(lines[0] ?? "");
      const output = yield* decodeDesktopBackendChildLogRecord(lines[1] ?? "");
      const end = yield* decodeDesktopBackendChildLogRecord(lines[2] ?? "");

      assert.equal(lines.length, 3);
      assert.equal(start.message, "backend child process failure output start");
      assert.equal(start.level, "ERROR");
      assert.equal(start.annotations.component, "desktop-backend-child");
      assert.equal(start.annotations.runId, "test-run");
      assert.equal(start.annotations.instanceId, "primary");
      assert.equal(start.annotations.phase, "START");
      assert.equal(start.annotations.details, "pid=123 port=3773 cwd=/repo");

      assert.equal(output.message, "backend child process output");
      assert.equal(output.level, "INFO");
      assert.equal(output.annotations.component, "desktop-backend-child");
      assert.equal(output.annotations.runId, "test-run");
      assert.equal(output.annotations.instanceId, "primary");
      assert.equal(output.annotations.stream, "stdout");
      assert.equal(output.annotations.text, "hello server\n");

      assert.equal(end.message, "backend child process failure output end");
      assert.equal(end.level, "ERROR");
      assert.equal(end.annotations.instanceId, "primary");
      assert.equal(end.annotations.phase, "END");
      assert.equal(end.annotations.details, "code=1");

      const traceRecords = (yield* fileSystem.readFileString(tracePath))
        .trim()
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => decodeTraceRecordLine(line));
      assert.isFalse(
        traceRecords.some(
          (record) => record.name === "desktop.observability.backendOutput.writeOutputChunk",
        ),
      );
    }).pipe(
      Effect.scoped,
      Effect.provide(Layer.mergeAll(NodeServices.layer, NodeHttpClient.layerUndici)),
    ),
  );

  it.effect("keeps buffering output after a non-terminal failure snapshot", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-desktop-backend-output-snapshot-test-",
      });
      const environmentLayer = makeEnvironmentLayer(baseDir, false);
      const logPath = yield* Effect.gen(function* () {
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        return environment.path.join(environment.logDir, "server-child.log");
      }).pipe(Effect.provide(environmentLayer));

      yield* Effect.gen(function* () {
        const factory = yield* DesktopObservability.DesktopBackendOutputLogFactory;
        const outputLog = yield* factory.forInstance("primary");
        yield* outputLog.beginSession({ details: "pid=123" });
        yield* outputLog.writeOutputChunk("stdout", new TextEncoder().encode("before timeout\n"));
        yield* outputLog.persistFailureSnapshot({ details: "readiness timeout" });
        yield* outputLog.writeOutputChunk("stderr", new TextEncoder().encode("after timeout\n"));
        yield* outputLog.persistFailure({ details: "code=1" });
      }).pipe(
        Effect.annotateLogs({ runId: "test-run" }),
        Effect.provide(DesktopObservability.layer.pipe(Layer.provideMerge(environmentLayer))),
      );

      const records = yield* Effect.forEach(
        (yield* fileSystem.readFileString(logPath)).trimEnd().split("\n"),
        (line) => decodeDesktopBackendChildLogRecord(line),
      );
      assert.equal(
        records.some((record) => record.annotations.text === "after timeout\n"),
        true,
      );
      assert.equal(records.at(-1)?.annotations.details, "code=1");
    }).pipe(
      Effect.scoped,
      Effect.provide(Layer.mergeAll(NodeServices.layer, NodeHttpClient.layerUndici)),
    ),
  );

  it.effect("retains only the last mebibyte of backend child output", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-desktop-backend-output-bound-test-",
      });
      const environmentLayer = makeEnvironmentLayer(baseDir, false);
      const logPath = yield* Effect.gen(function* () {
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        return environment.path.join(environment.logDir, "server-child.log");
      }).pipe(Effect.provide(environmentLayer));
      const maxBufferedBytes = 1024 * 1024;
      const discardedPrefixBytes = 128;
      const output = new Uint8Array(maxBufferedBytes + discardedPrefixBytes);
      output.fill("x".charCodeAt(0));
      output.fill("y".charCodeAt(0), 0, discardedPrefixBytes);

      yield* Effect.scoped(
        Effect.gen(function* () {
          const factory = yield* DesktopObservability.DesktopBackendOutputLogFactory;
          const outputLog = yield* factory.forInstance("primary");
          yield* outputLog.beginSession({ details: "pid=123" });
          yield* outputLog.writeOutputChunk("stderr", output);
          yield* outputLog.persistFailure({ details: "code=1" });
        }).pipe(
          Effect.provide(DesktopObservability.layer.pipe(Layer.provideMerge(environmentLayer))),
        ),
      );

      const lines = (yield* fileSystem.readFileString(logPath)).trimEnd().split("\n");
      const record = yield* decodeDesktopBackendChildLogRecord(lines[1] ?? "");
      const text = record.annotations.text;
      assert.equal(typeof text, "string");
      if (typeof text !== "string") {
        return;
      }
      assert.equal(new TextEncoder().encode(text).byteLength, maxBufferedBytes);
      assert.isFalse(text.includes("y"));
    }).pipe(
      Effect.scoped,
      Effect.provide(Layer.mergeAll(NodeServices.layer, NodeHttpClient.layerUndici)),
    ),
  );

  it.effect("bounds the number of retained backend child output chunks", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-desktop-backend-output-chunks-test-",
      });
      const environmentLayer = makeEnvironmentLayer(baseDir, false);
      const logPath = yield* Effect.gen(function* () {
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        return environment.path.join(environment.logDir, "server-child.log");
      }).pipe(Effect.provide(environmentLayer));

      yield* Effect.scoped(
        Effect.gen(function* () {
          const factory = yield* DesktopObservability.DesktopBackendOutputLogFactory;
          const outputLog = yield* factory.forInstance("primary");
          yield* outputLog.beginSession({ details: "pid=123" });
          for (let index = 0; index < 300; index += 1) {
            yield* outputLog.writeOutputChunk("stderr", Uint8Array.of(index % 128));
          }
          yield* outputLog.persistFailure({ details: "code=1" });
        }).pipe(
          Effect.provide(DesktopObservability.layer.pipe(Layer.provideMerge(environmentLayer))),
        ),
      );

      const lines = (yield* fileSystem.readFileString(logPath)).trimEnd().split("\n");
      assert.equal(lines.length, 258);
    }).pipe(
      Effect.scoped,
      Effect.provide(Layer.mergeAll(NodeServices.layer, NodeHttpClient.layerUndici)),
    ),
  );
});
