// @effect-diagnostics-next-line nodeBuiltinImport:off - observes the children the launcher spawns with Node built-ins.
import * as NodeChildProcess from "node:child_process";
// @effect-diagnostics-next-line nodeBuiltinImport:off - the free-space probe is a plain Promise callback.
import * as NodeFS from "node:fs";
// @effect-diagnostics-next-line nodeBuiltinImport:off - models the service manager reading disk through the launcher's Promise callback.
import * as NodeFSP from "node:fs/promises";
import * as NodeSqlite from "node:sqlite";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { SERVER_EXIT_CODE_STATE_DIR_OWNED } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type * as Scope from "effect/Scope";
import { vi } from "vite-plus/test";

import {
  renderBootServicePlist,
  renderBootServiceTask,
  renderBootServiceUnit,
} from "./cloud/bootService.ts";
import {
  databaseBackupBlocker,
  isPrivateWindowsControlSddl,
  isServiceControlLauncherMismatchError,
  isServiceControlUnauthorizedError,
  Launcher,
  main,
  probeControlLockHeld,
  probeServiceLauncher,
  queryServiceLauncherId,
  readServiceEnvironment,
  recoverServiceLauncherUninstall,
  type BackupSpaceProbe,
  type ControlAclHooks,
  readServiceState,
  requestServiceLauncherStop,
  serviceControlDir,
  serviceTaskName,
  serviceTaskNamePath,
  signalServiceLauncherStop,
  stageServiceLauncherInstall,
  waitForServiceLauncherRelease,
  windowsSystem32Binary,
  writeServiceState,
} from "./serviceLauncher.ts";
import { ServiceLauncherClientError } from "./cloud/serviceLauncherClient.ts";
import {
  compareExactServiceVersions,
  decodeServiceState,
  isExactServiceVersion,
  SERVER_OWNER_LEASE_FILE,
  SERVICE_ENV_FILE,
  SERVICE_LAUNCHER_PROTOCOL,
  SERVICE_RESTART_PENDING_FILE,
  SERVICE_STOP_MARKER_FILE,
  serviceUnitBaseDirOf,
} from "./cloud/serviceProtocol.ts";

const trustedTestAcl: ControlAclHooks = {
  restrictPathAcl: async () => undefined,
  verifyPathAcl: async () => true,
};

const spawnedChildren = vi.hoisted((): Array<NodeChildProcess.ChildProcess> => []);

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeChildProcess>();
  const spawn = (...args: Parameters<typeof actual.spawn>) => {
    const [command, spawnArgs, spawnOptions] = args;
    const child =
      (command.endsWith("\\t3.exe") || command.endsWith("/t3.exe")) && Array.isArray(spawnArgs)
        ? actual.spawn(
            process.execPath,
            [command, ...(spawnArgs as ReadonlyArray<string>)],
            (spawnOptions as NodeChildProcess.SpawnOptions | undefined) ?? {},
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

  assert.isUndefined(
    decodeServiceState({
      protocol: SERVICE_LAUNCHER_PROTOCOL,
      activeVersion: "1.0.0",
      update: {
        id: "../escape",
        fromVersion: "1.0.0",
        targetVersion: "1.1.0",
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
        id: "update-relative",
        fromVersion: "1.0.0",
        targetVersion: "1.1.0",
        dbPath: "relative/state.sqlite",
        status: "pending",
      },
    }),
  );
});

it("unescapes Windows task XML entities in a single pass and rejects environment expansion", () => {
  const literalAmpDir = "C:\\Users\\R&amp;D\\.t3";
  const rendered = renderBootServiceTask(
    {
      program: [`${literalAmpDir}\\runtime\\versions\\1.0.0\\t3.exe`, "__service-launcher"],
      baseDir: literalAmpDir,
      logPath: `${literalAmpDir}\\logs\\boot-service.log`,
      unitPath: `${literalAmpDir}\\unit\\t3code.xml`,
    },
    {
      homeDir: "C:\\Users\\R&amp;D",
      userId: "PC\\theo",
      conhostPath: "C:\\Windows\\System32\\conhost.exe",
    },
  );
  assert.equal(serviceUnitBaseDirOf(rendered), literalAmpDir);
  assert.equal(
    serviceUnitBaseDirOf(rendered.replaceAll("&amp;", "&#38;")),
    literalAmpDir,
    "numeric &#38;amp; emitted by Task Scheduler must decode to literal &amp;, not &",
  );
  assert.isUndefined(
    serviceUnitBaseDirOf(
      '<Task><Actions><Exec><Arguments>--headless -- "C:\\t3.exe" __service-launcher --base-dir "%LOCALAPPDATA%\\t3"</Arguments></Exec></Actions></Task>',
    ),
  );
});

it("disambiguates Windows task names, System32 paths, and account-private control directories", () => {
  assert.notEqual(serviceTaskName("a-b", "c"), serviceTaskName("a", "b-c"));
  assert.notEqual(serviceTaskName("", "a-b"), serviceTaskName("a", "b"));
  assert.equal(serviceTaskName("PC", "Theo").slice(-8), serviceTaskName("pc", "theo").slice(-8));
  assert.equal(
    windowsSystem32Binary("schtasks.exe", { SystemRoot: "D:\\Win" }),
    "D:\\Win\\System32\\schtasks.exe",
  );
  assert.equal(
    serviceControlDir("/local", "/Homes/Theo/.T3", { caseInsensitive: true }),
    serviceControlDir("/local", "/homes/theo/.t3", { caseInsensitive: true }),
  );
  assert.notEqual(
    serviceControlDir("/local", "/Homes/Theo/.T3", { caseInsensitive: false }),
    serviceControlDir("/local", "/homes/theo/.t3", { caseInsensitive: false }),
  );
});

it("verifies owner-bound, protected Windows SDDL descriptors for files and directories", () => {
  const userSid = "S-1-5-21-100-200-300-1001";
  const otherSid = "S-1-5-21-100-200-300-9999";
  assert.isTrue(
    isPrivateWindowsControlSddl(
      `O:${userSid}G:${userSid}D:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;${userSid})S:AI(ML;;NW;;;HI)`,
      userSid,
    ),
  );
  assert.isTrue(
    isPrivateWindowsControlSddl(
      `O:BAG:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;${userSid})`,
      userSid,
      { isDirectory: true },
    ),
  );
  assert.isFalse(
    isPrivateWindowsControlSddl(
      `O:${userSid}D:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;${userSid})`,
      userSid,
      { isDirectory: true },
    ),
    "directory user ACE without OI+CI inheritance flags must be rejected",
  );
  assert.isFalse(
    isPrivateWindowsControlSddl(
      `O:${otherSid}G:${otherSid}D:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;${userSid})`,
      userSid,
    ),
    "foreign file owner must be rejected even when DACL grants only trusted SIDs",
  );
  assert.isFalse(
    isPrivateWindowsControlSddl(`O:${userSid}D:P(A;;FA;;;OW)(A;;FA;;;${userSid})`, userSid),
    "OWNER RIGHTS (OW) trustee must be rejected",
  );
  assert.isFalse(
    isPrivateWindowsControlSddl(`O:${userSid}D:P(A;;FA;;;S-1-3-4)(A;;FA;;;${userSid})`, userSid),
    "OWNER RIGHTS (S-1-3-4) trustee must be rejected",
  );
  assert.isFalse(
    isPrivateWindowsControlSddl(`D:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;${userSid})`, userSid),
    "SDDL missing an O: owner section must be rejected",
  );
  assert.isFalse(
    isPrivateWindowsControlSddl(`O:${userSid}D:AI(A;;FA;;;SY)(A;;FA;;;${userSid})`, userSid),
    "inherited DACL without D:P must be rejected",
  );
  assert.isFalse(
    isPrivateWindowsControlSddl(`O:${userSid}D:PAI(A;;FA;;;BU)(A;;FA;;;${userSid})`, userSid),
    "Users group allow ACE must be rejected",
  );
  assert.isFalse(
    isPrivateWindowsControlSddl(`O:${userSid}D:PAI(A;;FA;;;SY)(A;;FA;;;BA)`, userSid),
    "DACL missing an explicit current-user full-control ACE must be rejected",
  );
  const localAdminSid = "S-1-5-21-100-200-300-500";
  assert.isTrue(
    isPrivateWindowsControlSddl(
      "O:LAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;LA)",
      localAdminSid,
      { isDirectory: true, allowLocalAdminAlias: true },
    ),
    "built-in local Administrator SDDL alias LA must be accepted when SID matches local LA",
  );
  assert.isFalse(
    isPrivateWindowsControlSddl(
      "O:LAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;LA)",
      userSid,
      { isDirectory: true, allowLocalAdminAlias: false },
    ),
    "LA alias must be rejected for non-Administrator accounts",
  );
});

