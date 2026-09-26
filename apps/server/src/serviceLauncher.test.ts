import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { Launcher, readServiceState, writeServiceState } from "./serviceLauncher.ts";
import {
  compareExactServiceVersions,
  decodeServiceState,
  isExactServiceVersion,
  parseServiceState,
  SERVICE_LAUNCHER_PROTOCOL,
  SERVICE_RESTART_PENDING_FILE,
  SERVICE_STOP_MARKER_FILE,
} from "./cloud/serviceProtocol.ts";

it("accepts only exact semantic versions", () => {
  for (const version of ["0.0.0", "1.2.3", "1.2.3-alpha.1", "1.2.3-0", "1.2.3+001"]) {
    assert.isTrue(isExactServiceVersion(version), version);
  }
  for (const version of ["latest", "01.2.3", "1.2.3-01", "1.2.3-alpha..1", "1.2.3+."]) {
    assert.isFalse(isExactServiceVersion(version), version);
  }
});

it("orders exact semantic versions without treating build metadata as precedence", () => {
  assert.equal(compareExactServiceVersions("1.2.3", "1.2.3"), 0);
  assert.equal(compareExactServiceVersions("1.2.4", "1.2.3"), 1);
  assert.equal(compareExactServiceVersions("2.0.0-alpha.1", "2.0.0-alpha.2"), -1);
  assert.equal(compareExactServiceVersions("2.0.0-alpha.2", "2.0.0-alpha.beta"), -1);
  assert.equal(compareExactServiceVersions("2.0.0-alpha-beta", "2.0.0-alpha-alpha"), 1);
  assert.equal(compareExactServiceVersions("2.0.0", "2.0.0-rc.1"), 1);
  assert.equal(compareExactServiceVersions("2.0.0+one", "2.0.0+two"), 0);
});

it("rejects contradictory service state", () => {
  assert.isUndefined(
    decodeServiceState({
      protocol: SERVICE_LAUNCHER_PROTOCOL,
      activeVersion: "0.0.31",
      update: {
        id: "update-1",
        fromVersion: "0.0.30",
        targetVersion: "0.0.32",
        dbPath: "/tmp/state.sqlite",
        status: "pending",
      },
    }),
  );

  assert.isUndefined(
    decodeServiceState({
      protocol: SERVICE_LAUNCHER_PROTOCOL,
      activeVersion: "1.0.0",
      update: {
        id: "update-3",
        fromVersion: "1.0.0",
        targetVersion: "1.1.0",
        status: "pending",
      },
    }),
  );

  assert.isUndefined(
    decodeServiceState({
      protocol: SERVICE_LAUNCHER_PROTOCOL,
      activeVersion: "1.0.0",
      update: {
        id: "update-2",
        fromVersion: "1.0.0",
        targetVersion: "0.9.0",
        dbPath: "/tmp/state.sqlite",
        status: "pending",
      },
    }),
  );
});

// A pinned runtime is an executable at <versionDir>/t3. The tests stand one up
// as a Node shebang script so the launcher spawns it the way it spawns the
// real single-executable, IPC channel included.
const writeFakeRuntime = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  versionDir: string,
  childSource: string,
) =>
  Effect.gen(function* () {
    const entryPath = path.join(versionDir, "t3");
    yield* fs.makeDirectory(versionDir, { recursive: true });
    yield* fs.writeFileString(entryPath, `#!${process.execPath}\n${childSource}`);
    yield* fs.chmod(entryPath, 0o755);
    yield* fs.writeFileString(
      path.join(versionDir, ".install-complete"),
      `${path.basename(versionDir)}\n`,
    );
    return entryPath;
  });

