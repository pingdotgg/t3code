import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopLinuxUrlHandler from "./DesktopLinuxUrlHandler.ts";

const RUN_XDG_RESOLVER_TEST = process.env.T3CODE_RUN_LINUX_URL_HANDLER_RESOLVER_TEST === "1";

describe.runIf(RUN_XDG_RESOLVER_TEST)("DesktopLinuxUrlHandler xdg resolver", () => {
  it.effect("remains selected by xdg-mime and GIO after registration and restart", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const liveSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3code-linux-url-handler-",
      });
      const homeDirectory = path.join(root, "home");
      const xdgConfigHome = path.join(root, "config");
      const xdgDataHome = path.join(root, "data");
      const applicationsDir = path.join(xdgDataHome, "applications");
      const launcherPath = path.join(root, "bin", "t3code-nightly");
      yield* fileSystem.makeDirectory(homeDirectory, { recursive: true });
      yield* fileSystem.makeDirectory(path.dirname(launcherPath), { recursive: true });
      yield* fileSystem.makeDirectory(applicationsDir, { recursive: true });
      yield* fileSystem.writeFileString(launcherPath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      yield* fileSystem.chmod(launcherPath, 0o755);

      const sandboxEnv = {
        HOME: homeDirectory,
        XDG_CONFIG_HOME: xdgConfigHome,
        XDG_DATA_HOME: xdgDataHome,
        XDG_DATA_DIRS: "/usr/local/share:/usr/share",
        XDG_CURRENT_DESKTOP: "",
        DESKTOP_SESSION: "",
        DE: "",
        LC_ALL: "C",
      };
      const sandboxSpawner = ChildProcessSpawner.make((command) => {
        if (command._tag !== "StandardCommand") {
          return liveSpawner.spawn(command);
        }
        return liveSpawner.spawn(
          ChildProcess.make(command.command, command.args, {
            ...command.options,
            env: { ...command.options.env, ...sandboxEnv },
            extendEnv: true,
          }),
        );
      });

      const runSandboxCommand = Effect.fn("desktop.linuxUrlHandler.test.runCommand")(function* (
        command: string,
        args: ReadonlyArray<string>,
      ) {
        const handle = yield* liveSpawner.spawn(
          ChildProcess.make(command, args, {
            env: sandboxEnv,
            extendEnv: true,
          }),
        );
        const output = yield* handle.all.pipe(Stream.decodeText(), Stream.mkString);
        const exitCode = Number(yield* handle.exitCode);
        return { exitCode, output };
      });

      const makeEnvironment = (appImagePath: string) =>
        DesktopEnvironment.DesktopEnvironment.of({
          platform: "linux",
          isPackaged: true,
          isDevelopment: false,
          displayName: "T3 Code (Nightly)",
          linuxWmClass: "t3code",
          linuxApplicationsDir: applicationsDir,
          appImagePath: Option.some(appImagePath),
          linuxUrlHandlerExecutableOverride: Option.some(launcherPath),
          path,
        } as unknown as DesktopEnvironment.DesktopEnvironment["Service"]);

      const register = (appImagePath: string) =>
        DesktopLinuxUrlHandler.make.pipe(
          Effect.provideService(
            DesktopEnvironment.DesktopEnvironment,
            makeEnvironment(appImagePath),
          ),
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, sandboxSpawner),
          Effect.flatMap((handler) => handler.register),
        );

      const verifyResolvers = Effect.gen(function* () {
        const desktopEntryPath = path.join(
          applicationsDir,
          DesktopLinuxUrlHandler.URL_HANDLER_DESKTOP_ENTRY_NAME,
        );
        const desktopEntry = yield* fileSystem.readFileString(desktopEntryPath);
        assert.include(desktopEntry, `Exec=${launcherPath} %U`);
        assert.notInclude(desktopEntry, `Exec="${launcherPath}" %U`);

        const validation = yield* runSandboxCommand("desktop-file-validate", [desktopEntryPath]);
        assert.equal(validation.exitCode, 0, validation.output);
        const databaseUpdate = yield* runSandboxCommand("update-desktop-database", [
          applicationsDir,
        ]);
        assert.equal(databaseUpdate.exitCode, 0, databaseUpdate.output);

        const xdgQuery = yield* runSandboxCommand("xdg-mime", [
          "query",
          "default",
          "x-scheme-handler/t3code",
        ]);
        assert.equal(xdgQuery.exitCode, 0, xdgQuery.output);
        assert.equal(xdgQuery.output.trim(), DesktopLinuxUrlHandler.URL_HANDLER_DESKTOP_ENTRY_NAME);

        const gioQuery = yield* runSandboxCommand("gio", ["mime", "x-scheme-handler/t3code"]);
        assert.equal(gioQuery.exitCode, 0, gioQuery.output);
        const defaultApplication = gioQuery.output
          .split("\n")
          .find((line) => line.startsWith("Default application"));
        assert.include(defaultApplication, DesktopLinuxUrlHandler.URL_HANDLER_DESKTOP_ENTRY_NAME);
      });

      yield* register(path.join(root, "T3-Code.AppImage"));
      yield* verifyResolvers;
      yield* register(path.join(root, "T3-Code-New.AppImage"));
      yield* verifyResolvers;
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
