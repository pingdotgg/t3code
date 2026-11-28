import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import packageJson from "../../package.json" with { type: "json" };
import { posixLauncherScript } from "../cloud/pinnedRuntime.ts";
import {
  hostShellWord,
  resolveHostCliCommand,
  resolveRootCliCommand,
  resolveServerInstallation,
} from "./invocation.ts";

it.layer(NodeServices.layer)("root CLI commands", (it) => {
  const rootCommand = (input: {
    readonly node: string;
    readonly entry: string;
    readonly path?: string;
    readonly env?: Record<string, string>;
    readonly executable?: boolean;
    readonly args?: ReadonlyArray<string>;
  }) =>
    resolveRootCliCommand("browser setup", input.args).pipe(
      Effect.provideService(HostProcess.ExecutablePath, input.node),
      Effect.provideService(HostProcess.Arguments, [input.node, input.entry]),
      Effect.provideService(HostProcess.IsExecutable, input.executable ?? false),
      Effect.provideService(HostProcess.Platform, "linux"),
      Effect.provideService(HostProcess.Environment, { PATH: input.path ?? "", ...input.env }),
    );

  const pathWithT3 = Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const bin = yield* fs.makeTempDirectoryScoped();
    yield* fs.writeFileString(path.join(bin, "hyakki"), "#!/bin/sh\n", { mode: 0o755 });
    return bin;
  });

  it.effect("keeps a user-installed Node reachable when the command runs under sudo", () =>
    Effect.gen(function* () {
      const npx = "/home/tara/.npm/_npx/abc/node_modules/t3/dist/bin.mjs";
      expect(yield* rootCommand({ node: "/usr/bin/node", entry: npx })).toBe(
        "sudo hyakki browser setup",
      );
      expect(
        yield* rootCommand({ node: "/home/tara/.nvm/versions/node/v24/bin/node", entry: npx }),
      ).toBe('sudo env "PATH=$PATH" hyakki browser setup');
      expect(
        yield* rootCommand({
          node: "/home/tara/.local/node/bin/node",
          entry: "/home/tara/.local/lib/node_modules/t3/dist/bin.mjs",
          path: yield* pathWithT3,
        }),
      ).toBe('sudo env "PATH=$PATH" hyakki browser setup');
    }),
  );

  it.effect("keeps the arguments, so root runs setup on the same Hyakki home", () =>
    Effect.gen(function* () {
      const args = ["--base-dir", "/srv/t3 home"];
      expect(
        yield* rootCommand({
          node: "/home/tara/.local/node/bin/node",
          entry: "/home/tara/.local/lib/node_modules/t3/dist/bin.mjs",
          path: yield* pathWithT3,
          args,
        }),
      ).toBe(`sudo env "PATH=$PATH" hyakki browser setup --base-dir '/srv/t3 home'`);
      expect(
        yield* rootCommand({ node: "/opt/t3/t3", entry: "/opt/t3/t3", executable: true, args }),
      ).toBe("sudo /opt/t3/t3 browser setup --base-dir '/srv/t3 home'");
    }),
  );

  it.effect("names this install's launcher when t3 is not on PATH", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped();
      const shim = path.join(home, ".local bin", "hyakki");
      yield* fs.makeDirectory(path.dirname(shim), { recursive: true });
      yield* fs.writeFileString(shim, "#!/bin/sh\n", { mode: 0o755 });
      const desktop = {
        node: "/tmp/.mount_T3abc/t3code",
        entry: "/tmp/.mount_T3abc/resources/app.asar/apps/server/dist/bin.mjs",
        env: { HYAKKI_CLI_PATH: shim },
      };

      expect(yield* rootCommand(desktop)).toBe(`sudo '${shim}' browser setup`);

      // An unrelated `hyakki` on PATH, such as an older npm global, is another install's CLI.
      expect(yield* rootCommand({ ...desktop, path: yield* pathWithT3 })).toBe(
        `sudo '${shim}' browser setup`,
      );

      // The link the app installs onto PATH leads to its own launcher, so plain `hyakki` is right.
      const linked = yield* fs.makeTempDirectoryScoped();
      yield* fs.symlink(shim, path.join(linked, "hyakki"));
      expect(yield* rootCommand({ ...desktop, path: linked })).toBe(
        'sudo env "PATH=$PATH" hyakki browser setup',
      );

      expect(
        yield* rootCommand({
          node: "/opt/t3/t3",
          entry: "/opt/t3/t3",
          executable: true,
        }),
      ).toBe("sudo /opt/t3/t3 browser setup");

      // A standalone executable started directly (systemd, no launcher) is still this install.
      expect(
        yield* rootCommand({
          node: "/opt/t3/t3",
          entry: "/opt/t3/t3",
          executable: true,
          path: yield* pathWithT3,
        }),
      ).toBe("sudo /opt/t3/t3 browser setup");

      // A global npm launcher runs the downloaded executable; PATH's `hyakki` is that launcher.
      const prefix = path.join(home, "npm");
      const npmLauncher = path.join(prefix, "lib/node_modules/t3/bin/t3.mjs");
      yield* fs.makeDirectory(path.dirname(npmLauncher), { recursive: true });
      yield* fs.makeDirectory(path.join(prefix, "bin"));
      yield* fs.writeFileString(npmLauncher, "", { mode: 0o755 });
      yield* fs.writeFileString(
        path.join(prefix, "lib/node_modules/t3/package.json"),
        `{"name":"t3","version":"${packageJson.version}"}`,
      );
      yield* fs.symlink(npmLauncher, path.join(prefix, "bin/t3"));
      expect(
        yield* rootCommand({
          node: "/home/tara/.hyakki/runtime/versions/1.0.0/t3",
          entry: "/home/tara/.hyakki/runtime/versions/1.0.0/t3",
          executable: true,
          path: path.join(prefix, "bin"),
          env: { HYAKKI_NPM_LAUNCHER_PATH: npmLauncher },
        }),
      ).toBe("sudo /home/tara/.hyakki/runtime/versions/1.0.0/t3 browser setup");

      expect(
        yield* rootCommand({ ...desktop, env: { HYAKKI_CLI_PATH: path.join(home, "gone") } }),
      ).toBe('sudo env "PATH=$PATH" hyakki browser setup');
    }),
  );
});

