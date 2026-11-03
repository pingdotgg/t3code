// @effect-diagnostics-next-line nodeBuiltinImport:off - observes the children the launcher spawns with Node built-ins.
import type * as NodeChildProcess from "node:child_process";
// @effect-diagnostics-next-line nodeBuiltinImport:off - models the service manager reading disk through the launcher's Promise callback.
import * as NodeFSP from "node:fs/promises";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { SERVER_EXIT_CODE_STATE_DIR_OWNED } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { vi } from "vite-plus/test";

import { renderBootServicePlist, renderBootServiceUnit } from "./cloud/bootService.ts";
import {
  databaseBackupBlocker,
  Launcher,
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

const unitPlan = (root: string, version: string) => ({
  program: [`${root}/runtime/versions/${version}/t3`, "__service-launcher"],
  baseDir: root,
  logPath: `${root}/logs/boot-service.log`,
  unitPath: `${root}/unit/t3code.service`,
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

const fakeServiceUnit = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  root: string,
  version: string,
  render = renderBootServiceUnit,
) =>
  Effect.gen(function* () {
    const plan = unitPlan(root, version);
    yield* fs.makeDirectory(path.dirname(plan.unitPath), { recursive: true });
    const contents = render(plan);
    yield* fs.writeFileString(plan.unitPath, contents);
    const unit = {
      path: plan.unitPath,
      reloads: 0,
      loadedContents: contents,
      failReload: false,
      reload: async () => {
        unit.reloads += 1;
        if (unit.failReload) throw new Error("daemon-reload failed");
        unit.loadedContents = await NodeFSP.readFile(unit.path, "utf8");
      },
    };
    return unit;
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

  it.effect.each([
    { unitVersion: "1.0.0", replacement: "an intentional downgrade" },
    { unitVersion: "1.2.0", replacement: "another T3 home" },
  ])(
    "recovers a rolled-back update with unit $unitVersion and preserves $replacement",
    ({ unitVersion, replacement }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-service-launcher-repoint-" });
        const statePath = path.join(root, "runtime", "service-state.json");
        yield* writeFakeRuntime(
          fs,
          path,
          path.join(root, "runtime", "versions", "1.1.0"),
          "setInterval(() => {}, 1_000);\n",
        );
        yield* Effect.promise(() =>
          writeServiceState(statePath, {
            protocol: SERVICE_LAUNCHER_PROTOCOL,
            activeVersion: "1.1.0",
            update: {
              id: "update-1",
              fromVersion: "1.1.0",
              targetVersion: "1.2.0",
              status: "rolled-back",
            },
          }),
        );
        const unit = yield* fakeServiceUnit(fs, path, root, unitVersion);
        const expected = renderBootServiceUnit(
          unitPlan(root, unitVersion === "1.0.0" ? "1.1.0" : unitVersion),
        );
        const createLauncher = Effect.gen(function* () {
          return new Launcher(root, yield* Effect.promise(() => readServiceState(statePath)), {
            serviceUnit: unit,
          });
        });
        const run = (launcher: Launcher) =>
          Effect.gen(function* () {
            const running = launcher.run();
            yield* Effect.promise(() => launcher.stop("SIGTERM"));
            yield* Effect.promise(() => running);
          });

        yield* run(yield* createLauncher);
        assert.equal(yield* fs.readFileString(unit.path), expected);
        assert.equal(unit.loadedContents, expected);

        yield* run(yield* createLauncher);
        assert.equal(yield* fs.readFileString(unit.path), expected);
        assert.equal(unit.loadedContents, expected);

        yield* Effect.promise(() =>
          writeServiceState(statePath, {
            protocol: SERVICE_LAUNCHER_PROTOCOL,
            activeVersion: "1.1.0",
            update: {
              id: "update-2",
              fromVersion: "1.0.0",
              targetVersion: "1.1.0",
              status: "committed",
            },
          }),
        );
        const staleLauncher = yield* createLauncher;
        // A local install can replace the selection or service owner without stopping this launcher.
        const selectedRoot =
          replacement === "another T3 home" ? path.join(root, "other-home") : root;
        yield* writeFakeRuntime(
          fs,
          path,
          path.join(selectedRoot, "runtime", "versions", "1.0.0"),
          "setInterval(() => {}, 1_000);\n",
        );
        const selectedStatePath = path.join(selectedRoot, "runtime", "service-state.json");
        yield* Effect.promise(() =>
          writeServiceState(selectedStatePath, {
            protocol: SERVICE_LAUNCHER_PROTOCOL,
            activeVersion: "1.0.0",
          }),
        );
        const selectedUnit = renderBootServiceUnit({
          ...unitPlan(selectedRoot, "1.0.0"),
          unitPath: unit.path,
        });
        yield* fs.writeFileString(unit.path, selectedUnit);
        yield* Effect.promise(() => unit.reload());
        const oldHomeState = yield* fs.readFileString(statePath);
        const selectedState = yield* fs.readFileString(selectedStatePath);

        yield* run(staleLauncher);
        assert.equal(yield* fs.readFileString(statePath), oldHomeState);
        assert.equal(yield* fs.readFileString(selectedStatePath), selectedState);
        assert.equal(yield* fs.readFileString(unit.path), selectedUnit, replacement);
        assert.equal(unit.loadedContents, selectedUnit, replacement);
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

  const commitUpdate = (
    render = renderBootServiceUnit,
    missingUnit = false,
    legacyInstall = false,
  ) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-service 100% & <test>-" });
      const statePath = path.join(root, "runtime", "service-state.json");
      const databasePath = path.join(root, "userdata", "state.sqlite");
      const activatedPath = path.join(root, "activated");
      yield* fs.makeDirectory(path.dirname(databasePath), { recursive: true });
      yield* fs.writeFileString(databasePath, "before trial");
      const unit = yield* fakeServiceUnit(fs, path, root, "1.0.0", render);
      if (missingUnit) yield* fs.remove(unit.path);
      const childSource = `
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
const context = JSON.parse(process.env.T3_SERVICE_LAUNCHER_CONTEXT);
assert.equal(context.protocol, ${SERVICE_LAUNCHER_PROTOCOL});
if (context.update?.status === "pending") {
  const state = JSON.parse(readFileSync(${JSON.stringify(statePath)}, "utf8"));
  assert.equal(state.activeVersion, "1.0.0");
  assert.equal(state.update.status, "pending");
  ${
    missingUnit
      ? `assert.equal(existsSync(${JSON.stringify(unit.path)}), false);`
      : `assert.equal(readFileSync(${JSON.stringify(unit.path)}, "utf8"), ${JSON.stringify(unit.loadedContents)});`
  }
  process.on("message", (message) => {
    if (message.type === "committed") {
      const state = JSON.parse(readFileSync(${JSON.stringify(statePath)}, "utf8"));
      assert.equal(state.protocol, ${SERVICE_LAUNCHER_PROTOCOL});
      assert.equal(state.activeVersion, "1.1.0");
      assert.equal(state.update.status, "committed");
      writeFileSync(${JSON.stringify(activatedPath)}, message.updateId);
      process.exit(0);
    }
  });
  process.send({ type: "prepared", updateId: context.update.id });
} else if (context.update === undefined) {
  process.send({ type: "request-update", targetVersion: "1.1.0", dbPath: ${JSON.stringify(databasePath)} });
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
      // The old CLI installs the new runtime but writes state with its own protocol.
      yield* fs.writeFileString(
        statePath,
        `${JSON.stringify(
          {
            protocol: legacyInstall ? 3 : SERVICE_LAUNCHER_PROTOCOL,
            activeVersion: "1.0.0",
          },
          null,
          2,
        )}\n`,
      );
      const launcher = new Launcher(
        root,
        yield* Effect.promise(() => readServiceState(statePath)),
        { serviceUnit: unit },
      );
      const failure = yield* Effect.promise(() =>
        launcher.run().then(
          () => "launcher unexpectedly completed",
          (cause: unknown) => String(cause),
        ),
      );
      assert.include(failure, "Active child exited unexpectedly (0)");
      const state = yield* Effect.promise(() => readServiceState(statePath));
      assert.equal(state.activeVersion, "1.1.0");
      assert.equal(state.update?.status, "committed");
      assert.equal(yield* fs.readFileString(activatedPath), state.update?.id);
      const recover = () =>
        Effect.gen(function* () {
          const fresh = new Launcher(
            root,
            yield* Effect.promise(() => readServiceState(statePath)),
            { serviceUnit: unit },
          );
          const running = fresh.run();
          yield* Effect.promise(() => fresh.stop("SIGTERM"));
          yield* Effect.promise(() => running);
        });
      return { fs, root, unit, recover };
    });

  it.effect.each([
    {
      name: "systemd after a protocol-3 local upgrade",
      render: renderBootServiceUnit,
      legacyInstall: true,
    },
    {
      name: "launchd",
      legacyInstall: false,
      render: (plan: Parameters<typeof renderBootServicePlist>[0]) =>
        renderBootServicePlist(plan, {
          homeDir: "/Users/test & <user>",
          environmentPath: "/usr/bin:/custom/runtime/versions/1.0.0",
        }),
    },
  ])(
    "commits and repoints $name only after the trial reports prepared",
    ({ render, legacyInstall }) =>
      Effect.gen(function* () {
        const { fs, root, unit } = yield* commitUpdate(render, false, legacyInstall);
        const expected = render(unitPlan(root, "1.1.0"));
        assert.equal(yield* fs.readFileString(unit.path), expected);
        assert.equal(unit.loadedContents, expected);
        assert.equal(unit.reloads, 1);
      }),
  );

  it.effect(
    "keeps a durable commit through unit failure and retries a failed reload on restart",
    () =>
      Effect.gen(function* () {
        const { fs, root, unit, recover } = yield* commitUpdate(renderBootServiceUnit, true);
        assert.equal(unit.reloads, 0);
        const original = renderBootServiceUnit(unitPlan(root, "1.0.0"));
        const expected = renderBootServiceUnit(unitPlan(root, "1.1.0"));
        assert.equal(unit.loadedContents, original);
        yield* fs.writeFileString(unit.path, original);
        unit.failReload = true;
        yield* recover();
        assert.equal(yield* fs.readFileString(unit.path), expected);
        assert.equal(unit.reloads, 1);
        assert.equal(unit.loadedContents, original);

        unit.failReload = false;
        yield* recover();
        assert.equal(yield* fs.readFileString(unit.path), expected);
        assert.equal(unit.loadedContents, expected);
        assert.equal(unit.reloads, 2);
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
      const unit = yield* fakeServiceUnit(fs, path, root, "0.9.0");

      const launcher = new Launcher(
        root,
        yield* Effect.promise(() => readServiceState(statePath)),
        {
          serviceUnit: unit,
          environment: yield* Effect.promise(() => readServiceEnvironment(root)),
        },
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
      assert.equal(
        yield* fs.readFileString(unit.path),
        renderBootServiceUnit(unitPlan(root, "1.0.0")),
      );
      assert.equal(unit.reloads, 1);
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
      assert.equal(process.env.T3CODE_TEST_SERVICE_TOKEN, "inherited");
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
      assert.include(blocker ?? "", "10.5 GB needed, 8.0 GB free");
      assert.include(blocker ?? "", "The server was not stopped");
    }),
  );
});
