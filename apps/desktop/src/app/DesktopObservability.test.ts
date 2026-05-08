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

const makeEnvironmentLayer = (baseDir: string) =>
  DesktopEnvironment.layer(environmentInput(baseDir)).pipe(
    Layer.provide(
      Layer.mergeAll(
        NodeServices.layer,
        DesktopConfig.layerTest({
          T3CODE_HOME: baseDir,
          VITE_DEV_SERVER_URL: "http://127.0.0.1:5733",
        }),
      ),
    ),
  );

describe("DesktopObservability", () => {
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

  it.effect("persists backend child output as structured JSON records in development", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-desktop-backend-output-log-test-",
      });
      const environmentLayer = makeEnvironmentLayer(baseDir);
      const logPath = yield* Effect.gen(function* () {
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        return environment.path.join(environment.logDir, "server-child.log");
      }).pipe(Effect.provide(environmentLayer));

      yield* Effect.gen(function* () {
        const outputLog = yield* DesktopObservability.DesktopBackendOutputLog;
        yield* outputLog.writeSessionBoundary({
          phase: "START",
          details: "pid=123 port=3773 cwd=/repo",
        });
        yield* outputLog.writeOutputChunk("stdout", new TextEncoder().encode("hello server\n"));
      }).pipe(
        Effect.annotateLogs({ runId: "test-run" }),
        Effect.provide(DesktopObservability.layer.pipe(Layer.provideMerge(environmentLayer))),
      );

      const log = yield* fileSystem.readFileString(logPath);
      const lines = log.trimEnd().split("\n");
      const boundary = yield* decodeDesktopBackendChildLogRecord(lines[0] ?? "");
      const output = yield* decodeDesktopBackendChildLogRecord(lines[1] ?? "");

      assert.equal(boundary.message, "backend child process session start");
      assert.equal(boundary.level, "INFO");
      assert.equal(boundary.annotations.component, "desktop-backend-child");
      assert.equal(boundary.annotations.runId, "test-run");
      assert.equal(boundary.annotations.phase, "START");
      assert.equal(boundary.annotations.details, "pid=123 port=3773 cwd=/repo");

      assert.equal(output.message, "backend child process output");
      assert.equal(output.level, "INFO");
      assert.equal(output.annotations.component, "desktop-backend-child");
      assert.equal(output.annotations.runId, "test-run");
      assert.equal(output.annotations.stream, "stdout");
      assert.equal(output.annotations.text, "hello server\n");
    }).pipe(
      Effect.scoped,
      Effect.provide(Layer.mergeAll(NodeServices.layer, NodeHttpClient.layerUndici)),
    ),
  );
});
