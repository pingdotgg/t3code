import * as NodeCrypto from "node:crypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Path from "effect/Path";
import * as References from "effect/References";

import * as ServerConfig from "../config.ts";
import * as Identify from "./Identify.ts";

interface CapturedLog {
  readonly message: unknown;
  readonly annotations: Readonly<Record<string, unknown>>;
}

const sha256 = (value: string) =>
  NodeCrypto.createHash("sha256").update(value, "utf8").digest("hex");

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
  errorTag: string,
) => logs.find((log) => log.annotations.source === source && log.annotations.errorTag === errorTag);

it("preserves exact telemetry identity causes without deriving messages from them", () => {
  const decodeCause = new Error("private nested decode details");
  const decodeError = new Identify.TelemetryIdentityDecodeError({
    source: "codex",
    filePath: "/tmp/auth.json",
    cause: decodeCause,
  });
  const readCause = new Error("private nested read details");
  const readError = new Identify.TelemetryIdentityReadError({
    source: "anonymous",
    filePath: "/tmp/anonymous-id",
    cause: readCause,
  });

  assert.strictEqual(decodeError.cause, decodeCause);
  assert.strictEqual(readError.cause, readCause);
  assert.notInclude(decodeError.message, decodeCause.message);
  assert.notInclude(readError.message, readCause.message);
});

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
      const privateAccessToken = "private-codex-access-token";

      yield* fileSystem.makeDirectory(path.dirname(codexAuthPath), { recursive: true });
      yield* fileSystem.writeFileString(
        codexAuthPath,
        `{"tokens":{"access_token":"${privateAccessToken}"}}`,
      );
      yield* fileSystem.writeFileString(config.anonymousIdPath, anonymousId);

      const identifier = yield* Identify.getTelemetryIdentifierForHome(homeDirectory);

      assert.equal(identifier, sha256(anonymousId));
      const decodeLog = findIdentityLog(logs, "codex", "TelemetryIdentityDecodeError");
      assert.isDefined(decodeLog);
      assert.equal(
        decodeLog?.message,
        `Failed to decode codex telemetry identity at '${codexAuthPath}'.`,
      );

      assert.equal(decodeLog?.annotations.filePath, codexAuthPath);
      assert.equal(decodeLog?.annotations.causeKind, "schema");
      assert.notProperty(decodeLog?.annotations ?? {}, "cause");
      const errorStack = decodeLog?.annotations.errorStack;
      assert.isString(errorStack);
      assert.include(errorStack, "Failed to decode codex telemetry identity");
      const annotations = Object.values(decodeLog?.annotations ?? {})
        .map(String)
        .join("\n");
      assert.notInclude(annotations, privateAccessToken);
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

      const readLog = findIdentityLog(logs, "anonymous", "TelemetryIdentityReadError");
      assert.isDefined(readLog);
      assert.equal(readLog?.annotations.filePath, config.anonymousIdPath);
      assert.equal(readLog?.annotations.causeKind, "platform");
      assert.notEqual(readLog?.annotations.platformReason, "NotFound");
      assert.notProperty(readLog?.annotations ?? {}, "cause");
      const errorStack = readLog?.annotations.errorStack;
      assert.isString(errorStack);
      assert.include(errorStack, "Failed to read anonymous telemetry identity");
      assert.isUndefined(
        findIdentityLog(logs, "anonymous", "TelemetryAnonymousIdPersistenceError"),
      );
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
