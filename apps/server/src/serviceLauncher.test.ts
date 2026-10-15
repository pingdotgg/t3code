// @effect-diagnostics-next-line nodeBuiltinImport:off - observes the children the launcher spawns with Node built-ins.
import type * as NodeChildProcess from "node:child_process";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { SERVER_EXIT_CODE_STATE_DIR_OWNED } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { vi } from "vite-plus/test";

import {
  databaseBackupBlocker,
  Launcher,
  PREPARED_TIMEOUT_MS,
  type BackupSpaceProbe,
  readServiceState,
  readServiceStateForLauncher,
  writeServiceState,
} from "./serviceLauncher.ts";
import {
  compareExactServiceVersions,
  decodeServiceState,
  isExactServiceVersion,
  SERVICE_LAUNCHER_PROTOCOL,
  SERVICE_RESTART_PENDING_FILE,
  SERVICE_STOP_MARKER_FILE,
} from "./cloud/serviceProtocol.ts";

const spawnedChildren = vi.hoisted((): Array<NodeChildProcess.ChildProcess> => []);

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeChildProcess>();
  const spawn = (...args: Parameters<typeof actual.spawn>) => {
    const [command, spawnArguments, options] = args;
    const isWindowsFakeRuntime =
      // oxlint-disable-next-line t3code/no-global-process-runtime -- the fake executable must mirror the host launcher name.
      process.platform === "win32" && typeof command === "string" && command.endsWith("t3.exe");
    const child = isWindowsFakeRuntime
      ? actual.spawn(
          process.execPath,
          [`${command.slice(0, -".exe".length)}.mjs`, ...(spawnArguments ?? [])],
          options,
        )
      : actual.spawn(...args);
    spawnedChildren.push(child);
    return child;
  };
  return { ...actual, spawn: spawn as typeof actual.spawn };
});

const writeSparseFile = (filePath: string, size: number) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    yield* fileSystem.writeFileString(filePath, "");
    yield* fileSystem.truncate(filePath, size);
  });

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
    // oxlint-disable-next-line t3code/no-global-process-runtime -- the fixture mirrors the standalone launcher's host executable.
    const windows = process.platform === "win32";
    const entryPath = path.join(versionDir, windows ? "t3.exe" : "t3");
    const scriptPath = path.join(versionDir, windows ? "t3.mjs" : "t3");
    yield* fs.makeDirectory(versionDir, { recursive: true });
    yield* fs.writeFileString(scriptPath, `#!${process.execPath}\n${childSource}`);
    if (windows) {
      yield* fs.writeFileString(entryPath, "fake executable");
    } else {
      yield* fs.chmod(scriptPath, 0o755);
    }
    yield* fs.writeFileString(
      path.join(versionDir, ".install-complete"),
      `${path.basename(versionDir)}\n`,
    );
    return entryPath;
  });