it.layer(NodeServices.layer)("service state persistence", (it) => {
  for (const protocol of [2, 1]) {
    it.effect(`adopts protocol ${protocol} install state and durably rewrites it`, () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-service-launcher-adopt-" });
        const statePath = path.join(root, "runtime", "service-state.json");
        const activeVersion = "0.0.43-nightly.20260919.1962";
        yield* fs.makeDirectory(path.dirname(statePath), { recursive: true });
        yield* fs.writeFileString(
          statePath,
          `{ "protocol": ${protocol}, "activeVersion": "${activeVersion}" }`,
        );

        const expected = { protocol: SERVICE_LAUNCHER_PROTOCOL, activeVersion };
        assert.deepEqual(yield* Effect.promise(() => readServiceState(statePath)), expected);
        assert.deepEqual(parseServiceState(yield* fs.readFileString(statePath)), expected);
      }),
    );
  }

  it.effect("starts the active runtime from adopted install state", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-service-launcher-adopt-run-" });
      const statePath = path.join(root, "runtime", "service-state.json");
      const activeVersion = "0.0.43-nightly.20260919.1962";
      const versionDir = path.join(root, "runtime", "versions", activeVersion);
      yield* writeFakeRuntime(
        fs,
        path,
        versionDir,
        `
import { writeFileSync } from "node:fs";
const context = JSON.parse(process.env.T3_SERVICE_LAUNCHER_CONTEXT);
writeFileSync(new URL("./started", import.meta.url), context.childVersion);
process.exit(0);
`,
      );
      yield* fs.writeFileString(
        statePath,
        `{ "protocol": 2, "activeVersion": "${activeVersion}" }`,
      );
      const launcher = new Launcher(root, yield* Effect.promise(() => readServiceState(statePath)));
      yield* Effect.promise(() =>
        launcher.run().then(
          () => assert.fail("launcher unexpectedly completed"),
          (error: unknown) => {
            assert.instanceOf(error, Error);
            assert.equal(error.message, "Active child exited unexpectedly (0).");
          },
        ),
      );
      assert.equal(yield* fs.readFileString(path.join(versionDir, "started")), activeVersion);
    }),
  );

  const update = {
    id: "update-1",
    fromVersion: "1.0.0",
    targetVersion: "1.1.0",
    dbPath: "/tmp/state.sqlite",
  };
  const encodeState = (state: unknown) => `${JSON.stringify(state, null, 2)}\n`;
  for (const [name, state] of [
    [
      "pending update",
      { protocol: 2, activeVersion: "1.0.0", update: { ...update, status: "pending" } },
    ],
    [
      "committed update",
      { protocol: 2, activeVersion: "1.1.0", update: { ...update, status: "committed" } },
    ],
    ["future protocol", { protocol: 4, activeVersion: "1.0.0" }],
    ["zero protocol", { protocol: 0, activeVersion: "1.0.0" }],
    ["negative protocol", { protocol: -1, activeVersion: "1.0.0" }],
    ["string protocol", { protocol: "2", activeVersion: "1.0.0" }],
    ["fractional protocol", { protocol: 2.5, activeVersion: "1.0.0" }],
    ["invalid activeVersion", { protocol: 2, activeVersion: "latest" }],
    ["malformed JSON", undefined],
  ] as const) {
    it.effect(`rejects ${name} without changing the state file`, () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-service-launcher-reject-" });
        const statePath = path.join(root, "runtime", "service-state.json");
        const contents = state === undefined ? "{ invalid JSON\n" : encodeState(state);
        yield* fs.makeDirectory(path.dirname(statePath), { recursive: true });
        yield* fs.writeFileString(statePath, contents);

        yield* Effect.promise(() =>
          readServiceState(statePath).then(
            () => assert.fail("invalid service state was accepted"),
            (error: unknown) => {
              assert.instanceOf(error, Error);
              assert.equal(error.message, "Service state is invalid or unsupported.");
            },
          ),
        );
        assert.equal(yield* fs.readFileString(statePath), contents);
      }),
    );
  }

  it.effect("durably replaces and strictly reads one state document", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-service-launcher-test-" });
      const statePath = path.join(root, "runtime", "service-state.json");
      const state = {
        protocol: SERVICE_LAUNCHER_PROTOCOL,
        activeVersion: "0.0.31",
      } as const;

      yield* Effect.promise(() => writeServiceState(statePath, state));
      assert.deepEqual(yield* Effect.promise(() => readServiceState(statePath)), state);
    }),
  );

  it.effect("a fresh launcher clears a restart deferred by t3 update", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-service-launcher-restart-" });
      const statePath = path.join(root, "runtime", "service-state.json");
      const restartPending = path.join(root, "runtime", SERVICE_RESTART_PENDING_FILE);
      yield* writeFakeRuntime(
        fs,
        path,
        path.join(root, "runtime", "versions", "1.0.0"),
        "setInterval(() => {}, 1_000);\n",
      );
      yield* Effect.promise(() =>
        writeServiceState(statePath, {
          protocol: SERVICE_LAUNCHER_PROTOCOL,
          activeVersion: "1.0.0",
        }),
      );
      const run = () =>
        Effect.gen(function* () {
          const launcher = new Launcher(
            root,
            yield* Effect.promise(() => readServiceState(statePath)),
          );
          const running = launcher.run();
          yield* Effect.promise(() => launcher.stop("SIGTERM"));
          yield* Effect.promise(() => running);
        });

      // A launcher that is still the old version leaves a marker that waits
      // for a newer one.
      yield* fs.writeFileString(restartPending, "1.0.1\n");
      yield* run();
      assert.isTrue(yield* fs.exists(restartPending));

      // Whoever restarted the service, the launcher now runs what the unit
      // names, so the deferred-restart marker is gone.
      yield* fs.writeFileString(restartPending, "1.0.0\n");
      yield* run();
      assert.isFalse(yield* fs.exists(restartPending));
    }),
  );

  it.effect("serializes shutdown with launcher recovery", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-service-launcher-stop-" });
      const statePath = path.join(root, "runtime", "service-state.json");
      yield* writeFakeRuntime(
        fs,
        path,
        path.join(root, "runtime", "versions", "1.0.0"),
        "setInterval(() => {}, 1_000);\n",
      );
      yield* Effect.promise(() =>
        writeServiceState(statePath, {
          protocol: SERVICE_LAUNCHER_PROTOCOL,
          activeVersion: "1.0.0",
        }),
      );

      const launcher = new Launcher(root, yield* Effect.promise(() => readServiceState(statePath)));
      const running = launcher.run();
      const stopping = launcher.stop("SIGTERM");
      // An explicit stop leaves the marker that tells a child shutting down
      // mid-update that no replacement server is coming. It is present as
      // soon as stop() returns its promise, before queued transitions run.
      assert.isTrue(yield* fs.exists(path.join(root, "runtime", SERVICE_STOP_MARKER_FILE)));
      yield* Effect.promise(() => stopping);
      yield* Effect.promise(() => running);
    }),
  );

  it.effect("commits only after the trial reports prepared", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-service-launcher-flow-" });
      const statePath = path.join(root, "runtime", "service-state.json");
      const databasePath = path.join(root, "userdata", "state.sqlite");
      yield* fs.makeDirectory(path.dirname(databasePath), { recursive: true });
      yield* fs.writeFileString(databasePath, "before trial");
      // @effect-diagnostics-next-line preferSchemaOverJson:off - embeds a path in fake child source.
      const encodedDatabasePath = JSON.stringify(databasePath);
      const childSource = `
const context = JSON.parse(process.env.T3_SERVICE_LAUNCHER_CONTEXT);
if (context.update?.status === "pending") {
  process.send({ type: "prepared", updateId: context.update.id });
  process.on("message", (message) => {
    if (message.type === "committed") process.exit(0);
  });
} else if (context.update === undefined) {
  process.send({ type: "request-update", targetVersion: "1.1.0", dbPath: ${encodedDatabasePath} });
  setInterval(() => {}, 1_000);
} else {
  process.exit(0);
}
`;
      for (const version of ["1.0.0", "1.1.0"]) {
        yield* writeFakeRuntime(
          fs,
          path,
          path.join(root, "runtime", "versions", version),
          childSource,
        );
      }
      yield* Effect.promise(() =>
        writeServiceState(statePath, {
          protocol: SERVICE_LAUNCHER_PROTOCOL,
          activeVersion: "1.0.0",
        }),
      );

      const launcher = new Launcher(root, yield* Effect.promise(() => readServiceState(statePath)));
      yield* Effect.promise(() =>
        launcher.run().then(
          () => Promise.reject(new Error("launcher unexpectedly completed")),
          () => Promise.resolve(),
        ),
      );

      const state = yield* Effect.promise(() => readServiceState(statePath));
      assert.equal(state.activeVersion, "1.1.0");
      assert.equal(state.update?.status, "committed");
    }),
  );

  it.effect("rolls back a trial that reports the wrong update ID", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-service-launcher-rollback-" });
      const statePath = path.join(root, "runtime", "service-state.json");
      const databasePath = path.join(root, "userdata", "state.sqlite");
      yield* fs.makeDirectory(path.dirname(databasePath), { recursive: true });
      yield* fs.writeFileString(databasePath, "before trial");
      // @effect-diagnostics-next-line preferSchemaOverJson:off - embeds a path in fake child source.
      const encodedDatabasePath = JSON.stringify(databasePath);
      const childSource = `
const context = JSON.parse(process.env.T3_SERVICE_LAUNCHER_CONTEXT);
if (context.update?.status === "pending") {
  process.send({ type: "prepared", updateId: "wrong-update" });
} else if (context.update === undefined) {
  process.send({ type: "request-update", targetVersion: "1.1.0", dbPath: ${encodedDatabasePath} });
  setInterval(() => {}, 1_000);
} else {
  process.exit(0);
}
`;
      for (const version of ["1.0.0", "1.1.0"]) {
        yield* writeFakeRuntime(
          fs,
          path,
          path.join(root, "runtime", "versions", version),
          childSource,
        );
      }
      yield* Effect.promise(() =>
        writeServiceState(statePath, {
          protocol: SERVICE_LAUNCHER_PROTOCOL,
          activeVersion: "1.0.0",
        }),
      );

      const launcher = new Launcher(root, yield* Effect.promise(() => readServiceState(statePath)));
      yield* Effect.promise(() =>
        launcher.run().then(
          () => Promise.reject(new Error("launcher unexpectedly completed")),
          () => Promise.resolve(),
        ),
      );

      const state = yield* Effect.promise(() => readServiceState(statePath));
      assert.equal(state.activeVersion, "1.0.0");
      assert.equal(state.update?.status, "rolled-back");
      assert.equal(
        state.update?.status === "rolled-back" ? state.update.reason : undefined,
        "invalid-prepared",
      );
    }),
  );

  it.effect("restores the database when a migrating trial exits", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-service-launcher-db-" });
      const statePath = path.join(root, "runtime", "service-state.json");
      const databasePath = path.join(root, "userdata", "state.sqlite");
      const original = "database before migration";
      yield* fs.makeDirectory(path.dirname(databasePath), { recursive: true });
      yield* fs.writeFileString(databasePath, original);
      // @effect-diagnostics-next-line preferSchemaOverJson:off - embeds a path in fake child source.
      const encodedDatabasePath = JSON.stringify(databasePath);
      const childSource = `
import { writeFileSync } from "node:fs";
const context = JSON.parse(process.env.T3_SERVICE_LAUNCHER_CONTEXT);
if (context.update?.status === "pending") {
  writeFileSync(context.update.dbPath, "database after migration");
  writeFileSync(context.update.dbPath + "-wal", "trial wal");
  writeFileSync(context.update.dbPath + "-shm", "trial shm");
  process.exit(1);
} else if (context.update === undefined) {
  process.send({ type: "request-update", targetVersion: "1.1.0", dbPath: ${encodedDatabasePath} });
  setInterval(() => {}, 1_000);
} else {
  process.exit(0);
}
`;
      for (const version of ["1.0.0", "1.1.0"]) {
        yield* writeFakeRuntime(
          fs,
          path,
          path.join(root, "runtime", "versions", version),
          childSource,
        );
      }
      yield* Effect.promise(() =>
        writeServiceState(statePath, {
          protocol: SERVICE_LAUNCHER_PROTOCOL,
          activeVersion: "1.0.0",
        }),
      );

      const launcher = new Launcher(root, yield* Effect.promise(() => readServiceState(statePath)));
      yield* Effect.promise(() =>
        launcher.run().then(
          () => Promise.reject(new Error("launcher unexpectedly completed")),
          () => Promise.resolve(),
        ),
      );

      const state = yield* Effect.promise(() => readServiceState(statePath));
      assert.equal(state.activeVersion, "1.0.0");
      assert.equal(state.update?.status, "rolled-back");
      assert.equal(yield* fs.readFileString(databasePath), original);
      assert.isFalse(yield* fs.exists(`${databasePath}-wal`));
      assert.isFalse(yield* fs.exists(`${databasePath}-shm`));
      const updateId = state.update?.id;
      assert.isDefined(updateId);
      assert.isFalse(yield* fs.exists(path.join(root, "runtime", "db-backup", updateId)));
    }),
  );
});
