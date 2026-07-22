import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as TestClock from "effect/testing/TestClock";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import {
  HostProcessArguments,
  HostProcessEnvironment,
  HostProcessExecutablePath,
  HostProcessPlatform,
} from "@t3tools/shared/hostProcess";

import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import {
  BOOT_SERVICE_UNIT_ENV,
  BOOT_SERVICE_UNIT_FILE,
  renderBootServiceUnit,
} from "./bootService.ts";
import * as SelfUpdate from "./selfUpdate.ts";

const NODE_PATH = "/usr/local/bin/node";

interface RecordedCommand {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
}

const makeRecordingRunnerLayer = (
  commands: Array<RecordedCommand>,
  options?: {
    readonly failWhen?: ((command: string, args: ReadonlyArray<string>) => boolean) | undefined;
    readonly stdoutFor?:
      | ((command: string, args: ReadonlyArray<string>) => string | undefined)
      | undefined;
  },
) =>
  Layer.succeed(
    ProcessRunner.ProcessRunner,
    ProcessRunner.ProcessRunner.of({
      run: (input) =>
        Effect.sync(() => {
          commands.push({ command: input.command, args: input.args });
          const failed = options?.failWhen?.(input.command, input.args) === true;
          const versionFromPath =
            input.command === NODE_PATH && input.args[1] === "--version"
              ? /[/\\]runtime[/\\]versions[/\\]([^/\\]+)/.exec(input.args[0] ?? "")?.[1]
              : undefined;
          return {
            stdout:
              options?.stdoutFor?.(input.command, input.args) ??
              (versionFromPath === undefined ? "" : `${versionFromPath}\n`),
            stderr: failed ? `${input.command} exploded` : "",
            code: ChildProcessSpawner.ExitCode(failed ? 1 : 0),
            timedOut: false,
            stdoutTruncated: false,
            stderrTruncated: false,
          };
        }),
    }),
  );

const provideHostRefs = (input: {
  readonly platform: NodeJS.Platform;
  readonly env: NodeJS.ProcessEnv;
  readonly entryPath: string;
}) =>
  Effect.provide(
    Layer.mergeAll(
      Layer.succeed(HostProcessPlatform, input.platform),
      Layer.succeed(HostProcessEnvironment, input.env),
      Layer.succeed(HostProcessExecutablePath, NODE_PATH),
      Layer.succeed(HostProcessArguments, [NODE_PATH, input.entryPath, "serve"]),
    ),
  );

it("recognizes published npm artifacts as swappable entry points", () => {
  assert.isTrue(SelfUpdate.isPublishedCliEntry("/usr/local/lib/node_modules/t3/dist/bin.mjs"));
  assert.isTrue(
    SelfUpdate.isPublishedCliEntry("/home/theo/.npm/_npx/abc123/node_modules/t3/dist/bin.mjs"),
  );
  assert.isTrue(
    SelfUpdate.isPublishedCliEntry(
      "C:\\Users\\theo\\AppData\\Roaming\\npm\\node_modules\\t3\\dist\\bin.mjs",
    ),
  );
  // Dev checkouts and the desktop bundle run apps/server/dist directly.
  assert.isFalse(SelfUpdate.isPublishedCliEntry("/home/theo/dev/t3/apps/server/dist/bin.mjs"));
  assert.isFalse(SelfUpdate.isPublishedCliEntry(""));
});

