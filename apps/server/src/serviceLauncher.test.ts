// @effect-diagnostics-next-line nodeBuiltinImport:off - observes the children the launcher spawns with Node built-ins.
import type * as NodeChildProcess from "node:child_process";
// @effect-diagnostics-next-line nodeBuiltinImport:off - the free-space probe is a plain Promise callback.
import * as NodeFS from "node:fs";
import * as NodeSqlite from "node:sqlite";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { SERVER_EXIT_CODE_STATE_DIR_OWNED } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { vi } from "vite-plus/test";

import {
  databaseBackupBlocker,
  Launcher,
  main,
  readServiceEnvironment,
  type BackupSpaceProbe,
  readServiceState,
  writeServiceState,
} from "./serviceLauncher.ts";
import {
  compareExactServiceVersions,
  decodeServiceState,
  isExactServiceVersion,
  SERVICE_ENV_FILE,
  SERVICE_LAUNCHER_PROTOCOL,
  SERVICE_RESTART_PENDING_FILE,
} from "./cloud/serviceProtocol.ts";

const spawnedChildren = vi.hoisted((): Array<NodeChildProcess.ChildProcess> => []);

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeChildProcess>();
  const spawn = (...args: Parameters<typeof actual.spawn>) => {
    const child = actual.spawn(...args);
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
  it.effect(
    "loads optional service.env literally without changing inherited or managed variables",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-service-env-" });
        const inherited = Object.freeze({
          PATH: "inherited-path",
          T3CODE_HOME: root,
          T3_BOOT_SERVICE_UNIT: "managed-unit",
          T3_SERVICE_LAUNCHER_CONTEXT: "managed-context",
          T3CODE_PORT: "ambient",
        });
        assert.deepEqual(
          yield* Effect.promise(() => readServiceEnvironment(root, inherited)),
          inherited,
        );
        yield* fs.writeFileString(
          path.join(root, SERVICE_ENV_FILE),
          [
            "# service configuration",
            "export T3CODE_PORT=1234 # inline comment",
            'T3CODE_TOKEN="literal $HOME ${USER} $(whoami) # token"',
            'MULTILINE="first\nsecond"',
            "EMPTY=",
            "PATH=/bad",
            "Path=/bad",
            "T3CODE_HOME=/bad",
            "t3code_home=/bad",
            "T3_BOOT_SERVICE_UNIT=bad",
            "t3_boot_service_unit=bad",
            "T3_SERVICE_LAUNCHER_CONTEXT=bad",
            "t3_service_launcher_context=bad",
          ].join("\n"),
        );
        assert.deepEqual(yield* Effect.promise(() => readServiceEnvironment(root, inherited)), {
          ...inherited,
          T3CODE_PORT: "1234",
          T3CODE_TOKEN: "literal $HOME ${USER} $(whoami) # token",
          MULTILINE: "first\nsecond",
          EMPTY: "",
        });
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

      yield* fs.writeFileString(restartPending, "1.0.1\n");
      yield* run();
      assert.isTrue(yield* fs.exists(restartPending));

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

  it.effect("rolls back invalid trials with the startup environment", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-service-launcher-rollback-" });
      const statePath = path.join(root, "runtime", "service-state.json");
      const databasePath = path.join(root, "userdata", "state.sqlite");
      const observationsPath = path.join(root, "environment-observations.jsonl");
      const envPath = path.join(root, SERVICE_ENV_FILE);
      yield* fs.writeFileString(envPath, "T3CODE_TEST_SERVICE_TOKEN=initial\n");
      vi.stubEnv("T3CODE_HOME", root);
      vi.stubEnv("T3CODE_TEST_SERVICE_TOKEN", "inherited");
      yield* Effect.addFinalizer(() => Effect.sync(() => vi.unstubAllEnvs()));
      yield* fs.makeDirectory(path.dirname(databasePath), { recursive: true });
      yield* fs.writeFileString(databasePath, "before trial");
      const encodedDatabasePath = JSON.stringify(databasePath);
      const childSource = `
import { appendFileSync, writeFileSync } from "node:fs";
const context = JSON.parse(process.env.T3_SERVICE_LAUNCHER_CONTEXT);
appendFileSync(${JSON.stringify(observationsPath)}, JSON.stringify({
  token: process.env.T3CODE_TEST_SERVICE_TOKEN,
  update: context.update?.status ?? "active",
}) + "\\n");
if (context.update?.status === "pending") {
  process.send({ type: "prepared", updateId: "wrong-update" });
} else if (context.update === undefined) {
  writeFileSync(${JSON.stringify(envPath)}, "T3CODE_TEST_SERVICE_TOKEN=changed\\n");
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

      yield* Effect.promise(() =>
        main().then(
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
      const observations = (yield* fs.readFileString(observationsPath))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      assert.deepEqual(observations, [
        { token: "initial", update: "active" },
        { token: "initial", update: "pending" },
        { token: "initial", update: "rolled-back" },
      ]);
      assert.equal((yield* HostProcess.Environment).T3CODE_TEST_SERVICE_TOKEN, "inherited");
      assert.equal(yield* fs.readFileString(envPath), "T3CODE_TEST_SERVICE_TOKEN=changed\n");
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

  it.effect.each(["wal", "delete"] as const)(
    "backs up a %s-mode database (online when WAL) and restores its final state",
    (journalMode) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-service-launcher-online-" });
        const statePath = path.join(root, "runtime", "service-state.json");
        const databasePath = path.join(root, "userdata", "state.sqlite");
        const observationsPath = path.join(root, "observations.json");
        yield* fs.makeDirectory(path.dirname(databasePath), { recursive: true });
        const seed = new NodeSqlite.DatabaseSync(databasePath);
        seed.exec(`
        PRAGMA journal_mode = ${journalMode};
        CREATE TABLE events (id INTEGER PRIMARY KEY, payload TEXT NOT NULL);
        WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 500)
        INSERT INTO events (payload) SELECT 'before the update ' || i FROM n;
      `);
        seed.close();

        const encoded = JSON.stringify({ root, databasePath, observationsPath, journalMode });
        const childSource = `
import { readdirSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
const paths = ${encoded};
const context = JSON.parse(process.env.T3_SERVICE_LAUNCHER_CONTEXT);
if (context.update?.status === "pending") {
  writeFileSync(paths.observationsPath + ".trial", JSON.stringify(
    readdirSync(paths.root + "/runtime/db-backup/" + context.update.id).sort(),
  ));
  writeFileSync(context.update.dbPath, "database after migration");
  writeFileSync(context.update.dbPath + "-wal", "trial wal");
  process.exit(1);
} else if (context.update === undefined) {
  const db = new DatabaseSync(paths.databasePath);
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec("PRAGMA journal_mode = " + paths.journalMode + ";");
  const insert = db.prepare("INSERT INTO events (payload) VALUES (?)");
  const writer = setInterval(() => insert.run("written while serving"), 1);
  process.once("SIGTERM", () => {
    clearInterval(writer);
    insert.run("last write before stopping");
    const backupRoot = paths.root + "/runtime/db-backup";
    writeFileSync(paths.observationsPath, JSON.stringify({
      backupsAtStop: readdirSync(backupRoot).map((entry) => readdirSync(backupRoot + "/" + entry)),
      rows: db.prepare("SELECT count(*) AS n FROM events").get().n,
    }));
    db.close();
    process.exit(0);
  });
  process.send({ type: "request-update", targetVersion: "1.1.0", dbPath: paths.databasePath });
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
          {
            backupSpaceProbe: { canClone: async () => false },
          },
        );
        yield* Effect.promise(() =>
          launcher.run().then(
            () => Promise.reject(new Error("launcher unexpectedly completed")),
            () => Promise.resolve(),
          ),
        );

        const state = yield* Effect.promise(() => readServiceState(statePath));
        assert.equal(state.update?.status, "rolled-back");
        const observed = JSON.parse(yield* fs.readFileString(observationsPath));
        // A WAL database's main file is copied before the server is asked to stop; others fall back offline.
        assert.deepEqual(observed.backupsAtStop, journalMode === "wal" ? [["database"]] : []);
        assert.isAbove(observed.rows, 501);
        // Only the online copy holds no -shm: the offline fallback copies the one the server left.
        assert.deepEqual(
          JSON.parse(yield* fs.readFileString(`${observationsPath}.trial`)),
          journalMode === "wal" ? ["database", "database-wal"] : ["database"],
        );
        const restored = new NodeSqlite.DatabaseSync(databasePath);
        try {
          assert.equal(restored.prepare("PRAGMA integrity_check").get()?.integrity_check, "ok");
          assert.equal(
            restored.prepare("SELECT count(*) AS n FROM events").get()?.n,
            observed.rows,
          );
          assert.equal(
            restored
              .prepare(
                "SELECT count(*) AS n FROM events WHERE payload = 'last write before stopping'",
              )
              .get()?.n,
            1,
          );
        } finally {
          restored.close();
        }
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

  it.effect("reclaims partial backups left by killed updates before checking space", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-service-launcher-orphan-" });
      const databasePath = path.join(root, "state.sqlite");
      yield* writeSparseFile(databasePath, 10 * 1024 ** 3);
      const backupRoot = path.join(root, "runtime", "db-backup");
      const orphan = path.join(backupRoot, "earlier-update.staging");
      const completed = path.join(backupRoot, "completed-update");
      yield* fs.makeDirectory(orphan, { recursive: true });
      yield* fs.writeFileString(path.join(orphan, "database"), "partial copy");
      yield* fs.makeDirectory(completed);
      yield* fs.writeFileString(path.join(completed, "database"), "complete copy");

      // The orphan is what keeps this disk too full for a full copy.
      const blocker = yield* Effect.promise(() =>
        databaseBackupBlocker(root, databasePath, {
          readFreeBytes: () => Promise.resolve((NodeFS.existsSync(orphan) ? 8 : 11) * 1024 ** 3),
          canClone: () => Promise.resolve(false),
        }),
      );

      assert.isUndefined(blocker);
      assert.isFalse(yield* fs.exists(orphan));
      assert.isTrue(yield* fs.exists(path.join(completed, "database")));
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

      assert.isUndefined(yield* check(11 * 1024 ** 3, false));
      assert.isUndefined(yield* check(1.5 * 1024 ** 3, true));
      assert.include((yield* check(0.5 * 1024 ** 3, true)) ?? "", "1.0 GB needed, 0.5 GB free");
      const blocker = yield* check(8 * 1024 ** 3, false);
      assert.include(blocker ?? "", "Not enough free disk space");
      assert.include(blocker ?? "", "10.8 GB needed, 8.0 GB free");
      assert.include(blocker ?? "", "The server was not stopped");
    }),
  );
});
