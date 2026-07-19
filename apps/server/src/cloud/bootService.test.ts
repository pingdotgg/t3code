import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import {
  HostProcessArguments,
  HostProcessExecutablePath,
  HostProcessPlatform,
} from "@t3tools/shared/hostProcess";

import * as ProcessRunner from "../processRunner.ts";
import * as BootService from "./bootService.ts";

const isUnsupportedError = Schema.is(BootService.BootServiceUnsupportedError);
const isCommandError = Schema.is(BootService.BootServiceCommandError);

interface RecordedCommand {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
}

const makeRecordingRunnerLayer = (
  commands: Array<RecordedCommand>,
  options?: {
    readonly failCommand?: string;
    readonly failWhen?: (command: string, args: ReadonlyArray<string>) => boolean;
  },
) =>
  Layer.succeed(
    ProcessRunner.ProcessRunner,
    ProcessRunner.ProcessRunner.of({
      run: (input) =>
        Effect.sync(() => {
          assert.isUndefined(input.env);
          commands.push({ command: input.command, args: input.args });
          const failed =
            input.command === options?.failCommand ||
            options?.failWhen?.(input.command, input.args) === true;
          return {
            stdout: "",
            stderr: failed ? `${input.command} exploded` : "",
            code: ChildProcessSpawner.ExitCode(failed ? 1 : 0),
            timedOut: false,
            stdoutTruncated: false,
            stderrTruncated: false,
          };
        }),
    }),
  );

const makeHost = (entry: string): BootService.BootServiceHost => ({
  execPath: "/usr/local/bin/node",
  cliEntryPath: entry,
});

const provideHostRefs = (home: string, platform: NodeJS.Platform = "linux") =>
  Effect.provide(
    Layer.mergeAll(
      Layer.succeed(HostProcessPlatform, platform),
      ConfigProvider.layer(ConfigProvider.fromEnv({ env: { HOME: home } })),
    ),
  );

const makeTestContext = Effect.fn("test.makeTestContext")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-boot-service-test-" });
  // A real file for the stable-entry cases so status can confirm the entry
  // point exists.
  const stableEntry = path.join(root, "bin.mjs");
  yield* fs.writeFileString(stableEntry, "#!/usr/bin/env node\n");
  return {
    fs,
    path,
    dirs: {
      home: root,
      baseDir: path.join(root, ".t3"),
      logsDir: path.join(root, ".t3", "userdata", "logs"),
      stableEntry,
    },
  };
});

it("renders a systemd unit with absolute paths and append-mode logging", () => {
  const unit = BootService.renderBootServiceUnit({
    nodePath: "/usr/local/bin/node",
    t3EntryPath: "/home/theo/.t3/runtime/versions/0.0.27/node_modules/t3/dist/bin.mjs",
    baseDir: "/home/theo/.t3",
    logPath: "/home/theo/.t3/userdata/logs/boot-service.log",
    unitPath: "/home/theo/.config/systemd/user/t3code.service",
  });

  assert.equal(
    unit,
    [
      "[Unit]",
      "Description=T3 Code server (T3 Connect)",
      "StartLimitIntervalSec=300",
      "StartLimitBurst=5",
      "",
      "[Service]",
      "Type=simple",
      "WorkingDirectory=%h",
      "Environment=T3CODE_HOME=/home/theo/.t3",
      "ExecStart=/usr/local/bin/node /home/theo/.t3/runtime/versions/0.0.27/node_modules/t3/dist/bin.mjs serve",
      "Restart=always",
      "RestartSec=5",
      "StandardOutput=append:/home/theo/.t3/userdata/logs/boot-service.log",
      "StandardError=append:/home/theo/.t3/userdata/logs/boot-service.log",
      "",
      "[Install]",
      "WantedBy=default.target",
      "",
    ].join("\n"),
  );
});