it.layer(NodeServices.layer)("host CLI commands", (it) => {
  it.effect("renders a PowerShell command line on Windows", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped();
      const shim = path.join(home, "hyakki.cmd");
      yield* fs.writeFileString(shim, "@echo off\r\n");
      const hostCommand = (platform: NodeJS.Platform, env: Record<string, string>) =>
        resolveHostCliCommand("doctor", ["--base-dir", "C:\\Users\\Jane Doe\\.hyakki"]).pipe(
          Effect.provideService(HostProcess.ExecutablePath, "C:\\Program Files\\Hyakki\\t3.exe"),
          Effect.provideService(HostProcess.Arguments, [
            "C:\\Program Files\\Hyakki\\t3.exe",
            "C:\\Program Files\\Hyakki\\resources\\app.asar\\apps\\server\\dist\\bin.mjs",
          ]),
          Effect.provideService(HostProcess.IsExecutable, false),
          Effect.provideService(HostProcess.Platform, platform),
          Effect.provideService(HostProcess.Environment, { PATH: "", ...env }),
        );
      expect((yield* hostCommand("win32", { HYAKKI_CLI_PATH: shim })).command).toBe(
        `& "${shim}" doctor "--base-dir" "C:\\Users\\Jane Doe\\.hyakki"`,
      );
      expect((yield* hostCommand("win32", {})).command).toBe(
        'hyakki doctor "--base-dir" "C:\\Users\\Jane Doe\\.hyakki"',
      );
      expect(
        (yield* resolveHostCliCommand("doctor", ["--base-dir", "C:\\T3\\\u201CArchive\u201D"]).pipe(
          Effect.provideService(HostProcess.Platform, "win32"),
          Effect.provideService(HostProcess.Environment, { PATH: "" }),
          Effect.provideService(HostProcess.ExecutablePath, "C:\\t3.exe"),
          Effect.provideService(HostProcess.Arguments, ["C:\\t3.exe", "C:\\bin.mjs"]),
          Effect.provideService(HostProcess.IsExecutable, false),
        )).command,
      ).toBe('hyakki doctor "--base-dir" "C:\\T3\\\u201C\u201CArchive\u201D\u201D"');
      expect((yield* hostCommand("linux", { HYAKKI_CLI_PATH: shim })).command).toMatch(
        / doctor --base-dir 'C:\\Users\\Jane Doe\\\.hyakki'$/,
      );
    }),
  );

  it.effect.skipIf(HostProcess.Platform.defaultValue() === "win32")(
    "names the absolute path of a t3 found through a relative PATH entry",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const bin = yield* fs.makeTempDirectoryScoped();
        yield* fs.writeFileString(path.join(bin, "hyakki"), "#!/bin/sh\n", { mode: 0o755 });
        const hostCommand = (searchPath: string) =>
          resolveHostCliCommand("doctor").pipe(
            Effect.provideService(HostProcess.ExecutablePath, "/usr/bin/node"),
            Effect.provideService(HostProcess.Arguments, [
              "/usr/bin/node",
              "/opt/t3/lib/node_modules/t3/dist/bin.mjs",
            ]),
            Effect.provideService(HostProcess.IsExecutable, false),
            Effect.provideService(HostProcess.Platform, "linux"),
            Effect.provideService(HostProcess.Environment, { PATH: searchPath }),
          );

        // A relative entry was searched from this process's directory, unlike the user's shell.
        expect(yield* hostCommand(path.relative(process.cwd(), bin))).toEqual({
          command: `${hostShellWord("linux", path.join(bin, "hyakki"))} doctor`,
          launcher: false,
        });
        // An empty entry makes the shell search its own directory first, wherever that is.
        expect(yield* hostCommand(`:${bin}`)).toEqual({
          command: `${hostShellWord("linux", path.join(bin, "hyakki"))} doctor`,
          launcher: false,
        });
        expect(yield* hostCommand(bin)).toEqual({ command: "hyakki doctor", launcher: false });
      }),
  );
});