it.layer(NodeServices.layer)("resolveServerSelfUpdateCapability", (it) => {
  const makeHome = Effect.fn("test.makeHome")(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-self-update-test-" });
    return { fs, path, home };
  });

  const writeUnitReferencing = Effect.fn("test.writeUnitReferencing")(function* (
    home: string,
    entryPath: string,
  ) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const unitDir = path.join(home, ".config", "systemd", "user");
    yield* fs.makeDirectory(unitDir, { recursive: true });
    yield* fs.writeFileString(
      path.join(unitDir, "t3code.service"),
      renderBootServiceUnit({
        nodePath: NODE_PATH,
        t3EntryPath: entryPath,
        baseDir: path.join(home, ".t3"),
        logPath: path.join(home, ".t3", "userdata", "logs", "boot-service.log"),
        unitPath: path.join(unitDir, "t3code.service"),
      }),
    );
  });

  it.effect("reports boot-service for the systemd-spawned unit process", () =>
    Effect.gen(function* () {
      const { home, path } = yield* makeHome();
      const entryPath = path.join(home, ".t3/runtime/versions/0.0.28/node_modules/t3/dist/bin.mjs");
      yield* writeUnitReferencing(home, entryPath);
      const method = yield* SelfUpdate.resolveServerSelfUpdateCapability({
        desktopManaged: false,
      }).pipe(
        provideHostRefs({
          platform: "linux",
          env: {
            HOME: home,
            INVOCATION_ID: "abc123",
            [BOOT_SERVICE_UNIT_ENV]: BOOT_SERVICE_UNIT_FILE,
          },
          entryPath,
        }),
      );
      assert.equal(method, "boot-service");
    }),
  );

  it.effect("does not claim a systemd process owned by another unit", () =>
    Effect.gen(function* () {
      const { home, path } = yield* makeHome();
      const entryPath = path.join(home, ".t3/runtime/versions/0.0.28/node_modules/t3/dist/bin.mjs");
      yield* writeUnitReferencing(home, entryPath);
      const method = yield* SelfUpdate.resolveServerSelfUpdateCapability({
        desktopManaged: false,
      }).pipe(
        provideHostRefs({
          platform: "linux",
          env: { HOME: home, INVOCATION_ID: "abc123" },
          entryPath,
        }),
      );
      assert.isNull(method);
    }),
  );

  it.effect("reports respawn for a manual run of the pinned artifact", () =>
    Effect.gen(function* () {
      const { home, path } = yield* makeHome();
      const entryPath = path.join(home, ".t3/runtime/versions/0.0.28/node_modules/t3/dist/bin.mjs");
      yield* writeUnitReferencing(home, entryPath);
      // Same unit on disk, but no INVOCATION_ID: restarting the unit would
      // not replace this process, so it must respawn itself instead.
      const method = yield* SelfUpdate.resolveServerSelfUpdateCapability({
        desktopManaged: false,
      }).pipe(provideHostRefs({ platform: "linux", env: { HOME: home }, entryPath }));
      assert.equal(method, "respawn");
    }),
  );

  it.effect("reports respawn for a foreground npx artifact on darwin", () =>
    Effect.gen(function* () {
      const { home } = yield* makeHome();
      const method = yield* SelfUpdate.resolveServerSelfUpdateCapability({
        desktopManaged: false,
      }).pipe(
        provideHostRefs({
          platform: "darwin",
          env: { HOME: home },
          entryPath: `${home}/.npm/_npx/abc123/node_modules/t3/dist/bin.mjs`,
        }),
      );
      assert.equal(method, "respawn");
    }),
  );

  it.effect("reports desktop-managed for desktop-supervised backends", () =>
    Effect.gen(function* () {
      const { home, path } = yield* makeHome();
      // Desktop ownership wins over every process-shape heuristic: even a
      // systemd-looking pinned artifact belongs to the app that spawned it.
      const entryPath = path.join(home, ".t3/runtime/versions/0.0.28/node_modules/t3/dist/bin.mjs");
      yield* writeUnitReferencing(home, entryPath);
      const method = yield* SelfUpdate.resolveServerSelfUpdateCapability({
        desktopManaged: true,
      }).pipe(
        provideHostRefs({
          platform: "linux",
          env: {
            HOME: home,
            INVOCATION_ID: "abc123",
            [BOOT_SERVICE_UNIT_ENV]: BOOT_SERVICE_UNIT_FILE,
          },
          entryPath,
        }),
      );
      assert.equal(method, "desktop-managed");
    }),
  );

  it.effect("reports no method for dev checkouts and Windows", () =>
    Effect.gen(function* () {
      const { home } = yield* makeHome();
      const devMethod = yield* SelfUpdate.resolveServerSelfUpdateCapability({
        desktopManaged: false,
      }).pipe(
        provideHostRefs({
          platform: "darwin",
          env: { HOME: home },
          entryPath: `${home}/dev/t3/apps/server/dist/bin.mjs`,
        }),
      );
      assert.isNull(devMethod);
      const windowsMethod = yield* SelfUpdate.resolveServerSelfUpdateCapability({
        desktopManaged: false,
      }).pipe(
        provideHostRefs({
          platform: "win32",
          env: { HOME: home },
          entryPath: "C:\\Users\\theo\\AppData\\Roaming\\npm\\node_modules\\t3\\dist\\bin.mjs",
        }),
      );
      assert.isNull(windowsMethod);
    }),
  );
});