it.layer(NodeServices.layer)("service state persistence", (it) => {
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

  it.effect("migrates a protocol-2 install state before starting its runtime", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-service-launcher-migrate-" });
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
      const legacyContents = `{ "protocol": 2, "activeVersion": "${activeVersion}" }`;
      yield* fs.makeDirectory(path.dirname(statePath), { recursive: true });
      yield* fs.writeFileString(statePath, legacyContents);

      const state = yield* Effect.promise(() => readServiceStateForLauncher(root, statePath));
      assert.deepEqual(state, { protocol: SERVICE_LAUNCHER_PROTOCOL, activeVersion });
      assert.deepEqual(yield* Effect.promise(() => readServiceState(statePath)), {
        protocol: SERVICE_LAUNCHER_PROTOCOL,
        activeVersion,
      });
      assert.notEqual(yield* fs.readFileString(statePath), legacyContents);

      const launcher = new Launcher(root, state);
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

  it.effect.each([
    {
      name: "a pending update",
      contents:
        '{ "protocol": 2, "activeVersion": "1.0.0", "update": { "id": "u", "fromVersion": "1.0.0", "targetVersion": "1.1.0", "dbPath": "/tmp/state.sqlite", "status": "pending" } }',
    },
    { name: "a future protocol", contents: '{ "protocol": 4, "activeVersion": "1.0.0" }' },
    {
      name: "an older unsupported protocol",
      contents: '{ "protocol": 1, "activeVersion": "1.0.0" }',
    },
    { name: "an invalid version", contents: '{ "protocol": 2, "activeVersion": "latest" }' },
    {
      name: "an install state with extra fields",
      contents: '{ "protocol": 2, "activeVersion": "1.0.0", "extra": true }',
    },
    { name: "malformed JSON", contents: "{ invalid JSON" },
  ] as const)("rejects $name without rewriting the state file", ({ contents }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-service-launcher-reject-" });
      const statePath = path.join(root, "runtime", "service-state.json");
      yield* fs.makeDirectory(path.dirname(statePath), { recursive: true });
      yield* fs.writeFileString(statePath, contents);

      yield* Effect.promise(() =>
        readServiceStateForLauncher(root, statePath).then(
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

  it.effect("does not rewrite a legacy state when its runtime is incomplete", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-service-launcher-missing-" });
      const statePath = path.join(root, "runtime", "service-state.json");
      const contents = '{ "protocol": 2, "activeVersion": "1.0.0" }';
      yield* fs.makeDirectory(path.dirname(statePath), { recursive: true });
      yield* fs.writeFileString(statePath, contents);

      yield* Effect.promise(() =>
        readServiceStateForLauncher(root, statePath).then(
          () => assert.fail("legacy state with a missing runtime was accepted"),
          (error: unknown) => {
            assert.instanceOf(error, Error);
            assert.equal(error.message, "Selected t3@1.0.0 runtime is missing or incomplete.");
          },
        ),
      );
      assert.equal(yield* fs.readFileString(statePath), contents);
    }),
  );

  it.effect("does not rewrite a legacy state when its runtime layout is incomplete", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      for (const scenario of ["missing executable", "mismatched install sentinel"] as const) {
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-service-launcher-layout-" });
        const statePath = path.join(root, "runtime", "service-state.json");
        const version = "1.0.0";
        const versionDir = path.join(root, "runtime", "versions", version);
        const entryPath = yield* writeFakeRuntime(fs, path, versionDir, "process.exit(0);\n");
        const sentinelPath = path.join(versionDir, ".install-complete");
        if (scenario === "missing executable") {
          yield* fs.remove(entryPath);
        } else {
          yield* fs.writeFileString(sentinelPath, "0.9.0\n");
        }
        const contents = `{ "protocol": 2, "activeVersion": "${version}" }`;
        yield* fs.makeDirectory(path.dirname(statePath), { recursive: true });
        yield* fs.writeFileString(statePath, contents);

        yield* Effect.promise(() =>
          readServiceStateForLauncher(root, statePath).then(
            () => assert.fail(`${scenario} was accepted`),
            (error: unknown) => {
              assert.instanceOf(error, Error);
              assert.equal(error.message, "Selected t3@1.0.0 runtime is missing or incomplete.");
            },
          ),
        );
        assert.equal(yield* fs.readFileString(statePath), contents);
      }
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

  it.effect("stays idle instead of exiting when another server owns the T3 home", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-service-refused-" });
      const statePath = path.join(root, "runtime", "service-state.json");
      yield* writeFakeRuntime(
        fs,
        path,
        path.join(root, "runtime", "versions", "1.0.0"),
        `process.exit(${SERVER_EXIT_CODE_STATE_DIR_OWNED});\n`,
      );
      yield* Effect.promise(() =>
        writeServiceState(statePath, {
          protocol: SERVICE_LAUNCHER_PROTOCOL,
          activeVersion: "1.0.0",
        }),
      );
      const refused = Promise.withResolvers<void>();
      yield* Effect.acquireRelease(
        Effect.sync(() =>
          vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
            if (String(chunk).includes("owns this T3 home")) refused.resolve();
            return true;
          }),
        ),
        (spy) => Effect.sync(() => spy.mockRestore()),
      );
      const launcher = new Launcher(root, yield* Effect.promise(() => readServiceState(statePath)));
      let completed = false;
      const running = launcher.run().finally(() => {
        completed = true;
      });
      yield* Effect.promise(() => refused.promise);
      assert.isFalse(completed);
      yield* Effect.promise(() => launcher.stop("SIGTERM"));
      yield* Effect.promise(() => running);
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

  // Migrations on a large database can keep a trial busy for minutes before it
  // reports prepared. Only a trial that stays stuck past the window rolls back.
  it.effect.each([
    { prepares: true, status: "committed", activeVersion: "1.1.0" },
    { prepares: false, status: "rolled-back", activeVersion: "1.0.0" },
  ] as const)(
    "gives a trial the full prepared window (prepares: $prepares)",
    ({ prepares, status, activeVersion }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-service-launcher-slow-" });
        const statePath = path.join(root, "runtime", "service-state.json");
        const databasePath = path.join(root, "userdata", "state.sqlite");
        yield* fs.makeDirectory(path.dirname(databasePath), { recursive: true });
        yield* fs.writeFileString(databasePath, "before trial");
        // The trial stands in for slow migrations: it reports prepared only
        // when the test tells it to.
        const childSource = `
const context = JSON.parse(process.env.T3_SERVICE_LAUNCHER_CONTEXT);
if (context.update?.status !== "pending") process.exit(0);
process.on("message", (message) => {
  if (message.type === "test-prepare") process.send({ type: "prepared", updateId: context.update.id });
  if (message.type === "committed") process.exit(0);
});
setInterval(() => {}, 1_000);
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
            update: {
              id: "update-1",
              fromVersion: "1.0.0",
              targetVersion: "1.1.0",
              dbPath: databasePath,
              status: "pending",
            },
          }),
        );

        // Effect schedules on setImmediate, so faking only timeouts leaves it running.
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        yield* Effect.addFinalizer(() => Effect.sync(() => vi.useRealTimers()));
        const launcher = new Launcher(
          root,
          yield* Effect.promise(() => readServiceState(statePath)),
        );
        // Each run ends when the final active child exits on its own.
        const running = launcher.run().then(
          () => Promise.reject(new Error("launcher unexpectedly completed")),
          () => Promise.resolve(),
        );
        // The prepared timer is armed once the trial has spawned.
        yield* Effect.promise(() =>
          vi.waitFor(() => assert.equal(vi.getTimerCount(), 1), { timeout: 10_000 }),
        );
        yield* Effect.promise(() => vi.advanceTimersByTimeAsync(121_000));
        if (prepares) spawnedChildren.at(-1)!.send({ type: "test-prepare" });
        else yield* Effect.promise(() => vi.advanceTimersByTimeAsync(PREPARED_TIMEOUT_MS));
        yield* Effect.promise(() => running);

        const state = yield* Effect.promise(() => readServiceState(statePath));
        assert.equal(state.activeVersion, activeVersion);
        assert.equal(state.update?.status, status);
        if (!prepares) {
          assert.equal(
            state.update?.status === "rolled-back" ? state.update.reason : undefined,
            "prepared-timeout",
          );
        }
      }),
  );

  it.effect.each(["file", "symlink", "dangling symlink"] as const)(
    "restores the database when a migrating trial exits, with the database a %s",
    (kind) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-service-launcher-db-" });
        const statePath = path.join(root, "runtime", "service-state.json");
        const databasePath = path.join(root, "userdata", "state.sqlite");
        // A symlinked database keeps its link: rollback restores the file it points to,
        // even one the trial left missing, as a crash during a macOS clone restore can.
        // The dangling case reaches its file through a directory link and a relative
        // `..` link, which only resolves correctly by following the directory link.
        const databaseFile =
          kind === "file" ? databasePath : path.join(root, "data", "original.sqlite");
        const linkTarget = kind === "dangling symlink" ? "../original.sqlite" : databaseFile;
        const original = "database before migration";
        yield* fs.makeDirectory(path.dirname(databaseFile), { recursive: true });
        if (kind === "dangling symlink") {
          yield* fs.makeDirectory(path.join(root, "data", "sub"));
          yield* fs.symlink(path.join(root, "data", "sub"), path.dirname(databasePath));
        } else {
          yield* fs.makeDirectory(path.dirname(databasePath), { recursive: true });
        }
        yield* fs.writeFileString(databaseFile, original);
        if (kind !== "file") yield* fs.symlink(linkTarget, databasePath);
        const encodedDatabasePath = JSON.stringify(databasePath);
        const childSource = `
import { realpathSync, unlinkSync, writeFileSync } from "node:fs";
const context = JSON.parse(process.env.T3_SERVICE_LAUNCHER_CONTEXT);
if (context.update?.status === "pending") {
  writeFileSync(context.update.dbPath, "database after migration");
  writeFileSync(context.update.dbPath + "-wal", "trial wal");
  writeFileSync(context.update.dbPath + "-shm", "trial shm");
  ${kind === "dangling symlink" ? "unlinkSync(realpathSync(context.update.dbPath));" : ""}
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

        const launcher = new Launcher(
          root,
          yield* Effect.promise(() => readServiceState(statePath)),
        );
        yield* Effect.promise(() =>
          launcher.run().then(
            () => Promise.reject(new Error("launcher unexpectedly completed")),
            () => Promise.resolve(),
          ),
        );

        const state = yield* Effect.promise(() => readServiceState(statePath));
        assert.equal(state.activeVersion, "1.0.0");
        assert.equal(state.update?.status, "rolled-back");
        assert.equal(yield* fs.readFileString(databaseFile), original);
        if (kind !== "file") assert.equal(yield* fs.readLink(databasePath), linkTarget);
        assert.isFalse(yield* fs.exists(path.join(root, "original.sqlite")));
        assert.isFalse(yield* fs.exists(`${databasePath}-wal`));
        assert.isFalse(yield* fs.exists(`${databasePath}-shm`));
        const updateId = state.update?.id;
        assert.isDefined(updateId);
        assert.isFalse(yield* fs.exists(path.join(root, "runtime", "db-backup", updateId)));
      }),
  );

  const requestRejectedUpdate = (backupSpaceProbe: Partial<BackupSpaceProbe>) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-service-launcher-space-" });
      const statePath = path.join(root, "runtime", "service-state.json");
      const databasePath = path.join(root, "userdata", "state.sqlite");
      const replyPath = path.join(root, "rejection.txt");
      const trialMarker = path.join(root, "trial-started");
      yield* fs.makeDirectory(path.dirname(databasePath), { recursive: true });
      yield* fs.writeFileString(databasePath, "database");
      const encoded = JSON.stringify({ databasePath, replyPath, trialMarker });
      const childSource = `
import { writeFileSync } from "node:fs";
const paths = ${encoded};
const context = JSON.parse(process.env.T3_SERVICE_LAUNCHER_CONTEXT);
if (context.update?.status === "pending") {
  writeFileSync(paths.trialMarker, "started");
  process.exit(1);
} else if (context.update === undefined) {
  process.on("message", (message) => {
    if (message.type === "update-rejected") {
      writeFileSync(paths.replyPath, message.reason);
      process.exit(0);
    }
  });
  process.send({ type: "request-update", targetVersion: "1.1.0", dbPath: paths.databasePath });
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

      const launcher = new Launcher(
        root,
        yield* Effect.promise(() => readServiceState(statePath)),
        { backupSpaceProbe },
      );
      yield* Effect.promise(() =>
        launcher.run().then(
          () => Promise.reject(new Error("launcher unexpectedly completed")),
          () => Promise.resolve(),
        ),
      );

      return {
        reason: yield* fs.readFileString(replyPath),
        trialStarted: yield* fs.exists(trialMarker),
        state: yield* Effect.promise(() => readServiceState(statePath)),
      };
    });

  it.effect("refuses a backup that cannot fit and leaves the server running", () =>
    Effect.gen(function* () {
      const { reason, trialStarted, state } = yield* requestRejectedUpdate({
        readFreeBytes: () => Promise.resolve(0),
        canClone: () => Promise.resolve(true),
      });

      assert.include(reason, "Not enough free disk space");
      assert.include(reason, "The server was not stopped");
      assert.isFalse(trialStarted);
      assert.equal(state.activeVersion, "1.0.0");
      assert.isUndefined(state.update);
    }),
  );

  it.effect("refuses the update when free space cannot be checked", () =>
    Effect.gen(function* () {
      const { reason, trialStarted, state } = yield* requestRejectedUpdate({
        readFreeBytes: () => Promise.reject(new Error("statfs unavailable")),
      });

      assert.include(
        reason,
        "Could not check that the database backup fits before updating: statfs unavailable",
      );
      assert.isFalse(trialStarted);
      assert.equal(state.activeVersion, "1.0.0");
      assert.isUndefined(state.update);
    }),
  );

  it.effect("records no update when the server exits during the backup check", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-service-launcher-exit-" });
      const statePath = path.join(root, "runtime", "service-state.json");
      const databasePath = path.join(root, "userdata", "state.sqlite");
      yield* fs.makeDirectory(path.dirname(databasePath), { recursive: true });
      yield* fs.writeFileString(databasePath, "database");
      const encoded = JSON.stringify({ databasePath });
      const childSource = `
const paths = ${encoded};
process.send({ type: "request-update", targetVersion: "1.1.0", dbPath: paths.databasePath }, () =>
  process.exit(3),
);
setInterval(() => {}, 1_000);
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
      const launcher = new Launcher(
        root,
        yield* Effect.promise(() => readServiceState(statePath)),
        {
          backupSpaceProbe: {
            // Answer only once the server that asked has disconnected.
            readFreeBytes: () => {
              const child = spawnedChildren.at(-1)!;
              return new Promise((resolve) => {
                if (!child.connected) resolve(Number.MAX_SAFE_INTEGER);
                else child.once("disconnect", () => resolve(Number.MAX_SAFE_INTEGER));
              });
            },
          },
        },
      );
      const failure = yield* Effect.promise(() =>
        launcher.run().then(
          () => new Error("launcher unexpectedly completed"),
          (cause: unknown) => cause as Error,
        ),
      );

      assert.include(failure.message, "Active child exited unexpectedly (3)");
      const state = yield* Effect.promise(() => readServiceState(statePath));
      assert.equal(state.activeVersion, "1.0.0");
      assert.isUndefined(state.update);
    }),
  );

  it.effect("checks database backup space against clone or full-copy needs", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-service-launcher-blocker-" });
      const databasePath = path.join(root, "state.sqlite");
      yield* writeSparseFile(databasePath, 10 * 1024 ** 3);
      const check = (free: number, cloneable: boolean) =>
        Effect.promise(() =>
          databaseBackupBlocker(root, databasePath, {
            readFreeBytes: () => Promise.resolve(free),
            canClone: () => Promise.resolve(cloneable),
          }),
        );

      // A full copy fits: no clone needed.
      assert.isUndefined(yield* check(11 * 1024 ** 3, false));
      // A clone needs 10% headroom for the trial's writes, at least 1 GiB.
      assert.isUndefined(yield* check(1.5 * 1024 ** 3, true));
      assert.include((yield* check(0.5 * 1024 ** 3, true)) ?? "", "1.0 GB needed, 0.5 GB free");
      // A filesystem that cannot clone needs room for the full copy.
      const blocker = yield* check(8 * 1024 ** 3, false);
      assert.include(blocker ?? "", "Not enough free disk space");
      assert.include(blocker ?? "", "10.5 GB needed, 8.0 GB free");
      assert.include(blocker ?? "", "The server was not stopped");
    }),
  );

  it.effect("fails the backup check when the database cannot be inspected", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-service-launcher-blocker-" });
      const error = yield* Effect.promise(() =>
        databaseBackupBlocker(root, path.join(root, "missing.sqlite"), {
          readFreeBytes: () => Promise.resolve(0),
        }).then(
          () => undefined,
          (cause: unknown) => cause,
        ),
      );
      assert.equal((error as NodeJS.ErrnoException | undefined)?.code, "ENOENT");
    }),
  );

  it.effect("recognizes a clone into the backup directory on this filesystem", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-service-launcher-clone-" });
      const databasePath = path.join(root, "userdata", "state.sqlite");
      yield* fs.makeDirectory(path.dirname(databasePath), { recursive: true });
      yield* fs.writeFileString(databasePath, "database");
      // With no free space, the result shows which requirement applied.
      const blocker = yield* Effect.promise(() =>
        databaseBackupBlocker(root, databasePath, { readFreeBytes: () => Promise.resolve(0) }),
      );
      // A tiny database: 1.0 GB is the clone minimum, 0.0 GB the full copy. The
      // macOS temp directory is on APFS, so the clone requirement applies there.
      assert.include(
        blocker ?? "",
        // oxlint-disable-next-line t3code/no-global-process-runtime -- mirrors the standalone launcher's own platform check.
        process.platform === "darwin" ? "1.0 GB needed, 0.0 GB free" : "GB needed, 0.0 GB free",
      );
      // Linux probes leave nothing behind in the backup directory.
      assert.deepEqual(yield* fs.readDirectory(path.join(root, "runtime", "db-backup")), []);
    }),
  );
});