it.layer(NodeServices.layer)("manual server installation ownership", (it) => {
  it.effect("recognizes runner caches for script packages and the npm launcher", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped();
      const executable = path.join(root, ".hyakki/runtime/versions/1.0.0/t3");
      yield* fs.makeDirectory(path.dirname(executable), { recursive: true });
      yield* fs.writeFileString(executable, "");
      for (const [relative, kind] of [
        ["npm/_npx/hash/node_modules/t3/dist/bin.mjs", "npx"],
        ["npm/_npx/hash/node_modules/t3/bin/t3.mjs", "npx"],
        ["pnpm/dlx/hash/node_modules/t3/dist/bin.mjs", "pnpm-dlx"],
        [".bun/install/cache/t3/dist/bin.mjs", "bunx"],
      ] as const) {
        const entry = path.join(root, relative);
        yield* fs.makeDirectory(path.dirname(entry), { recursive: true });
        yield* fs.writeFileString(entry, "");
        yield* fs.writeFileString(
          path.join(path.dirname(entry), "../package.json"),
          `{"name":"t3","version":"${packageJson.version}","bin":{"t3":"./bin/t3.mjs"}}`,
        );
        const launchedBy = entry.endsWith("t3.mjs");
        const installation = yield* resolveServerInstallation.pipe(
          Effect.provideService(HostProcess.Arguments, [launchedBy ? executable : "node", entry]),
          Effect.provideService(HostProcess.ExecutablePath, executable),
          Effect.provideService(HostProcess.IsExecutable, launchedBy),
          Effect.provideService(
            HostProcess.Environment,
            launchedBy ? { HYAKKI_NPM_LAUNCHER_PATH: entry } : {},
          ),
        );
        expect(installation).toEqual({ kind });
      }
    }),
  );

  it.effect("requires the npm prefix's bin to point to the running package", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped();
      const prefix = path.join(root, "bunx-tools");
      const packageRoot = path.join(prefix, "lib/node_modules/t3");
      const entry = path.join(packageRoot, "dist/bin.mjs");
      const globalBin = path.join(prefix, "bin/t3");
      yield* fs.makeDirectory(path.dirname(entry), { recursive: true });
      yield* fs.makeDirectory(path.dirname(globalBin), { recursive: true });
      yield* fs.writeFileString(entry, "");
      yield* fs.writeFileString(
        path.join(packageRoot, "package.json"),
        '{"name":"t3","version":"0.0.45","bin":{"t3":"./dist/bin.mjs"}}',
      );
      const resolve = resolveServerInstallation.pipe(
        Effect.provideService(HostProcess.Arguments, ["node", entry]),
        Effect.provideService(HostProcess.IsExecutable, false),
        Effect.provideService(HostProcess.Platform, "linux"),
      );
      expect(yield* resolve).toBeNull();
      yield* fs.symlink(entry, globalBin);
      expect(yield* resolve).toEqual({ kind: "npm-global", prefix });
      yield* fs.remove(globalBin);
      yield* fs.writeFileString(globalBin, "an unrelated t3 command");
      expect(yield* resolve).toBeNull();
      expect(yield* resolve.pipe(Effect.provideService(HostProcess.Platform, "win32"))).toBeNull();
    }),
  );

  it.effect("proves the downloaded executable was started by a global npm launcher", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped();
      const prefix = path.join(root, "bunx-tools");
      const packageRoot = path.join(prefix, "lib/node_modules/t3");
      const launcher = path.join(packageRoot, "bin/t3.mjs");
      const executable = path.join(root, ".hyakki/runtime/versions/1.0.0/t3");
      yield* fs.makeDirectory(path.dirname(launcher), { recursive: true });
      yield* fs.makeDirectory(path.dirname(executable), { recursive: true });
      yield* fs.makeDirectory(path.join(prefix, "bin"));
      yield* fs.writeFileString(launcher, "");
      yield* fs.writeFileString(executable, "");
      yield* fs.symlink(launcher, path.join(prefix, "bin/t3"));
      const resolve = resolveServerInstallation.pipe(
        Effect.provideService(HostProcess.ExecutablePath, executable),
        Effect.provideService(HostProcess.Arguments, [executable, executable]),
        Effect.provideService(HostProcess.IsExecutable, true),
        Effect.provideService(HostProcess.Platform, "linux"),
        Effect.provideService(HostProcess.Environment, { HYAKKI_NPM_LAUNCHER_PATH: launcher }),
      );
      for (const [version, expected] of [
        ["0.0.1", null],
        [packageJson.version, { kind: "npm-global", prefix }],
      ] as const) {
        yield* fs.writeFileString(
          path.join(packageRoot, "package.json"),
          `{"name":"t3","version":"${version}","bin":{"t3":"./bin/t3.mjs"}}`,
        );
        expect(yield* resolve).toEqual(expected);
      }
    }),
  );

  it.effect("names the launcher that started a downloaded runtime", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped());
      // The install script's launcher names ~/.t3, which here links to a home elsewhere.
      const executable = path.join(root, "data/t3/runtime/versions/1.0.0/t3");
      const launcher = path.join(root, "bin/hyakki");
      const copy = path.join(root, "bin/t3-copy");
      yield* fs.makeDirectory(path.dirname(executable), { recursive: true });
      yield* fs.makeDirectory(path.dirname(launcher), { recursive: true });
      yield* fs.writeFileString(executable, "", { mode: 0o755 });
      yield* fs.writeFileString(copy, "", { mode: 0o755 });
      yield* fs.symlink(path.join(root, "data/t3"), path.join(root, ".hyakki"));
      yield* fs.symlink(path.join(root, ".hyakki/runtime/versions/1.0.0/t3"), launcher);
      // Earlier PATH entries hold a directory and a non-executable file named t3.
      yield* fs.makeDirectory(path.join(root, "shadow-dir/t3"), { recursive: true });
      yield* fs.makeDirectory(path.join(root, "shadow-file"));
      yield* fs.writeFileString(path.join(root, "shadow-file/t3"), "");
      const resolve = (invokedAs: string, PATH = "shadow-dir:shadow-file:bin") =>
        resolveServerInstallation.pipe(
          Effect.provideService(HostProcess.ExecutablePath, executable),
          Effect.provideService(HostProcess.IsExecutable, true),
          Effect.provideService(HostProcess.InvokedAs, invokedAs),
          Effect.provideService(HostProcess.WorkingDirectory, root),
          Effect.provideService(HostProcess.Environment, { PATH }),
          Effect.provideService(HostProcess.HomeDirectory, root),
          Effect.provideService(HostProcess.Platform, "linux"),
        );
      const baseDir = path.join(root, ".hyakki");

      expect(yield* resolve("hyakki")).toEqual({ kind: "t3-launcher", launcher, baseDir });
      expect(yield* resolve(launcher)).toEqual({ kind: "t3-launcher", launcher, baseDir });
      expect(yield* resolve(executable)).toBeNull();
      expect(yield* resolve(copy)).toBeNull();

      // The script launcher execs the runtime by absolute path, so argv0 names the runtime.
      yield* fs.remove(launcher);
      yield* fs.writeFileString(
        launcher,
        posixLauncherScript(path.join(root, ".hyakki/runtime/versions/1.0.0/t3")),
        { mode: 0o755 },
      );
      expect(yield* resolve(executable, path.join(root, "bin"))).toEqual({
        kind: "t3-launcher",
        launcher,
        baseDir,
      });
    }),
  );

  it.effect("leaves local, standalone, missing and unreadable installs unknown", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped();
      for (const relative of [
        "project/node_modules/t3/dist/bin.mjs",
        "project/apps/server/dist/bin.mjs",
        ".hyakki/runtime/0.0.45/t3",
        "missing/dist/bin.mjs",
      ]) {
        const entry = path.join(root, relative);
        if (!relative.startsWith("missing")) {
          yield* fs.makeDirectory(path.dirname(entry), { recursive: true });
          yield* fs.writeFileString(entry, "");
        }
        expect(
          yield* resolveServerInstallation.pipe(
            Effect.provideService(HostProcess.Arguments, ["node", entry]),
            Effect.provideService(HostProcess.IsExecutable, false),
          ),
        ).toBeNull();
      }
    }),
  );
});
