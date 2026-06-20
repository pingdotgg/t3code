import * as NodeCrypto from "node:crypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as References from "effect/References";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";
import * as Identify from "./Identify.ts";

interface CapturedLog {
  readonly message: unknown;
  readonly annotations: Readonly<Record<string, unknown>>;
}

const sha256 = (value: string) =>
  NodeCrypto.createHash("sha256").update(value, "utf8").digest("hex");

const isTelemetryIdentityDecodeError = Schema.is(Identify.TelemetryIdentityDecodeError);
const isTelemetryIdentityReadError = Schema.is(Identify.TelemetryIdentityReadError);

const makeCaptureLogger = (logs: CapturedLog[]) =>
  Logger.make(({ fiber, message }) => {
    logs.push({
      message,
      annotations: fiber.getRef(References.CurrentLogAnnotations),
    });
  });

const findIdentityLog = (
  logs: ReadonlyArray<CapturedLog>,
  source: Identify.TelemetryIdentitySource,
  operation: string,
) =>
  logs.find((log) => log.annotations.source === source && log.annotations.operation === operation);

it.layer(NodeServices.layer)("telemetry identity", (it) => {
  it.effect("uses the persisted anonymous id when provider identities are absent", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const anonymousId = "persisted-anonymous-id";

      yield* fileSystem.writeFileString(config.anonymousIdPath, anonymousId);

      const identifier = yield* Identify.getTelemetryIdentifierForHome(
        path.join(config.baseDir, "home"),
      );

      assert.equal(identifier, sha256(anonymousId));
    }).pipe(
      Effect.provide(
        ServerConfig.layerTest(process.cwd(), {
          prefix: "t3-telemetry-identify-anonymous-",
        }),
      ),
    ),
  );

  it.effect("logs structured decode context and falls back from malformed Codex auth", () => {
    const logs: CapturedLog[] = [];
    const logger = makeCaptureLogger(logs);

    return Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const homeDirectory = path.join(config.baseDir, "home");
      const codexAuthPath = path.join(homeDirectory, ".codex", "auth.json");
      const anonymousId = "decode-fallback-anonymous-id";

      yield* fileSystem.makeDirectory(path.dirname(codexAuthPath), { recursive: true });
      yield* fileSystem.writeFileString(codexAuthPath, '{"tokens":{}}');
      yield* fileSystem.writeFileString(config.anonymousIdPath, anonymousId);

      const identifier = yield* Identify.getTelemetryIdentifierForHome(homeDirectory);

      assert.equal(identifier, sha256(anonymousId));
      const decodeLog = findIdentityLog(logs, "codex", "decode");
      assert.isDefined(decodeLog);
      assert.equal(
        decodeLog?.message,
        `Failed to decode codex telemetry identity at '${codexAuthPath}'.`,
      );

      const error = decodeLog?.annotations.cause;
      assert.instanceOf(error, Identify.TelemetryIdentityDecodeError);
      if (isTelemetryIdentityDecodeError(error)) {
        assert.equal(error.filePath, codexAuthPath);
        assert.equal(error.source, "codex");
        assert.instanceOf(error.cause, Schema.SchemaError);
      }
    }).pipe(
      Effect.provide(
        Layer.merge(
          ServerConfig.layerTest(process.cwd(), {
            prefix: "t3-telemetry-identify-decode-",
          }),
          Logger.layer([logger], { mergeWithExisting: false }),
        ),
      ),
    );
  });

  it.effect("does not overwrite the anonymous id path after a non-NotFound read failure", () => {
    const logs: CapturedLog[] = [];
    const logger = makeCaptureLogger(logs);

    return Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const homeDirectory = path.join(config.baseDir, "home");

      yield* fileSystem.makeDirectory(config.anonymousIdPath);

      const identifier = yield* Identify.getTelemetryIdentifierForHome(homeDirectory);

      assert.isNull(identifier);
      assert.deepEqual(yield* fileSystem.readDirectory(config.anonymousIdPath), []);

      const readLog = findIdentityLog(logs, "anonymous", "read");
      assert.isDefined(readLog);
      const error = readLog?.annotations.cause;
      assert.instanceOf(error, Identify.TelemetryIdentityReadError);
      if (isTelemetryIdentityReadError(error)) {
        assert.equal(error.filePath, config.anonymousIdPath);
        assert.instanceOf(error.cause, PlatformError.PlatformError);
        if (error.cause instanceof PlatformError.PlatformError) {
          assert.notEqual(error.cause.reason._tag, "NotFound");
        }
      }
      assert.isUndefined(findIdentityLog(logs, "anonymous", "write"));
    }).pipe(
      Effect.provide(
        Layer.merge(
          ServerConfig.layerTest(process.cwd(), {
            prefix: "t3-telemetry-identify-read-",
          }),
          Logger.layer([logger], { mergeWithExisting: false }),
        ),
      ),
    );
  });
});