it("quotes systemd values containing spaces and escapes percent specifiers", () => {
  assert.equal(BootService.quoteSystemdValue("/plain/path"), "/plain/path");
  assert.equal(BootService.quoteSystemdValue("/home/me/T3 Data"), '"/home/me/T3 Data"');
  assert.equal(BootService.quoteSystemdValue("/opt/100%cpu"), "/opt/100%%cpu");

  const unit = BootService.renderBootServiceUnit({
    nodePath: "/home/me/my tools/node",
    t3EntryPath: "/home/me/T3 Data/bin.mjs",
    baseDir: "/home/me/T3 Data",
    logPath: "/home/me/100%logs/boot.log",
    unitPath: "/home/me/.config/systemd/user/t3code.service",
  });
  assert.include(unit, 'ExecStart="/home/me/my tools/node" "/home/me/T3 Data/bin.mjs" serve');
  assert.include(unit, 'Environment=T3CODE_HOME="/home/me/T3 Data"');
  // append: paths take the rest of the line literally (spaces are fine,
  // quoting is not), but % still goes through specifier expansion.
  assert.include(unit, "StandardOutput=append:/home/me/100%%logs/boot.log");
  assert.include(unit, "StandardError=append:/home/me/100%%logs/boot.log");
});

it("flags package-manager cache entry points as ephemeral", () => {
  assert.isTrue(
    BootService.isEphemeralCacheEntry("/home/theo/.npm/_npx/abc123/node_modules/t3/dist/bin.mjs"),
  );
  assert.isTrue(
    BootService.isEphemeralCacheEntry("C:\\Users\\theo\\AppData\\npm-cache\\_npx\\abc\\bin.mjs"),
  );
  assert.isTrue(
    BootService.isEphemeralCacheEntry(
      "/home/theo/.cache/pnpm/dlx/abc/node_modules/t3/dist/bin.mjs",
    ),
  );
  assert.isTrue(
    BootService.isEphemeralCacheEntry("/home/theo/.bun/install/cache/t3@0.0.27/dist/bin.mjs"),
  );
  assert.isFalse(BootService.isEphemeralCacheEntry("/usr/local/lib/node_modules/t3/dist/bin.mjs"));
  assert.isFalse(
    BootService.isEphemeralCacheEntry(
      "/home/theo/dev/pnpm/dlx-tools/t3/node_modules/t3/dist/bin.mjs",
    ),
  );
  assert.isFalse(
    BootService.isEphemeralCacheEntry(
      "/home/theo/.t3/runtime/versions/0.0.27/node_modules/t3/dist/bin.mjs",
    ),
  );
});