const unitPlan = (root: string, version: string, unitFile = "t3code.service") => ({
  program: [
    `${root}/runtime/versions/${version}/${unitFile.endsWith(".xml") ? "t3.exe" : "t3"}`,
    "__service-launcher",
  ],
  baseDir: root,
  logPath: `${root}/logs/boot-service.log`,
  unitPath: `${root}/unit/${unitFile}`,
});

const writeFakeRuntime = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  versionDir: string,
  childSource: string,
) =>
  Effect.gen(function* () {
    const entryPath = path.join(versionDir, path.sep === "\\" ? "t3.exe" : "t3");
    yield* fs.makeDirectory(versionDir, { recursive: true });
    yield* fs.writeFileString(
      entryPath,
      path.sep === "\\" ? childSource : `#!${process.execPath}\n${childSource}`,
    );
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
  unitFile = "t3code.service",
) =>
  Effect.gen(function* () {
    const plan = unitPlan(root, version, unitFile);
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

const runNode = <A, E>(effect: Effect.Effect<A, E, NodeServices.NodeServices | Scope.Scope>) =>
  Effect.scoped(effect).pipe(Effect.provide(NodeServices.layer));

describe("service state persistence", () => {
  it.live(
    "loads optional service.env literally without changing inherited or managed variables",
    () =>
      runNode(
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
      ),
  );

  it.live("a fresh launcher clears a restart deferred by t3 update", () =>
    runNode(
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
    ),
  );

  it.live.each([
    { unitVersion: "1.0.0", replacement: "an intentional downgrade" },
    { unitVersion: "1.2.0", replacement: "another T3 home" },
  ])(
    "recovers a rolled-back update with unit $unitVersion and preserves $replacement",
    ({ unitVersion, replacement }) =>
      runNode(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const root = yield* fs.makeTempDirectoryScoped({
            prefix: "t3-service-launcher-repoint-",
          });
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
      ),
  );

  it.live("stays idle instead of exiting when another server owns the T3 home", () =>
    runNode(
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
        const launcher = new Launcher(
          root,
          yield* Effect.promise(() => readServiceState(statePath)),
        );
        let completed = false;
        const running = launcher.run().finally(() => {
          completed = true;
        });
        yield* Effect.promise(() => refused.promise);
        assert.isFalse(completed);
        yield* Effect.promise(() => launcher.stop("SIGTERM"));
        yield* Effect.promise(() => running);
      }),
    ),
  );

  const commitUpdate = (
    render = renderBootServiceUnit,
    missingUnit = false,
    legacyInstall = false,
    unitFile = "t3code.service",
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
      const unit = yield* fakeServiceUnit(fs, path, root, "1.0.0", render, unitFile);
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

  it.live.each([
    {
      name: "systemd after a protocol-3 local upgrade",
      render: renderBootServiceUnit,
      legacyInstall: true,
      unitFile: "t3code.service",
    },
    {
      name: "launchd",
      legacyInstall: false,
      unitFile: "com.t3tools.t3code.service.plist",
      render: (plan: Parameters<typeof renderBootServicePlist>[0]) =>
        renderBootServicePlist(plan, {
          homeDir: "/Users/test & <user>",
          environmentPath: "/usr/bin:/custom/runtime/versions/1.0.0",
        }),
    },
    {
      name: "Windows Task Scheduler",
      legacyInstall: false,
      unitFile: "t3code-task.xml",
      render: (plan: Parameters<typeof renderBootServiceTask>[0]) =>
        renderBootServiceTask(plan, {
          userId: "PC\\theo",
          homeDir: "C:\\Users\\theo & <user>",
          conhostPath: "C:\\Windows\\System32\\conhost.exe",
        }),
    },
  ])(
    "commits and repoints $name only after the trial reports prepared",
    ({ render, legacyInstall, unitFile }) =>
      runNode(
        Effect.gen(function* () {
          const { fs, root, unit } = yield* commitUpdate(render, false, legacyInstall, unitFile);
          const expected = render(unitPlan(root, "1.1.0", unitFile));
          assert.equal(yield* fs.readFileString(unit.path), expected);
          assert.equal(unit.loadedContents, expected);
          assert.equal(unit.reloads, 1);
        }),
      ),
  );

  it.live(
    "keeps a durable commit through unit failure and retries a failed reload on restart",
    () =>
      runNode(
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
      ),
  );

  it.live("rolls back invalid trials with the startup environment", () =>
    runNode(
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
        assert.equal((yield* HostProcess.Environment).T3CODE_TEST_SERVICE_TOKEN, "inherited");
        assert.equal(yield* fs.readFileString(envPath), "T3CODE_TEST_SERVICE_TOKEN=changed\n");
      }),
    ),
  );

  it.live.each(["file", "symlink", "dangling symlink"] as const)(
    "restores the database when a migrating trial exits, with the database a %s",
    (kind) =>
      runNode(
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
      ),
  );

  it.live.each(["wal", "delete"] as const)(
    "backs up a %s-mode database (online when WAL) and restores its final state",
    (journalMode) =>
      runNode(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-service-launcher-online-" });
          const statePath = path.join(root, "runtime", "service-state.json");
          const databasePath = path.join(root, "userdata", "state.sqlite");
          const observationsPath = path.join(root, "observations.json");
          yield* fs.makeDirectory(path.dirname(databasePath), { recursive: true });
          // SQLite keeps -wal beside the symlink's target, so the backup must restore it there.
          yield* fs.symlink("actual.sqlite", databasePath);
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
  const trial = new DatabaseSync(context.update.dbPath);
  trial.exec("PRAGMA journal_mode = " + paths.journalMode + "; INSERT INTO events (payload) VALUES ('trial');");
  trial.close();
  process.exit(1);
} else if (context.update === undefined) {
  const db = new DatabaseSync(paths.databasePath);
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec("PRAGMA journal_mode = " + paths.journalMode + ";");
  const insert = db.prepare("INSERT INTO events (payload) VALUES (?)");
  const writer = setInterval(() => insert.run("written while serving"), 1);
  let stopping = false;
  const finishServing = () => {
    if (stopping) return;
    stopping = true;
    clearInterval(writer);
    insert.run("last write before stopping");
    const backupRoot = paths.root + "/runtime/db-backup";
    writeFileSync(paths.observationsPath, JSON.stringify({
      backupsAtStop: readdirSync(backupRoot).map((entry) => readdirSync(backupRoot + "/" + entry)),
      rows: db.prepare("SELECT count(*) AS n FROM events").get().n,
    }));
    db.close();
    process.exit(0);
  };
  process.once("SIGTERM", finishServing);
  process.on("message", (message) => {
    if (message?.type === "stop") finishServing();
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
      ),
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

  it.live("refuses a backup that cannot fit and leaves the server running", () =>
    runNode(
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
    ),
  );

  it.live("refuses the update when free space cannot be checked", () =>
    runNode(
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
    ),
  );

  it.live("stops the server over IPC with the stop marker set and ignores stale launcherIds", () =>
    runNode(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-service-control-stop-" });
        const controlDir = serviceControlDir(path.join(root, "local"), root);
        const statePath = path.join(root, "runtime", "service-state.json");
        const reportPath = path.join(root, "stopped-with-marker");
        const markerPath = path.join(root, "runtime", SERVICE_STOP_MARKER_FILE);
        const childSource = `
const fs = require("node:fs");
const paths = ${JSON.stringify({ reportPath, markerPath })};
process.on("message", (message) => {
  if (message.type !== "stop") return;
  fs.writeFileSync(paths.reportPath, String(fs.existsSync(paths.markerPath)));
  process.exit(0);
});
setInterval(() => {}, 1_000);
`;
        yield* writeFakeRuntime(
          fs,
          path,
          path.join(root, "runtime", "versions", "1.0.0"),
          childSource,
        );
        yield* Effect.promise(() =>
          writeServiceState(statePath, {
            protocol: SERVICE_LAUNCHER_PROTOCOL,
            activeVersion: "1.0.0",
          }),
        );
        yield* fs.makeDirectory(controlDir, { recursive: true });
        yield* fs.writeFileString(path.join(controlDir, "control.token"), "corrupt\n");

        const acquired = Promise.withResolvers<void>();
        const launcher = new Launcher(
          root,
          yield* Effect.promise(() => readServiceState(statePath)),
          {
            controlDir,
            acl: trustedTestAcl,
            stopChildOverIpc: true,
            onControlAcquired: () => acquired.resolve(),
          },
        );
        const running = launcher.run();
        yield* Effect.promise(() => Promise.race([acquired.promise, running]));

        const activeId = yield* Effect.promise(() =>
          queryServiceLauncherId(controlDir, { acl: trustedTestAcl }),
        );
        assert.isString(activeId);
        assert.equal(
          yield* Effect.promise(() => probeServiceLauncher(controlDir, { acl: trustedTestAcl })),
          "running",
        );

        assert.isTrue(
          yield* Effect.promise(() =>
            signalServiceLauncherStop(controlDir, "stale-launcher-id", { acl: trustedTestAcl }),
          ),
        );
        assert.equal(
          yield* Effect.promise(() => queryServiceLauncherId(controlDir, { acl: trustedTestAcl })),
          activeId,
        );

        assert.isTrue(
          yield* Effect.promise(() =>
            requestServiceLauncherStop(controlDir, { acl: trustedTestAcl }),
          ),
        );
        yield* Effect.promise(() => running);
        assert.isFalse(launcher.ownsControl);
        assert.equal(yield* fs.readFileString(reportPath), "true");
        assert.equal(
          yield* Effect.promise(() => probeServiceLauncher(controlDir, { acl: trustedTestAcl })),
          "stopped",
        );
        assert.isFalse(
          yield* Effect.promise(() =>
            requestServiceLauncherStop(controlDir, { acl: trustedTestAcl }),
          ),
        );
      }),
    ),
  );

  it.live("rotates untrusted control tokens and rejects untrusted directory or token ACLs", () =>
    runNode(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-service-control-acl-" });
        const controlDir = serviceControlDir(path.join(root, "local"), root);
        const tokenPath = path.join(controlDir, "control.token");
        const statePath = path.join(root, "runtime", "service-state.json");
        yield* writeFakeRuntime(
          fs,
          path,
          path.join(root, "runtime", "versions", "1.0.0"),
          'process.on("message", (m) => { if (m.type === "stop") process.exit(0); });\nsetInterval(() => {}, 1_000);\n',
        );
        yield* Effect.promise(() =>
          writeServiceState(statePath, {
            protocol: SERVICE_LAUNCHER_PROTOCOL,
            activeVersion: "1.0.0",
          }),
        );
        const preseededToken = "a".repeat(64);
        yield* fs.makeDirectory(controlDir, { recursive: true });
        yield* fs.writeFileString(tokenPath, `${preseededToken}\n`);

        let clientTrustsDir = true;
        let clientTrustsToken = false;
        const restrictedDirs: Array<string> = [];
        const acl: ControlAclHooks = {
          restrictPathAcl: async (targetPath, isDirectory) => {
            if (isDirectory) {
              restrictedDirs.push(targetPath);
              clientTrustsDir = true;
            } else if (path.basename(targetPath).startsWith(".control-token.")) {
              clientTrustsToken = true;
            }
          },
          verifyPathAcl: async (targetPath, isDirectory) => {
            if (isDirectory) {
              return clientTrustsDir && restrictedDirs.includes(targetPath);
            }
            if (targetPath === tokenPath) return clientTrustsToken;
            return true;
          },
        };

        const acquired = Promise.withResolvers<void>();
        const launcher = new Launcher(
          root,
          yield* Effect.promise(() => readServiceState(statePath)),
          {
            controlDir,
            acl,
            stopChildOverIpc: true,
            onControlAcquired: () => acquired.resolve(),
          },
        );
        const running = launcher.run();
        yield* Effect.promise(() => Promise.race([acquired.promise, running]));

        const rotatedToken = (yield* fs.readFileString(tokenPath)).trim();
        assert.notEqual(rotatedToken, preseededToken);
        assert.include(restrictedDirs, controlDir);
        assert.equal(
          yield* Effect.promise(() => probeServiceLauncher(controlDir, { acl })),
          "running",
        );

        clientTrustsDir = false;
        const rejectedDir = yield* Effect.promise(() =>
          requestServiceLauncherStop(controlDir, { acl }).then(
            () => undefined,
            (error: unknown) => error,
          ),
        );
        assert.isTrue(isServiceControlUnauthorizedError(rejectedDir));
        assert.equal(
          yield* Effect.promise(() => probeServiceLauncher(controlDir, { acl })),
          "unhealthy",
        );
        clientTrustsDir = true;

        clientTrustsToken = false;
        const rejected = yield* Effect.promise(() =>
          requestServiceLauncherStop(controlDir, { acl }).then(
            () => undefined,
            (error: unknown) => error,
          ),
        );
        assert.isTrue(isServiceControlUnauthorizedError(rejected));
        assert.equal(
          yield* Effect.promise(() => probeServiceLauncher(controlDir, { acl })),
          "unhealthy",
        );

        clientTrustsToken = true;
        assert.isTrue(yield* Effect.promise(() => requestServiceLauncherStop(controlDir, { acl })));
        yield* Effect.promise(() => running);
      }),
    ),
  );

  it.live(
    "sends zero bytes to an invalid challenge, rejects forged or mismatched replies, and ignores unlocked stale endpoints",
    () =>
      runNode(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-service-control-rogue-" });
          const controlDir = serviceControlDir(path.join(root, "local"), root);
          const rogueScript = path.join(root, "rogue.mjs");
          const sharedToken = "b".repeat(64);

          yield* fs.makeDirectory(controlDir, { recursive: true });
          yield* fs.writeFileString(path.join(controlDir, "control.token"), `${sharedToken}\n`);
          yield* fs.writeFileString(
            rogueScript,
            [
              'import * as crypto from "node:crypto";',
              'import * as fs from "node:fs";',
              'import * as net from "node:net";',
              'import * as path from "node:path";',
              'import * as sqlite from "node:sqlite";',
              "const controlDir = process.argv[2];",
              `const token = ${JSON.stringify(sharedToken)};`,
              'const db = new sqlite.DatabaseSync(path.join(controlDir, "lock.sqlite"));',
              'db.exec("PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE;");',
              "let lockReleased = false;",
              "let unlockedConnections = 0;",
              "let index = 0;",
              "const server = net.createServer((socket) => {",
              "  if (lockReleased) { unlockedConnections += 1; socket.destroy(); return; }",
              "  const current = index++;",
              "  let bytes = 0;",
              "  if (current === 0) {",
              '    socket.write(\'{"nonce":"invalid"}\\n\');',
              '    socket.on("data", (chunk) => { bytes += chunk.length; });',
              '    socket.on("close", () => { process.send({ type: "bad-closed", bytes }); });',
              "    return;",
              "  }",
              '  const serverNonce = "0123456789abcdef0123456789abcdef";',
              '  socket.write(JSON.stringify({ nonce: serverNonce }) + "\\n");',
              '  let line = "";',
              '  socket.setEncoding("utf8");',
              '  socket.on("data", (chunk) => {',
              "    bytes += Buffer.byteLength(chunk);",
              "    line += chunk;",
              '    if (line.includes("\\n")) {',
              "      if (current === 1) {",
              '        process.send({ type: "forged-received", bytes });',
              '        socket.write(JSON.stringify({ body: \'{"ok":true,"launcherId":"rogue"}\', mac: "0".repeat(64) }) + "\\n");',
              "        return;",
              "      }",
              "      const req = JSON.parse(line.trim());",
              '      const body = JSON.stringify({ ok: true, launcherId: "other-instance" });',
              '      const mac = crypto.createHmac("sha256", token).update(`res\\0${serverNonce}\\0${req.cnonce}\\0${body}`).digest("hex");',
              '      socket.write(JSON.stringify({ body, mac }) + "\\n");',
              "    }",
              "  });",
              "});",
              'server.listen(0, "127.0.0.1", () => {',
              "  const address = server.address();",
              '  fs.writeFileSync(path.join(controlDir, "endpoint.json"), JSON.stringify({ port: address.port, launcherId: "rogue" }) + "\\n");',
              '  process.send({ type: "ready" });',
              "});",
              'process.on("message", (msg) => {',
              '  if (msg.type === "release") {',
              "    lockReleased = true;",
              "    db.close();",
              '    process.send({ type: "released" });',
              '  } else if (msg.type === "exit") {',
              '    server.close(() => process.send({ type: "exiting", unlockedConnections }, () => process.exit(0)));',
              "  }",
              "});",
            ].join("\n"),
          );

          const ready = Promise.withResolvers<void>();
          const badClosed = Promise.withResolvers<number>();
          let forgedBytes = 0;
          const released = Promise.withResolvers<void>();
          const exiting = Promise.withResolvers<number>();
          const exited = Promise.withResolvers<void>();

          const rogue = yield* Effect.acquireRelease(
            Effect.sync(() => {
              const child = NodeChildProcess.spawn(process.execPath, [rogueScript, controlDir], {
                stdio: ["ignore", "inherit", "inherit", "ipc"],
              });
              child.on("message", (raw: unknown) => {
                const msg = raw as {
                  readonly type: string;
                  readonly bytes?: number;
                  readonly unlockedConnections?: number;
                };
                if (msg.type === "ready") ready.resolve();
                else if (msg.type === "bad-closed") badClosed.resolve(msg.bytes ?? -1);
                else if (msg.type === "forged-received") forgedBytes = msg.bytes ?? 0;
                else if (msg.type === "released") released.resolve();
                else if (msg.type === "exiting") exiting.resolve(msg.unlockedConnections ?? -1);
              });
              child.once("exit", () => exited.resolve());
              return child;
            }),
            (child) =>
              Effect.sync(() => {
                if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
              }),
          );

          yield* Effect.promise(() => ready.promise);

          const badChallengeError = yield* Effect.promise(() =>
            queryServiceLauncherId(controlDir, { acl: trustedTestAcl }).then(
              () => undefined,
              (error: unknown) => error as Error,
            ),
          );
          assert.include(badChallengeError?.message ?? "", "invalid control challenge");
          assert.equal(yield* Effect.promise(() => badClosed.promise), 0);

          const forgedReplyError = yield* Effect.promise(() =>
            queryServiceLauncherId(controlDir, { acl: trustedTestAcl }).then(
              () => undefined,
              (error: unknown) => error,
            ),
          );
          assert.isTrue(isServiceControlUnauthorizedError(forgedReplyError));
          assert.isAbove(forgedBytes, 0);

          const mismatchedIdError = yield* Effect.promise(() =>
            queryServiceLauncherId(controlDir, { acl: trustedTestAcl }).then(
              () => undefined,
              (error: unknown) => error,
            ),
          );
          assert.isTrue(isServiceControlLauncherMismatchError(mismatchedIdError));
          assert.isFalse(isServiceControlUnauthorizedError(mismatchedIdError));
          assert.equal(
            yield* Effect.promise(() => probeServiceLauncher(controlDir, { acl: trustedTestAcl })),
            "unhealthy",
          );

          const untrustedReleaseError = yield* Effect.promise(() =>
            waitForServiceLauncherRelease(controlDir, {
              timeoutMs: 200,
              acl: {
                restrictPathAcl: async () => undefined,
                verifyPathAcl: async () => false,
              },
            }).then(
              () => undefined,
              (error: unknown) => error,
            ),
          );
          assert.isTrue(isServiceControlUnauthorizedError(untrustedReleaseError));

          // Releasing the SQLite lock while leaving endpoint.json + the TCP listener open simulates
          // ephemeral port reuse after a crash: clients must see the unlocked state and never dial.
          rogue.send({ type: "release" });
          yield* Effect.promise(() => released.promise);
          assert.equal(
            yield* Effect.promise(() => probeServiceLauncher(controlDir, { acl: trustedTestAcl })),
            "stopped",
          );
          assert.isFalse(
            yield* Effect.promise(() =>
              requestServiceLauncherStop(controlDir, { acl: trustedTestAcl }),
            ),
          );

          rogue.send({ type: "exit" });
          assert.equal(yield* Effect.promise(() => exiting.promise), 0);
          yield* Effect.promise(() => exited.promise);
        }),
      ),
  );

  it.live(
    "waits across multiple lock retries for a stopping launcher, reloads state, and spawns once",
    () =>
      runNode(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-service-control-handoff-" });
          const controlDir = serviceControlDir(path.join(root, "local"), root);
          const statePath = path.join(root, "runtime", "service-state.json");
          const spawnsLog = path.join(root, "spawns.log");
          const makeChildSource = (version: string) => `
const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(spawnsLog)}, ${JSON.stringify(`${version}\n`)});
process.on("message", (message) => {
  if (message.type === "stop") process.exit(0);
});
setInterval(() => {}, 1_000);
`;
          for (const version of ["1.0.0", "1.1.0"]) {
            yield* writeFakeRuntime(
              fs,
              path,
              path.join(root, "runtime", "versions", version),
              makeChildSource(version),
            );
          }
          yield* Effect.promise(() =>
            writeServiceState(statePath, {
              protocol: SERVICE_LAUNCHER_PROTOCOL,
              activeVersion: "1.0.0",
            }),
          );

          const initialState = yield* Effect.promise(() => readServiceState(statePath));
          const firstAcquired = Promise.withResolvers<void>();
          const first = new Launcher(root, initialState, {
            controlDir,
            acl: trustedTestAcl,
            controlListenRetryMs: 10,
            stopChildOverIpc: true,
            onControlAcquired: () => firstAcquired.resolve(),
          });
          const firstRun = first.run();
          yield* Effect.promise(() => Promise.race([firstAcquired.promise, firstRun]));

          const firstId = yield* Effect.promise(() =>
            queryServiceLauncherId(controlDir, { acl: trustedTestAcl }),
          );
          assert.isDefined(firstId);
          assert.deepEqual(
            yield* Effect.promise(() =>
              stageServiceLauncherInstall({
                controlDir,
                baseDir: root,
                version: "1.1.0",
                acl: trustedTestAcl,
              }),
            ),
            { status: "staged", launcherId: firstId },
          );

          const retriedTwice = Promise.withResolvers<void>();
          const secondAcquired = Promise.withResolvers<void>();
          const second = new Launcher(root, initialState, {
            controlDir,
            acl: trustedTestAcl,
            controlListenRetryMs: 10,
            stopChildOverIpc: true,
            onControlRetry: (attempt) => {
              if (attempt >= 2) retriedTwice.resolve();
            },
            onControlAcquired: () => secondAcquired.resolve(),
          });
          const secondRun = second.run();
          yield* Effect.promise(() => Promise.race([retriedTwice.promise, secondRun]));
          assert.isFalse(second.ownsControl);

          assert.isTrue(
            yield* Effect.promise(() =>
              requestServiceLauncherStop(controlDir, { acl: trustedTestAcl }),
            ),
          );
          yield* Effect.promise(() => firstRun);
          yield* Effect.promise(() => Promise.race([secondAcquired.promise, secondRun]));
          assert.isTrue(second.ownsControl);

          assert.isTrue(
            yield* Effect.promise(() =>
              requestServiceLauncherStop(controlDir, { acl: trustedTestAcl }),
            ),
          );
          yield* Effect.promise(() => secondRun);
          assert.deepEqual((yield* fs.readFileString(spawnsLog)).trim().split("\n"), [
            "1.0.0",
            "1.1.0",
          ]);
        }),
      ),
  );

  it.live(
    "cancels an aborted stage-install queued behind an in-flight transition and serializes offline staging",
    () =>
      runNode(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-service-control-queue-" });
          const controlDir = serviceControlDir(path.join(root, "local"), root);
          const statePath = path.join(root, "runtime", "service-state.json");
          const databasePath = path.join(root, "userdata", "state.sqlite");
          yield* fs.makeDirectory(path.dirname(databasePath), { recursive: true });
          yield* fs.writeFileString(databasePath, "database");
          const childSource = `
process.on("message", (message) => {
  if (message.type === "stop") process.exit(0);
});
process.send({ type: "request-update", targetVersion: "1.1.0", dbPath: ${JSON.stringify(databasePath)} });
setInterval(() => {}, 1_000);
`;
          for (const version of ["1.0.0", "1.1.0", "1.2.0"]) {
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

          const inUpdateCheck = Promise.withResolvers<void>();
          const finishUpdateCheck = Promise.withResolvers<number>();
          const stageQueued = Promise.withResolvers<{ readonly disconnected: Promise<void> }>();
          const launcher = new Launcher(
            root,
            yield* Effect.promise(() => readServiceState(statePath)),
            {
              controlDir,
              acl: trustedTestAcl,
              stopChildOverIpc: true,
              onControlStageQueued: ({ version, disconnected }) => {
                if (version === "1.2.0") stageQueued.resolve({ disconnected });
              },
              backupSpaceProbe: {
                readFreeBytes: () => {
                  inUpdateCheck.resolve();
                  return finishUpdateCheck.promise;
                },
                canClone: () => Promise.resolve(false),
              },
            },
          );
          const running = launcher.run();
          yield* Effect.addFinalizer(() =>
            Effect.promise(async () => {
              finishUpdateCheck.resolve(0);
              await launcher.stop("SIGTERM");
              await running.catch(() => undefined);
            }),
          );
          yield* Effect.promise(() => Promise.race([inUpdateCheck.promise, running]));
          const activeId = yield* Effect.promise(() =>
            queryServiceLauncherId(controlDir, { acl: trustedTestAcl }),
          );
          assert.isDefined(activeId);

          const abortedStageFiber = yield* Effect.forkChild(
            Effect.tryPromise({
              try: (signal) =>
                stageServiceLauncherInstall({
                  controlDir,
                  baseDir: root,
                  version: "1.2.0",
                  acl: trustedTestAcl,
                  signal,
                }),
              catch: (cause) => new ServiceLauncherClientError({ operation: "send", cause }),
            }),
          );
          const { disconnected } = yield* Effect.promise(() => stageQueued.promise);
          yield* Fiber.interrupt(abortedStageFiber);
          const abortedExit = yield* Fiber.await(abortedStageFiber);
          assert.isTrue(Exit.isFailure(abortedExit));
          yield* Effect.promise(() => disconnected);

          // Return 0 free bytes so the update check rejects without setting `update: pending`; if the
          // aborted `1.2.0` stage had still executed, staging `1.1.0` without allowDowngrade would fail.
          finishUpdateCheck.resolve(0);
          assert.deepEqual(
            yield* Effect.promise(() =>
              stageServiceLauncherInstall({
                controlDir,
                baseDir: root,
                version: "1.1.0",
                acl: trustedTestAcl,
              }),
            ),
            { status: "staged", launcherId: activeId },
          );
          assert.equal(
            (yield* Effect.promise(() => readServiceState(statePath))).activeVersion,
            "1.1.0",
          );

          assert.isTrue(
            yield* Effect.promise(() =>
              requestServiceLauncherStop(controlDir, { acl: trustedTestAcl }),
            ),
          );
          yield* Effect.promise(() => running);

          const concurrentOffline = yield* Effect.promise(() =>
            Promise.all([
              stageServiceLauncherInstall({
                controlDir,
                baseDir: root,
                version: "1.2.0",
                acl: trustedTestAcl,
              }),
              stageServiceLauncherInstall({
                controlDir,
                baseDir: root,
                version: "1.2.0",
                acl: trustedTestAcl,
              }),
            ]),
          );
          assert.deepEqual(concurrentOffline, [{ status: "staged" }, { status: "staged" }]);

          // Offline `stageServiceLauncherInstall` refuses while a remote update is pending and
          // surfaces `installedVersion` without touching the database or backup; `recoverServiceLauncherUninstall`
          // requires exclusive `server-owner.sqlite` ownership before restoring a pre-trial backup.
          yield* fs.remove(path.join(root, "runtime", "stopped"), { force: true });
          const backupDir = path.join(root, "runtime", "db-backup", "abandoned-update");
          yield* fs.makeDirectory(backupDir, { recursive: true });
          yield* fs.writeFileString(path.join(backupDir, "database"), "pre-trial-database");
          yield* fs.writeFileString(databasePath, "corrupted-trial-database");
          yield* Effect.promise(() =>
            writeServiceState(statePath, {
              protocol: SERVICE_LAUNCHER_PROTOCOL,
              activeVersion: "1.1.0",
              update: {
                id: "abandoned-update",
                fromVersion: "1.1.0",
                targetVersion: "1.2.0",
                dbPath: databasePath,
                status: "pending",
              },
            }),
          );
          assert.deepEqual(
            yield* Effect.promise(() =>
              stageServiceLauncherInstall({
                controlDir,
                baseDir: root,
                version: "1.2.0",
                acl: trustedTestAcl,
              }),
            ),
            { status: "update-pending", installedVersion: "1.1.0" },
          );
          assert.equal(yield* fs.readFileString(databasePath), "corrupted-trial-database");
          assert.isTrue(yield* fs.exists(backupDir));

          const ownerLockPath = path.join(path.dirname(databasePath), "server-owner.sqlite");
          const heldOwnerLock = new NodeSqlite.DatabaseSync(ownerLockPath);
          heldOwnerLock.exec("PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE;");
          try {
            yield* Effect.promise(() =>
              recoverServiceLauncherUninstall({
                baseDir: root,
                controlDir,
                acl: trustedTestAcl,
              }),
            );
            assert.equal(yield* fs.readFileString(databasePath), "corrupted-trial-database");
            const ownedRecoveryState = yield* Effect.promise(() => readServiceState(statePath));
            assert.equal(ownedRecoveryState.update?.status, "failed");
            assert.equal(
              ownedRecoveryState.update?.status === "failed"
                ? ownedRecoveryState.update.reason
                : undefined,
              "state-dir-owned",
            );
            assert.isTrue(yield* fs.exists(backupDir));
          } finally {
            heldOwnerLock.close();
          }

          // If a launcher stopped cleanly during a pending trial (recording `stopped-db-digest.json`)
          // and a foreground server later saved new work before uninstall recovery, recovery preserves
          // the foreground database AND keeps the backup instead of overwriting or deleting either copy.
          const postStopBackupDir = path.join(root, "runtime", "db-backup", "post-stop-update");
          yield* fs.makeDirectory(postStopBackupDir, { recursive: true });
          yield* fs.writeFileString(path.join(postStopBackupDir, "database"), "pre-trial-database");
          yield* fs.writeFileString(databasePath, "trial-database-at-stop");
          yield* Effect.promise(() =>
            writeServiceState(statePath, {
              protocol: SERVICE_LAUNCHER_PROTOCOL,
              activeVersion: "1.1.0",
              update: {
                id: "post-stop-update",
                fromVersion: "1.1.0",
                targetVersion: "1.2.0",
                dbPath: databasePath,
                status: "pending",
              },
            }),
          );
          const stoppingPending = new Launcher(
            root,
            yield* Effect.promise(() => readServiceState(statePath)),
            {
              controlDir,
              acl: trustedTestAcl,
              stopChildOverIpc: true,
              onControlAcquired: () => {
                void stoppingPending.stop("SIGTERM");
              },
            },
          );
          yield* Effect.promise(() => stoppingPending.run());
          yield* fs.writeFileString(databasePath, "foreground-work-saved-after-stop");
          yield* Effect.promise(() =>
            recoverServiceLauncherUninstall({
              baseDir: root,
              controlDir,
              acl: trustedTestAcl,
            }),
          );
          assert.equal(yield* fs.readFileString(databasePath), "foreground-work-saved-after-stop");
          assert.isTrue(yield* fs.exists(postStopBackupDir));
          assert.deepEqual(
            yield* Effect.promise(() =>
              stageServiceLauncherInstall({
                controlDir,
                baseDir: root,
                version: "1.2.0",
                acl: trustedTestAcl,
              }),
            ),
            { status: "staged" },
          );

          // Without positive stop evidence (`stopped-db-digest.json` or `.restore-pending`), such as
          // after a launcher crash where a foreground server may have saved work and exited,
          // `recoverServiceLauncherUninstall` refuses to overwrite `databasePath` and preserves the backup.
          const crashedBackupDir = path.join(root, "runtime", "db-backup", "crashed-update");
          yield* fs.makeDirectory(crashedBackupDir, { recursive: true });
          yield* fs.writeFileString(path.join(crashedBackupDir, "database"), "clean-pre-trial");
          yield* fs.writeFileString(databasePath, "interrupted-trial");
          yield* Effect.promise(() =>
            writeServiceState(statePath, {
              protocol: SERVICE_LAUNCHER_PROTOCOL,
              activeVersion: "1.1.0",
              update: {
                id: "crashed-update",
                fromVersion: "1.1.0",
                targetVersion: "1.2.0",
                dbPath: databasePath,
                status: "pending",
              },
            }),
          );
          yield* Effect.promise(() =>
            recoverServiceLauncherUninstall({
              baseDir: root,
              controlDir,
              acl: trustedTestAcl,
            }),
          );
          assert.equal(yield* fs.readFileString(databasePath), "interrupted-trial");
          assert.isTrue(yield* fs.exists(crashedBackupDir));

          // When the launcher stopped cleanly first (`stopped-db-digest.json` matches), offline
          // `recoverServiceLauncherUninstall` restores the pre-trial backup and cleans up `backupDir`.
          const uninstallBackupDir = path.join(root, "runtime", "db-backup", "uninstall-update");
          yield* fs.makeDirectory(uninstallBackupDir, { recursive: true });
          yield* fs.writeFileString(path.join(uninstallBackupDir, "database"), "clean-pre-trial");
          yield* fs.writeFileString(databasePath, "interrupted-trial");
          yield* Effect.promise(() =>
            writeServiceState(statePath, {
              protocol: SERVICE_LAUNCHER_PROTOCOL,
              activeVersion: "1.1.0",
              update: {
                id: "uninstall-update",
                fromVersion: "1.1.0",
                targetVersion: "1.2.0",
                dbPath: databasePath,
                status: "pending",
              },
            }),
          );
          const cleanlyStoppedPending = new Launcher(
            root,
            yield* Effect.promise(() => readServiceState(statePath)),
            {
              controlDir,
              acl: trustedTestAcl,
              stopChildOverIpc: true,
              onControlAcquired: () => {
                void cleanlyStoppedPending.stop("SIGTERM");
              },
            },
          );
          yield* Effect.promise(() => cleanlyStoppedPending.run());
          yield* Effect.promise(() =>
            recoverServiceLauncherUninstall({
              baseDir: root,
              controlDir,
              acl: trustedTestAcl,
            }),
          );
          assert.equal(yield* fs.readFileString(databasePath), "clean-pre-trial");
          assert.equal(
            (yield* Effect.promise(() => readServiceState(statePath))).update?.status,
            "failed",
          );
          assert.isFalse(yield* fs.exists(uninstallBackupDir));

          // Startup `#recover()` refuses to overwrite a database whose `.server-owner-lease.json`
          // shows a foreground server took ownership after the pending trial crashed.
          const leaseConflictBackupDir = path.join(root, "runtime", "db-backup", "lease-conflict");
          yield* fs.makeDirectory(leaseConflictBackupDir, { recursive: true });
          yield* fs.writeFileString(path.join(leaseConflictBackupDir, "database"), "old-pre-trial");
          yield* fs.writeFileString(databasePath, "foreground-work-after-crash");
          yield* fs.writeFileString(
            path.join(path.dirname(databasePath), SERVER_OWNER_LEASE_FILE),
            `${JSON.stringify({ ownerId: "foreground-server" })}\n`,
          );
          yield* Effect.promise(() =>
            writeServiceState(statePath, {
              protocol: SERVICE_LAUNCHER_PROTOCOL,
              activeVersion: "1.1.0",
              update: {
                id: "lease-conflict",
                fromVersion: "1.1.0",
                targetVersion: "9.9.9",
                dbPath: databasePath,
                status: "pending",
              },
            }),
          );
          const recoveringAfterForeground = new Launcher(
            root,
            yield* Effect.promise(() => readServiceState(statePath)),
            {
              controlDir,
              acl: trustedTestAcl,
              stopChildOverIpc: true,
              onControlAcquired: () => {
                void recoveringAfterForeground.stop("SIGTERM");
              },
            },
          );
          yield* Effect.promise(() => recoveringAfterForeground.run());
          assert.equal(yield* fs.readFileString(databasePath), "foreground-work-after-crash");
          assert.isTrue(yield* fs.exists(leaseConflictBackupDir));
          yield* fs.remove(path.join(path.dirname(databasePath), SERVER_OWNER_LEASE_FILE), {
            force: true,
          });

          // Live in-service `signalServiceLauncherStop(..., { uninstall: true })` restores the
          // pre-trial SQLite database even when the managed trial child checkpoints WAL writes on shutdown.
          const walDbPath = path.join(root, "userdata", "wal-trial.sqlite");
          const preTrialDb = new NodeSqlite.DatabaseSync(walDbPath);
          preTrialDb.exec(
            "PRAGMA journal_mode = WAL; CREATE TABLE notes (value TEXT); INSERT INTO notes VALUES ('clean-pre-trial');",
          );
          preTrialDb.close();
          const liveUninstallBackupDir = path.join(root, "runtime", "db-backup", "live-uninstall");
          yield* fs.makeDirectory(liveUninstallBackupDir, { recursive: true });
          yield* fs.copyFile(walDbPath, path.join(liveUninstallBackupDir, "database"));
          if (yield* fs.exists(`${walDbPath}-wal`)) {
            yield* fs.copyFile(`${walDbPath}-wal`, path.join(liveUninstallBackupDir, "wal"));
          }
          const walTrialVersionDir = path.join(root, "runtime", "versions", "1.3.0");
          const walChildReady = Promise.withResolvers<void>();
          yield* writeFakeRuntime(
            fs,
            path,
            walTrialVersionDir,
            `
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(${JSON.stringify(walDbPath)});
db.exec("PRAGMA journal_mode = WAL; INSERT INTO notes VALUES ('trial-running');");
process.on("message", (message) => {
  if (message?.type === "stop") {
    db.exec("INSERT INTO notes VALUES ('trial-shutdown-flush'); PRAGMA wal_checkpoint(TRUNCATE);");
    db.close();
    process.exit(0);
  }
});
process.send({ type: "wal-trial-ready" });
`,
          );
          yield* Effect.promise(() =>
            writeServiceState(statePath, {
              protocol: SERVICE_LAUNCHER_PROTOCOL,
              activeVersion: "1.1.0",
              update: {
                id: "live-uninstall",
                fromVersion: "1.1.0",
                targetVersion: "1.3.0",
                dbPath: walDbPath,
                status: "pending",
              },
            }),
          );
          const liveUninstallLauncher = new Launcher(
            root,
            yield* Effect.promise(() => readServiceState(statePath)),
            {
              controlDir,
              acl: trustedTestAcl,
              stopChildOverIpc: true,
              spawnCommand: (entryPath) => {
                queueMicrotask(() => {
                  const spawned = spawnedChildren.at(-1);
                  spawned?.on("message", (message) => {
                    if (
                      (message as { readonly type?: string } | null)?.type === "wal-trial-ready"
                    ) {
                      walChildReady.resolve();
                    }
                  });
                });
                return { command: entryPath, args: ["serve"] };
              },
            },
          );
          const liveUninstallRun = liveUninstallLauncher.run();
          yield* Effect.promise(() => walChildReady.promise);
          assert.isTrue(
            yield* Effect.promise(() =>
              signalServiceLauncherStop(controlDir, undefined, {
                acl: trustedTestAcl,
                uninstall: true,
              }),
            ),
          );
          yield* Effect.promise(() => liveUninstallRun);
          const verifyRestored = new NodeSqlite.DatabaseSync(walDbPath);
          try {
            assert.deepEqual(verifyRestored.prepare("SELECT value FROM notes").all(), [
              { value: "clean-pre-trial" },
            ]);
            assert.deepEqual(verifyRestored.prepare("PRAGMA integrity_check").get(), {
              integrity_check: "ok",
            });
          } finally {
            verifyRestored.close();
          }
          assert.isFalse(yield* fs.exists(liveUninstallBackupDir));
        }),
      ),
  );

  it.live(
    "ends the persisted Windows scheduled task while holding the control lock when the active server crashes",
    () =>
      runNode(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-service-win-crash-" });
          const userProfile = path.join(root, "profile");
          const localAppData = path.join(userProfile, "AppData", "Local");
          const persistedTask = serviceTaskName("OLD-PC", "theo");
          const taskFile = serviceTaskNamePath(localAppData);
          yield* fs.makeDirectory(path.dirname(taskFile), { recursive: true });
          yield* fs.writeFileString(taskFile, `${persistedTask}\n`);

          const statePath = path.join(root, "runtime", "service-state.json");
          const logFile = path.join(root, "logs", "boot-service.log");
          const childSource = `
process.on("message", (message) => {
  if (message?.type === "crash") process.exit(5);
  if (message?.type === "stop") process.exit(0);
});
process.send({ type: "test-ready" });
`;
          yield* writeFakeRuntime(
            fs,
            path,
            path.join(root, "runtime", "versions", "1.0.0"),
            childSource,
          );
          yield* Effect.promise(() =>
            writeServiceState(statePath, {
              protocol: SERVICE_LAUNCHER_PROTOCOL,
              activeVersion: "1.0.0",
            }),
          );

          const activeChild = Promise.withResolvers<NodeChildProcess.ChildProcess>();
          const endedTasks: Array<{ readonly taskName: string; readonly lockHeld: boolean }> = [];
          const controlDir = serviceControlDir(localAppData, root, { caseInsensitive: true });

          // Blank `LOCALAPPDATA` falls back to `USERPROFILE\AppData\Local`, and a waiting
          // non-owner failing on lock timeout must NOT end the active owner's scheduled task.
          const activeMain = main({
            baseDir: root,
            logFile,
            serviceUnit: "t3code.service",
            platform: "win32",
            environment: {
              ...process.env,
              LOCALAPPDATA: "   ",
              USERPROFILE: userProfile,
              USERDOMAIN: "RENAMED-PC",
              USERNAME: "theo",
            },
            acl: trustedTestAcl,
            spawnCommand: (entryPath) => {
              queueMicrotask(() => {
                const spawned = spawnedChildren.at(-1);
                spawned?.on("message", (message) => {
                  if ((message as { readonly type?: string } | null)?.type === "test-ready") {
                    activeChild.resolve(spawned);
                  }
                });
              });
              return { command: entryPath, args: ["serve"] };
            },
            endScheduledTask: (taskName) => {
              endedTasks.push({
                taskName,
                lockHeld: probeControlLockHeld(controlDir),
              });
            },
          });
          yield* Effect.addFinalizer(() =>
            Effect.promise(async () => {
              spawnedChildren.at(-1)?.kill("SIGKILL");
              await activeMain.catch(() => undefined);
            }),
          );

          const runningChild = yield* Effect.promise(() =>
            Promise.race([
              activeChild.promise,
              activeMain.then(() => Promise.reject(new Error("launcher exited early"))),
            ]),
          );

          const contenderFailure = yield* Effect.promise(() =>
            main({
              baseDir: root,
              serviceUnit: "t3code.service",
              platform: "win32",
              environment: {
                ...process.env,
                LOCALAPPDATA: localAppData,
                USERDOMAIN: "RENAMED-PC",
                USERNAME: "theo",
              },
              acl: trustedTestAcl,
              controlListenRetryMs: 1,
              endScheduledTask: (taskName) => {
                endedTasks.push({ taskName: `contender:${taskName}`, lockHeld: false });
              },
            }).then(
              () => undefined,
              (cause: unknown) => cause as Error,
            ),
          );
          assert.include(contenderFailure?.message ?? "", "Timed out waiting to acquire");
          assert.deepEqual(endedTasks, []);

          runningChild.send({ type: "crash" });
          const activeFailure = yield* Effect.promise(() =>
            activeMain.then(
              () => undefined,
              (cause: unknown) => cause as Error,
            ),
          );
          assert.include(activeFailure?.message ?? "", "Active child exited unexpectedly (5)");
          assert.deepEqual(endedTasks, [{ taskName: persistedTask, lockHeld: true }]);
          assert.include(
            yield* fs.readFileString(logFile),
            "[service-launcher] Active child exited unexpectedly (5)",
          );

          // Even if writing the fatal log fails (for example ENOSPC on `/dev/full`), `endScheduledTask` still runs.
          endedTasks.length = 0;
          const nextChild = Promise.withResolvers<NodeChildProcess.ChildProcess>();
          const enospcMain = main({
            baseDir: root,
            logFile: NodeFS.existsSync("/dev/full") ? "/dev/full" : logFile,
            serviceUnit: "t3code.service",
            platform: "win32",
            environment: {
              ...process.env,
              LOCALAPPDATA: localAppData,
              USERDOMAIN: "RENAMED-PC",
              USERNAME: "theo",
            },
            acl: trustedTestAcl,
            spawnCommand: (entryPath) => {
              queueMicrotask(() => {
                const spawned = spawnedChildren.at(-1);
                spawned?.on("message", (message) => {
                  if ((message as { readonly type?: string } | null)?.type === "test-ready") {
                    nextChild.resolve(spawned);
                  }
                });
              });
              return { command: entryPath, args: ["serve"] };
            },
            endScheduledTask: (taskName) => {
              endedTasks.push({
                taskName,
                lockHeld: probeControlLockHeld(controlDir),
              });
            },
          });
          const secondChild = yield* Effect.promise(() =>
            Promise.race([
              nextChild.promise,
              enospcMain.then(() => Promise.reject(new Error("launcher exited early"))),
            ]),
          );
          secondChild.send({ type: "crash" });
          const enospcFailure = yield* Effect.promise(() =>
            enospcMain.then(
              () => undefined,
              (cause: unknown) => cause as Error,
            ),
          );
          assert.include(enospcFailure?.message ?? "", "Active child exited unexpectedly (5)");
          assert.deepEqual(endedTasks, [{ taskName: persistedTask, lockHeld: true }]);
        }),
      ),
  );

  it.live("records no update when the server exits during the backup check", () =>
    runNode(
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
    ),
  );

  it.effect("reclaims partial backups left by killed updates before checking space", () =>
    runNode(
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
    ),
  );

  it.effect("checks database backup space against clone or full-copy needs", () =>
    runNode(
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
    ),
  );

  it.effect(
    "accepts Windows UNC database paths and recovers missing databases through a symlinked home",
    () =>
      runNode(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;

          const uncDecoded = decodeServiceState({
            protocol: SERVICE_LAUNCHER_PROTOCOL,
            activeVersion: "1.0.0",
            update: {
              id: "unc-update",
              fromVersion: "1.0.0",
              targetVersion: "1.1.0",
              dbPath: "\\\\server\\share\\t3\\userdata\\statev2.sqlite",
              status: "pending",
            },
          });
          assert.equal(uncDecoded?.update?.status, "pending");

          const outer = yield* fs.makeTempDirectoryScoped({
            prefix: "t3-service-launcher-symlink-home-",
          });
          const realHome = path.join(outer, "real-home");
          const symlinkHome = path.join(outer, "symlink-home");
          yield* fs.makeDirectory(path.join(realHome, "userdata"), { recursive: true });
          yield* fs.symlink(realHome, symlinkHome);

          const symlinkDbPath = path.join(symlinkHome, "userdata", "statev2.sqlite");
          const backupDir = path.join(symlinkHome, "runtime", "db-backup", "interrupted-restore");
          yield* fs.makeDirectory(backupDir, { recursive: true });
          yield* fs.writeFileString(path.join(backupDir, "database"), "restored-through-symlink");
          yield* fs.writeFileString(path.join(backupDir, ".restore-pending"), "");

          const statePath = path.join(symlinkHome, "runtime", "service-state.json");
          yield* Effect.promise(() =>
            writeServiceState(statePath, {
              protocol: SERVICE_LAUNCHER_PROTOCOL,
              activeVersion: "1.0.0",
              update: {
                id: "interrupted-restore",
                fromVersion: "1.0.0",
                targetVersion: "1.1.0",
                dbPath: symlinkDbPath,
                status: "pending",
              },
            }),
          );

          const controlDir = path.join(outer, "control");
          yield* fs.makeDirectory(controlDir, { recursive: true });
          yield* Effect.promise(() =>
            recoverServiceLauncherUninstall({
              baseDir: symlinkHome,
              controlDir,
              acl: trustedTestAcl,
            }),
          );

          assert.equal(
            yield* fs.readFileString(path.join(realHome, "userdata", "statev2.sqlite")),
            "restored-through-symlink",
          );
          const recoveredState = yield* Effect.promise(() => readServiceState(statePath));
          assert.equal(recoveredState.update?.status, "failed");
        }),
      ),
  );
});