it.layer(NodeServices.layer)("ServerSelfUpdate.update", (it) => {
  interface RecordedSpawn {
    readonly command: string;
    readonly args: ReadonlyArray<string>;
  }

  const makeContext = Effect.fn("test.makeContext")(function* (options?: {
    readonly platform?: NodeJS.Platform;
    readonly bootService?: boolean;
    readonly desktopManaged?: boolean;
    readonly entryPath?: string;
    readonly failWhen?: (command: string, args: ReadonlyArray<string>) => boolean;
    readonly stdoutFor?: (command: string, args: ReadonlyArray<string>) => string | undefined;
    readonly failSpawn?: boolean;
  }) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-self-update-test-" });
    const baseDir = path.join(home, ".t3");
    const entryPath =
      options?.entryPath ??
      path.join(home, ".t3/runtime/versions/0.0.28/node_modules/t3/dist/bin.mjs");
    const env: NodeJS.ProcessEnv =
      options?.bootService === true
        ? {
            HOME: home,
            INVOCATION_ID: "abc123",
            [BOOT_SERVICE_UNIT_ENV]: BOOT_SERVICE_UNIT_FILE,
          }
        : { HOME: home };
    if (options?.bootService === true) {
      const unitDir = path.join(home, ".config", "systemd", "user");
      yield* fs.makeDirectory(unitDir, { recursive: true });
      yield* fs.writeFileString(
        path.join(unitDir, "t3code.service"),
        renderBootServiceUnit({
          nodePath: NODE_PATH,
          t3EntryPath: entryPath,
          baseDir,
          logPath: path.join(baseDir, "userdata", "logs", "boot-service.log"),
          unitPath: path.join(unitDir, "t3code.service"),
        }),
      );
    }

    const commands: Array<RecordedCommand> = [];
    const spawns: Array<RecordedSpawn> = [];
    let exited = 0;
    // layerTest always reports mode "web"; desktop-managed contexts overlay
    // the mode the desktop app's bootstrap envelope would set.
    const configLayer =
      options?.desktopManaged === true
        ? Layer.effect(
            ServerConfig.ServerConfig,
            Effect.gen(function* () {
              const config = yield* ServerConfig.ServerConfig;
              return { ...config, mode: "desktop" as const };
            }),
          ).pipe(Layer.provide(ServerConfig.layerTest(home, baseDir)))
        : ServerConfig.layerTest(home, baseDir);
    const service = yield* SelfUpdate.make({
      host: {
        spawnDetached: (command, args) =>
          Effect.sync(() => spawns.push({ command, args })).pipe(
            Effect.andThen(
              options?.failSpawn === true
                ? Effect.fail(
                    new ProcessRunner.ProcessSpawnError({
                      command,
                      argumentCount: args.length,
                      cause: new Error("detached spawn failed"),
                    }),
                  )
                : Effect.void,
            ),
          ),
        exitProcess: () => {
          exited += 1;
        },
      },
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          makeRecordingRunnerLayer(commands, {
            failWhen: options?.failWhen,
            stdoutFor: options?.stdoutFor,
          }),
          configLayer,
        ),
      ),
      provideHostRefs({ platform: options?.platform ?? "linux", env, entryPath }),
    );
    return {
      fs,
      path,
      home,
      baseDir,
      entryPath,
      commands,
      spawns,
      exitCount: () => exited,
      service,
    };
  });

  it.effect("rejects dist-tags and other non-exact versions", () =>
    Effect.gen(function* () {
      const context = yield* makeContext();
      const error = yield* context.service.update({ targetVersion: "latest" }).pipe(Effect.flip);
      assert.include(error.reason, "not an exact t3 version");
      assert.lengthOf(context.commands, 0);
    }),
  );

  it.effect("refuses to update a desktop-managed backend and points at the app", () =>
    Effect.gen(function* () {
      const context = yield* makeContext({ desktopManaged: true, bootService: true });
      const error = yield* context.service.update({ targetVersion: "0.0.29" }).pipe(Effect.flip);
      assert.include(error.reason, "desktop app");
      assert.lengthOf(context.commands, 0);
      assert.lengthOf(context.spawns, 0);
    }),
  );

  it.effect("fails without touching anything when no update method applies", () =>
    Effect.gen(function* () {
      const context = yield* makeContext({
        entryPath: "/home/theo/dev/t3/apps/server/dist/bin.mjs",
      });
      const error = yield* context.service.update({ targetVersion: "0.0.29" }).pipe(Effect.flip);
      assert.include(error.reason, "cannot update itself");
      assert.lengthOf(context.commands, 0);
    }),
  );

  it.effect("surfaces a failed npm install and never schedules a restart", () =>
    Effect.gen(function* () {
      const context = yield* makeContext({ failWhen: (command) => command === "npm" });
      const error = yield* context.service.update({ targetVersion: "0.0.29" }).pipe(Effect.flip);
      assert.equal(error.reason, "Could not install the requested t3 version.");
      yield* TestClock.adjust(Duration.seconds(10));
      assert.lengthOf(context.spawns, 0);
      assert.equal(context.exitCount(), 0);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("reinstalls the same version after a failed preflight", () =>
    Effect.gen(function* () {
      let preflightAttempts = 0;
      const context = yield* makeContext({
        failWhen: (command) => {
          if (command !== NODE_PATH) return false;
          preflightAttempts += 1;
          return preflightAttempts === 1;
        },
      });
      const versionDir = context.path.join(context.baseDir, "runtime", "versions", "0.0.29");
      const entryPath = context.path.join(versionDir, "node_modules", "t3", "dist", "bin.mjs");
      yield* context.fs.makeDirectory(context.path.dirname(entryPath), { recursive: true });
      yield* context.fs.writeFileString(entryPath, "export {};\n");
      yield* context.fs.writeFileString(
        context.path.join(versionDir, ".install-complete"),
        "0.0.29\n",
      );

      const firstError = yield* context.service
        .update({ targetVersion: "0.0.29" })
        .pipe(Effect.flip);
      assert.include(firstError.reason, "failed its version check");
      assert.isFalse(yield* context.fs.exists(versionDir));

      const result = yield* context.service.update({ targetVersion: "0.0.29" });
      assert.deepEqual(result, { targetVersion: "0.0.29", method: "respawn" });
      assert.deepEqual(
        context.commands.map((entry) => entry.command),
        [NODE_PATH, "npm", NODE_PATH],
      );
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("rejects and removes an installed runtime that reports the wrong version", () =>
    Effect.gen(function* () {
      const context = yield* makeContext({
        stdoutFor: (command, args) =>
          command === NODE_PATH && args[1] === "--version" ? "0.0.28\n" : undefined,
      });
      const versionDir = context.path.join(context.baseDir, "runtime", "versions", "0.0.29");

      const error = yield* context.service.update({ targetVersion: "0.0.29" }).pipe(Effect.flip);

      assert.include(error.reason, "did not report the requested");
      assert.isFalse(yield* context.fs.exists(versionDir));
      assert.lengthOf(context.spawns, 0);
    }),
  );

  it.effect("reports a detached replacement spawn failure and leaves updates retryable", () =>
    Effect.gen(function* () {
      const context = yield* makeContext({ failSpawn: true });

      const first = yield* context.service.update({ targetVersion: "0.0.29" }).pipe(Effect.flip);
      assert.include(first.reason, "Could not start the replacement");

      const second = yield* context.service.update({ targetVersion: "0.0.29" }).pipe(Effect.flip);
      assert.include(second.reason, "Could not start the replacement");
      assert.notInclude(second.reason, "already in progress");
      assert.lengthOf(context.spawns, 2);
      assert.equal(context.exitCount(), 0);
    }),
  );

  it.effect("installs, preflights, and respawns a foreground server", () =>
    Effect.gen(function* () {
      const context = yield* makeContext();
      const result = yield* context.service.update({ targetVersion: "0.0.29" });
      assert.deepEqual(result, { targetVersion: "0.0.29", method: "respawn" });
      assert.lengthOf(context.spawns, 1);

      const concurrentError = yield* context.service
        .update({ targetVersion: "0.0.30" })
        .pipe(Effect.flip);
      assert.include(concurrentError.reason, "already in progress");

      const pinnedEntry = context.path.join(
        context.baseDir,
        "runtime/versions/0.0.29/node_modules/t3/dist/bin.mjs",
      );
      assert.deepEqual(
        context.commands.map((entry) => [entry.command, ...entry.args].join(" ")),
        [
          `npm install --prefix ${context.path.join(context.baseDir, "runtime/versions/0.0.29")} --no-fund --no-audit t3@0.0.29`,
          `${NODE_PATH} ${pinnedEntry} --version`,
        ],
      );

      // The restart is deferred so the RPC acknowledgement flushes first.
      yield* TestClock.adjust(Duration.seconds(10));
      assert.lengthOf(context.spawns, 1);
      const spawn = context.spawns[0];
      assert.equal(spawn?.command, "/bin/sh");
      assert.include(spawn?.args ?? [], pinnedEntry);
      // The replacement replays the original CLI arguments.
      assert.include(spawn?.args ?? [], "serve");
      assert.equal(context.exitCount(), 1);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("rewrites the systemd unit and restarts the boot service", () =>
    Effect.gen(function* () {
      const context = yield* makeContext({ bootService: true });
      const result = yield* context.service.update({ targetVersion: "0.0.29" });
      assert.deepEqual(result, { targetVersion: "0.0.29", method: "boot-service" });

      const pinnedEntry = context.path.join(
        context.baseDir,
        "runtime/versions/0.0.29/node_modules/t3/dist/bin.mjs",
      );
      const unit = yield* context.fs.readFileString(
        context.path.join(context.home, ".config", "systemd", "user", "t3code.service"),
      );
      assert.include(unit, `ExecStart=${NODE_PATH} ${pinnedEntry} serve`);
      assert.deepEqual(
        context.commands.map((entry) => entry.command),
        ["npm", NODE_PATH, "systemctl", "systemctl"],
      );
      assert.deepEqual(context.commands[2]?.args, ["--user", "daemon-reload"]);

      assert.deepEqual(context.commands[3], {
        command: "systemctl",
        args: ["--user", "restart", "t3code.service"],
      });
      assert.lengthOf(context.spawns, 0);
      // systemd replaces the process; the server must not exit itself.
      assert.equal(context.exitCount(), 0);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("restores the previous unit and permits a retry when systemd restart fails", () =>
    Effect.gen(function* () {
      let failRestart = true;
      const context = yield* makeContext({
        bootService: true,
        failWhen: (command, args) => {
          if (command !== "systemctl" || args[1] !== "restart" || !failRestart) {
            return false;
          }
          failRestart = false;
          return true;
        },
      });
      const unitPath = context.path.join(
        context.home,
        ".config",
        "systemd",
        "user",
        BOOT_SERVICE_UNIT_FILE,
      );
      const previousUnit = yield* context.fs.readFileString(unitPath);

      const first = yield* context.service.update({ targetVersion: "0.0.29" }).pipe(Effect.flip);
      assert.include(first.reason, "Restarting the systemd boot service failed");
      assert.equal(yield* context.fs.readFileString(unitPath), previousUnit);
      assert.deepEqual(
        context.commands.slice(-2).map((entry) => entry.args),
        [
          ["--user", "restart", BOOT_SERVICE_UNIT_FILE],
          ["--user", "daemon-reload"],
        ],
      );

      const retry = yield* context.service.update({ targetVersion: "0.0.30" });
      assert.deepEqual(retry, { targetVersion: "0.0.30", method: "boot-service" });
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("restores the previous systemd unit when daemon-reload fails", () =>
    Effect.gen(function* () {
      const context = yield* makeContext({
        bootService: true,
        failWhen: (command) => command === "systemctl",
      });
      const unitPath = context.path.join(
        context.home,
        ".config",
        "systemd",
        "user",
        BOOT_SERVICE_UNIT_FILE,
      );
      const previousUnit = yield* context.fs.readFileString(unitPath);

      const error = yield* context.service.update({ targetVersion: "0.0.29" }).pipe(Effect.flip);
      assert.include(error.reason, "Reloading systemd units failed");
      assert.equal(yield* context.fs.readFileString(unitPath), previousUnit);
      assert.deepEqual(
        context.commands.map((entry) => entry.command),
        ["npm", NODE_PATH, "systemctl", "systemctl"],
      );

      yield* TestClock.adjust(Duration.seconds(10));
      assert.lengthOf(context.spawns, 0);
      assert.equal(context.exitCount(), 0);
    }).pipe(Effect.provide(TestClock.layer())),
  );
});