it.layer(NodeServices.layer)("BootService", (it) => {
  it.effect("installs the unit, enables the service, and enables linger", () =>
    Effect.gen(function* () {
      const { dirs, fs, path } = yield* makeTestContext();
      const commands: Array<RecordedCommand> = [];
      const service = yield* BootService.make({
        baseDir: dirs.baseDir,
        logsDir: dirs.logsDir,
        cliVersion: "0.0.27",
        host: makeHost(dirs.stableEntry),
      }).pipe(Effect.provide(makeRecordingRunnerLayer(commands)), provideHostRefs(dirs.home));

      const plan = yield* service.install;

      // A stable entry point is reused directly — no npm install.
      assert.equal(plan.t3EntryPath, dirs.stableEntry);
      assert.deepEqual(
        commands.map((entry) => [entry.command, ...entry.args].join(" ")),
        [
          "systemctl --user daemon-reload",
          "systemctl --user enable t3code.service",
          // restart (not enable --now) so repairing a stale unit replaces a
          // running process instead of leaving the old one until reboot.
          "systemctl --user restart t3code.service",
          "loginctl enable-linger",
        ],
      );

      const unitPath = path.join(dirs.home, ".config", "systemd", "user", "t3code.service");
      const unit = yield* fs.readFileString(unitPath);
      assert.include(unit, `ExecStart=/usr/local/bin/node ${dirs.stableEntry} serve`);
      assert.include(unit, `Environment=T3CODE_HOME=${dirs.baseDir}`);

      const status = yield* service.status;
      assert.isTrue(status.supported);
      assert.isTrue(status.installed);
      assert.isTrue(status.current);

      const removed = yield* service.uninstall;
      assert.isTrue(removed);
      assert.isFalse(yield* fs.exists(unitPath));
      const statusAfter = yield* service.status;
      assert.isFalse(statusAfter.installed);
      const removedAgain = yield* service.uninstall;
      assert.isFalse(removedAgain);
    }),
  );

  it.effect("pins a runtime via npm install when running from the npx cache", () =>
    Effect.gen(function* () {
      const { dirs, fs, path } = yield* makeTestContext();
      const commands: Array<RecordedCommand> = [];
      const service = yield* BootService.make({
        baseDir: dirs.baseDir,
        logsDir: dirs.logsDir,
        cliVersion: "0.0.27",
        host: makeHost("/home/theo/.npm/_npx/abc/node_modules/t3/dist/bin.mjs"),
      }).pipe(Effect.provide(makeRecordingRunnerLayer(commands)), provideHostRefs(dirs.home));

      const plan = yield* service.install;

      const runtimeDir = path.join(dirs.baseDir, "runtime", "versions", "0.0.27");
      assert.equal(
        plan.t3EntryPath,
        path.join(runtimeDir, "node_modules", "t3", "dist", "bin.mjs"),
      );
      assert.deepEqual(commands[0], {
        command: "npm",
        args: ["install", "--prefix", runtimeDir, "--no-fund", "--no-audit", "t3@0.0.27"],
      });
      // Success is recorded via a sentinel so interrupted installs re-run.
      assert.isTrue(yield* fs.exists(path.join(runtimeDir, ".install-complete")));
    }),
  );

  it.effect("reinstalls a pinned runtime when its entry point is missing", () =>
    Effect.gen(function* () {
      const { dirs, fs, path } = yield* makeTestContext();
      const commands: Array<RecordedCommand> = [];
      const service = yield* BootService.make({
        baseDir: dirs.baseDir,
        logsDir: dirs.logsDir,
        cliVersion: "0.0.27",
        host: makeHost("/home/theo/.npm/_npx/abc/node_modules/t3/dist/bin.mjs"),
      }).pipe(Effect.provide(makeRecordingRunnerLayer(commands)), provideHostRefs(dirs.home));

      const plan = yield* service.install;
      yield* fs.makeDirectory(path.dirname(plan.t3EntryPath), { recursive: true });
      yield* fs.writeFileString(plan.t3EntryPath, "#!/usr/bin/env node\n");
      yield* fs.remove(plan.t3EntryPath);
      commands.length = 0;

      yield* service.install;

      assert.isTrue(commands.some(({ command }) => command === "npm"));
    }),
  );

  it.effect("reads executable metadata from host process references", () =>
    Effect.gen(function* () {
      const { dirs } = yield* makeTestContext();
      const commands: Array<RecordedCommand> = [];
      const service = yield* BootService.make({
        baseDir: dirs.baseDir,
        logsDir: dirs.logsDir,
        cliVersion: "0.0.27",
      }).pipe(
        Effect.provide(makeRecordingRunnerLayer(commands)),
        provideHostRefs(dirs.home),
        Effect.provideService(HostProcessExecutablePath, "/opt/node/bin/node"),
        Effect.provideService(HostProcessArguments, ["/opt/node/bin/node", dirs.stableEntry]),
      );

      const plan = yield* service.install;
      assert.equal(plan.nodePath, "/opt/node/bin/node");
      assert.equal(plan.t3EntryPath, dirs.stableEntry);
    }),
  );

  it.effect("cleans up and fails when the pinned runtime install fails", () =>
    Effect.gen(function* () {
      const { dirs, fs, path } = yield* makeTestContext();
      const commands: Array<RecordedCommand> = [];
      const service = yield* BootService.make({
        baseDir: dirs.baseDir,
        logsDir: dirs.logsDir,
        cliVersion: "0.0.27",
        host: makeHost("/home/theo/.npm/_npx/abc/node_modules/t3/dist/bin.mjs"),
      }).pipe(
        Effect.provide(makeRecordingRunnerLayer(commands, { failCommand: "npm" })),
        provideHostRefs(dirs.home),
      );

      const error = yield* service.install.pipe(Effect.flip);
      assert.isTrue(isCommandError(error));
      const runtimeDir = path.join(dirs.baseDir, "runtime", "versions", "0.0.27");
      // The half-installed tree must not be reused by the next attempt.
      assert.isFalse(yield* fs.exists(runtimeDir));
      assert.isFalse(yield* fs.exists(path.join(runtimeDir, ".install-complete")));
    }),
  );

  it.effect("reports an installed-but-stale unit so connect can offer a repair", () =>
    Effect.gen(function* () {
      const { dirs, fs, path } = yield* makeTestContext();
      const commands: Array<RecordedCommand> = [];
      const service = yield* BootService.make({
        baseDir: dirs.baseDir,
        logsDir: dirs.logsDir,
        cliVersion: "0.0.27",
        host: makeHost(dirs.stableEntry),
      }).pipe(Effect.provide(makeRecordingRunnerLayer(commands)), provideHostRefs(dirs.home));

      const unitDir = path.join(dirs.home, ".config", "systemd", "user");
      yield* fs.makeDirectory(unitDir, { recursive: true });
      yield* fs.writeFileString(
        path.join(unitDir, "t3code.service"),
        "[Service]\nExecStart=/old/node /old/t3 serve\n",
      );

      const status = yield* service.status;
      assert.isTrue(status.supported);
      assert.isTrue(status.installed);
      assert.isFalse(status.current);
    }),
  );

  it.effect("reports a current unit as stale when its entry point is gone", () =>
    Effect.gen(function* () {
      const { dirs, fs } = yield* makeTestContext();
      const commands: Array<RecordedCommand> = [];
      const service = yield* BootService.make({
        baseDir: dirs.baseDir,
        logsDir: dirs.logsDir,
        cliVersion: "0.0.27",
        host: makeHost(dirs.stableEntry),
      }).pipe(Effect.provide(makeRecordingRunnerLayer(commands)), provideHostRefs(dirs.home));

      yield* service.install;
      assert.isTrue((yield* service.status).current);

      // The pinned runtime (or global bin) was deleted to reclaim space; the
      // unit still matches byte-for-byte but would crashloop at boot.
      yield* fs.remove(dirs.stableEntry);
      const status = yield* service.status;
      assert.isTrue(status.installed);
      assert.isFalse(status.current);
    }),
  );

  it.effect("fails on non-Linux platforms without touching the filesystem", () =>
    Effect.gen(function* () {
      const { dirs, fs, path } = yield* makeTestContext();
      const commands: Array<RecordedCommand> = [];
      const service = yield* BootService.make({
        baseDir: dirs.baseDir,
        logsDir: dirs.logsDir,
        cliVersion: "0.0.27",
        host: makeHost("/usr/local/lib/node_modules/t3/dist/bin.mjs"),
      }).pipe(
        Effect.provide(makeRecordingRunnerLayer(commands)),
        provideHostRefs(dirs.home, "darwin"),
      );

      const error = yield* service.install.pipe(Effect.flip);
      assert.isTrue(isUnsupportedError(error));
      assert.lengthOf(commands, 0);
      assert.isFalse(
        yield* fs.exists(path.join(dirs.home, ".config", "systemd", "user", "t3code.service")),
      );

      const status = yield* service.status;
      assert.isFalse(status.supported);
      assert.isFalse(status.installed);
    }),
  );

  it.effect("removes the unit file when an activation step fails", () =>
    Effect.gen(function* () {
      const { dirs, fs, path } = yield* makeTestContext();
      const commands: Array<RecordedCommand> = [];
      const service = yield* BootService.make({
        baseDir: dirs.baseDir,
        logsDir: dirs.logsDir,
        cliVersion: "0.0.27",
        host: makeHost("/usr/local/lib/node_modules/t3/dist/bin.mjs"),
      }).pipe(
        Effect.provide(makeRecordingRunnerLayer(commands, { failCommand: "loginctl" })),
        provideHostRefs(dirs.home),
      );

      const error = yield* service.install.pipe(Effect.flip);
      assert.isTrue(isCommandError(error));
      // A leftover unit would make the next connect report "already set up"
      // even though linger never happened.
      assert.isFalse(
        yield* fs.exists(path.join(dirs.home, ".config", "systemd", "user", "t3code.service")),
      );
      const status = yield* service.status;
      assert.isFalse(status.installed);
      assert.isTrue(
        commands.some(
          ({ command, args }) =>
            command === "systemctl" && args.join(" ") === "--user disable --now t3code.service",
        ),
      );
    }),
  );

  it.effect("restores the previous unit when a repair cannot activate", () =>
    Effect.gen(function* () {
      const { dirs, fs, path } = yield* makeTestContext();
      const initialCommands: Array<RecordedCommand> = [];
      const initialService = yield* BootService.make({
        baseDir: dirs.baseDir,
        logsDir: dirs.logsDir,
        cliVersion: "0.0.27",
        host: makeHost(dirs.stableEntry),
      }).pipe(
        Effect.provide(makeRecordingRunnerLayer(initialCommands)),
        provideHostRefs(dirs.home),
      );
      yield* initialService.install;

      const unitPath = path.join(dirs.home, ".config", "systemd", "user", "t3code.service");
      const previousUnit = yield* fs.readFileString(unitPath);
      const replacementEntry = path.join(dirs.home, "replacement-bin.mjs");
      yield* fs.writeFileString(replacementEntry, "#!/usr/bin/env node\n");
      const repairCommands: Array<RecordedCommand> = [];
      const repairService = yield* BootService.make({
        baseDir: dirs.baseDir,
        logsDir: dirs.logsDir,
        cliVersion: "0.0.28",
        host: makeHost(replacementEntry),
      }).pipe(
        Effect.provide(makeRecordingRunnerLayer(repairCommands, { failCommand: "loginctl" })),
        provideHostRefs(dirs.home),
      );

      const error = yield* repairService.install.pipe(Effect.flip);

      assert.isTrue(isCommandError(error));
      assert.equal(yield* fs.readFileString(unitPath), previousUnit);
      assert.isTrue(
        repairCommands.some(
          ({ command, args }) =>
            command === "systemctl" && args.join(" ") === "--user restart t3code.service",
        ),
      );
    }),
  );

  it.effect("keeps the unit when stopping it during uninstall fails", () =>
    Effect.gen(function* () {
      const { dirs, fs, path } = yield* makeTestContext();
      const installCommands: Array<RecordedCommand> = [];
      const installedService = yield* BootService.make({
        baseDir: dirs.baseDir,
        logsDir: dirs.logsDir,
        cliVersion: "0.0.27",
        host: makeHost(dirs.stableEntry),
      }).pipe(
        Effect.provide(makeRecordingRunnerLayer(installCommands)),
        provideHostRefs(dirs.home),
      );
      yield* installedService.install;

      const uninstallCommands: Array<RecordedCommand> = [];
      const failingService = yield* BootService.make({
        baseDir: dirs.baseDir,
        logsDir: dirs.logsDir,
        cliVersion: "0.0.27",
        host: makeHost(dirs.stableEntry),
      }).pipe(
        Effect.provide(
          makeRecordingRunnerLayer(uninstallCommands, {
            failWhen: (command, args) =>
              command === "systemctl" && args.includes("disable") && args.includes("--now"),
          }),
        ),
        provideHostRefs(dirs.home),
      );

      const error = yield* failingService.uninstall.pipe(Effect.flip);

      assert.isTrue(isCommandError(error));
      assert.isTrue(
        yield* fs.exists(path.join(dirs.home, ".config", "systemd", "user", "t3code.service")),
      );
    }),
  );

  it.effect("appends failed steps to the boot-service log", () =>
    Effect.gen(function* () {
      const { dirs, fs, path } = yield* makeTestContext();
      const commands: Array<RecordedCommand> = [];
      const service = yield* BootService.make({
        baseDir: dirs.baseDir,
        logsDir: dirs.logsDir,
        cliVersion: "0.0.27",
        host: makeHost("/usr/local/lib/node_modules/t3/dist/bin.mjs"),
      }).pipe(
        Effect.provide(makeRecordingRunnerLayer(commands, { failCommand: "systemctl" })),
        provideHostRefs(dirs.home),
      );

      const error = yield* service.install.pipe(Effect.flip);
      assert.isTrue(isCommandError(error));
      if (!isCommandError(error)) return;
      assert.equal(error.exitCode, 1);
      assert.equal(error.stderrLength, "systemctl exploded".length);

      const logPath = path.join(dirs.logsDir, "boot-service.log");
      assert.isTrue(yield* fs.exists(logPath));
      assert.include(yield* fs.readFileString(logPath), "exit code 1");
    }),
  );
});
