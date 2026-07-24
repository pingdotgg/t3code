import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as References from "effect/References";
import * as Schema from "effect/Schema";

import * as ServerRuntimeState from "./serverRuntimeState.ts";

const isServerRuntimeStateError = Schema.is(ServerRuntimeState.ServerRuntimeStateError);
const isServerStateDirConflictError = Schema.is(ServerRuntimeState.ServerStateDirConflictError);

interface CapturedLog {
  readonly message: unknown;
  readonly annotations: Readonly<Record<string, unknown>>;
}

describe("serverRuntimeState", () => {
  it.effect("persists and reads the runtime state", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-server-runtime-state-test-",
      });
      const statePath = path.join(root, "runtime", "server.json");
      const state: ServerRuntimeState.PersistedServerRuntimeState = {
        version: 1,
        pid: 123,
        host: "127.0.0.1",
        port: 4_971,
        origin: "http://127.0.0.1:4971",
        startedAt: "2026-06-20T00:00:00.000Z",
      };

      yield* ServerRuntimeState.persistServerRuntimeState({ path: statePath, state });
      const restored = yield* ServerRuntimeState.readPersistedServerRuntimeState(statePath);

      assert.deepEqual(Option.getOrThrow(restored), state);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("treats a missing runtime state file as absent", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-server-runtime-state-test-",
      });

      const restored = yield* ServerRuntimeState.readPersistedServerRuntimeState(
        path.join(root, "missing.json"),
      );

      assert.isTrue(Option.isNone(restored));
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("preserves malformed state decode failures", () => {
    const logs: CapturedLog[] = [];
    const logger = Logger.make(({ fiber, message }) => {
      logs.push({
        message,
        annotations: fiber.getRef(References.CurrentLogAnnotations),
      });
    });

    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-server-runtime-state-test-",
      });
      const statePath = path.join(root, "server.json");
      yield* fileSystem.writeFileString(statePath, "{not json");

      const restored = yield* ServerRuntimeState.readPersistedServerRuntimeState(statePath);

      assert.isTrue(Option.isNone(restored));
      assert.equal(logs[0]?.message, `Failed to decode server runtime state at ${statePath}.`);
      const error = logs[0]?.annotations.cause;
      assert.isTrue(isServerRuntimeStateError(error));
      if (isServerRuntimeStateError(error)) {
        assert.equal(error.operation, "decode");
        assert.equal(error.statePath, statePath);
        assert.equal(error.message, `Failed to decode server runtime state at ${statePath}.`);
        assert.deepInclude(error.cause, { _tag: "SchemaError" });
      }
    }).pipe(
      Effect.provide(
        Layer.merge(NodeServices.layer, Logger.layer([logger], { mergeWithExisting: false })),
      ),
    );
  });

  it.effect("preserves runtime state read failures", () => {
    const logs: CapturedLog[] = [];
    const logger = Logger.make(({ fiber, message }) => {
      logs.push({
        message,
        annotations: fiber.getRef(References.CurrentLogAnnotations),
      });
    });

    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-server-runtime-state-test-",
      });
      const statePath = path.join(root, "server.json");
      yield* fileSystem.makeDirectory(statePath);

      const restored = yield* ServerRuntimeState.readPersistedServerRuntimeState(statePath);

      assert.isTrue(Option.isNone(restored));
      assert.equal(logs[0]?.message, `Failed to read server runtime state at ${statePath}.`);
      const error = logs[0]?.annotations.cause;
      assert.isTrue(isServerRuntimeStateError(error));
      if (isServerRuntimeStateError(error)) {
        assert.equal(error.operation, "read");
        assert.equal(error.statePath, statePath);
        assert.equal(error.message, `Failed to read server runtime state at ${statePath}.`);
        assert.deepInclude(error.cause, { _tag: "PlatformError" });
      }
    }).pipe(
      Effect.provide(
        Layer.merge(NodeServices.layer, Logger.layer([logger], { mergeWithExisting: false })),
      ),
    );
  });

  it.effect("preserves runtime state persistence failures", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-server-runtime-state-test-",
      });
      const blockedDirectory = path.join(root, "not-a-directory");
      const statePath = path.join(blockedDirectory, "server.json");
      yield* fileSystem.writeFileString(blockedDirectory, "blocked");

      const error = yield* ServerRuntimeState.persistServerRuntimeState({
        path: statePath,
        state: {
          version: 1,
          pid: 123,
          port: 4_971,
          origin: "http://127.0.0.1:4971",
          startedAt: "2026-06-20T00:00:00.000Z",
        },
      }).pipe(Effect.flip);

      assert.isTrue(isServerRuntimeStateError(error));
      if (isServerRuntimeStateError(error)) {
        assert.equal(error.operation, "persist");
        assert.equal(error.statePath, statePath);
        assert.equal(error.message, `Failed to persist server runtime state at ${statePath}.`);
        assert.deepInclude(error.cause, { _tag: "PlatformError" });
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

describe("decideServerRuntimeStartup", () => {
  const state: ServerRuntimeState.PersistedServerRuntimeState = {
    version: 1,
    pid: 4_242,
    host: "127.0.0.1",
    port: 4_971,
    origin: "http://127.0.0.1:4971",
    startedAt: "2026-06-20T00:00:00.000Z",
  };
  const alwaysAlive = () => true;
  const alwaysDead = () => false;

  it("proceeds when no discovery file exists", () => {
    const decision = ServerRuntimeState.decideServerRuntimeStartup({
      existing: Option.none(),
      ownPid: 999,
      isPidAlive: alwaysAlive,
    });
    assert.equal(decision._tag, "proceed");
  });

  it("reports a conflict when the recorded pid is alive", () => {
    const decision = ServerRuntimeState.decideServerRuntimeStartup({
      existing: Option.some(state),
      ownPid: 999,
      isPidAlive: alwaysAlive,
    });
    assert.equal(decision._tag, "conflict");
    if (decision._tag === "conflict") {
      assert.deepEqual(decision.state, state);
    }
  });

  it("proceeds when the recorded pid is dead (stale file)", () => {
    const decision = ServerRuntimeState.decideServerRuntimeStartup({
      existing: Option.some(state),
      ownPid: 999,
      isPidAlive: alwaysDead,
    });
    assert.equal(decision._tag, "proceed");
  });

  it("proceeds when the recorded pid is our own (same-process restart)", () => {
    const decision = ServerRuntimeState.decideServerRuntimeStartup({
      existing: Option.some(state),
      ownPid: state.pid,
      // Would report a conflict if own-pid were not special-cased.
      isPidAlive: alwaysAlive,
    });
    assert.equal(decision._tag, "proceed");
  });
});

describe("ensureExclusiveStateDir", () => {
  const state: ServerRuntimeState.PersistedServerRuntimeState = {
    version: 1,
    pid: 4_242,
    host: "127.0.0.1",
    port: 4_971,
    origin: "http://127.0.0.1:4971",
    startedAt: "2026-06-20T00:00:00.000Z",
  };

  it.effect("fails with a typed conflict error naming pid, port, origin, and state dir", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const stateDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-server-state-dir-guard-test-",
      });
      const statePath = path.join(stateDir, "server-runtime.json");
      yield* ServerRuntimeState.persistServerRuntimeState({ path: statePath, state });

      const error = yield* ServerRuntimeState.ensureExclusiveStateDir({
        statePath,
        stateDir,
        ownPid: 999,
        isPidAlive: () => true,
      }).pipe(Effect.flip);

      assert.isTrue(isServerStateDirConflictError(error));
      if (isServerStateDirConflictError(error)) {
        assert.equal(error.pid, state.pid);
        assert.equal(error.port, state.port);
        assert.equal(error.origin, state.origin);
        assert.equal(error.stateDir, stateDir);
        assert.include(error.message, String(state.pid));
        assert.include(error.message, stateDir);
        assert.include(error.message, "--base-dir");
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("proceeds when the recorded pid is dead", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const stateDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-server-state-dir-guard-test-",
      });
      const statePath = path.join(stateDir, "server-runtime.json");
      yield* ServerRuntimeState.persistServerRuntimeState({ path: statePath, state });

      yield* ServerRuntimeState.ensureExclusiveStateDir({
        statePath,
        stateDir,
        ownPid: 999,
        isPidAlive: () => false,
      });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("proceeds when the discovery file is missing or corrupt", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const stateDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-server-state-dir-guard-test-",
      });
      const missingPath = path.join(stateDir, "server-runtime.json");

      // Missing file: proceed.
      yield* ServerRuntimeState.ensureExclusiveStateDir({
        statePath: missingPath,
        stateDir,
        ownPid: 999,
        isPidAlive: () => true,
      });

      // Corrupt file: read returns none, so proceed even against a "live" pid.
      yield* fileSystem.writeFileString(missingPath, "{not json");
      yield* ServerRuntimeState.ensureExclusiveStateDir({
        statePath: missingPath,
        stateDir,
        ownPid: 999,
        isPidAlive: () => true,
      });
    }).pipe(
      Effect.provide(
        Layer.merge(
          NodeServices.layer,
          Logger.layer([Logger.make(() => {})], { mergeWithExisting: false }),
        ),
      ),
    ),
  );

  it.effect("fails closed when the discovery file cannot be read", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const stateDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-server-state-dir-guard-test-",
      });
      const statePath = path.join(stateDir, "server-runtime.json");
      yield* fileSystem.makeDirectory(statePath);

      const error = yield* ServerRuntimeState.ensureExclusiveStateDir({
        statePath,
        stateDir,
        ownPid: 999,
        isPidAlive: () => true,
      }).pipe(Effect.flip);

      assert.isTrue(isServerRuntimeStateError(error));
      if (isServerRuntimeStateError(error)) {
        assert.equal(error.operation, "read");
        assert.equal(error.statePath, statePath);
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
