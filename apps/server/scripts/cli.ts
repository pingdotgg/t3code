#!/usr/bin/env node
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { Command, Flag } from "effect/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { DEVELOPMENT_ICON_OVERRIDES } from "../../../scripts/lib/brand-assets.ts";
import { findEsmImportsOfExternalPackages } from "../../../scripts/lib/cli-executable-imports.ts";
import rootPackageJson from "../../../package.json" with { type: "json" };
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import {
  ServerCliBuildAssetMissingError,
  ServerCliCommandExitError,
  ServerCliDevelopmentIconSourceMissingError,
  ServerCliDevelopmentIconTargetMissingError,
  ServerCliExecutableImportError,
} from "./cliErrors.ts";

const RepoRoot = Effect.service(Path.Path).pipe(
  Effect.flatMap((path) => path.fromFileUrl(new URL("../../..", import.meta.url))),
);

const runCommand = Effect.fn("runCommand")(function* (command: ChildProcess.StandardCommand) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* spawner.spawn(command);
  const exitCode = yield* child.exitCode;

  if (exitCode !== 0) {
    return yield* new ServerCliCommandExitError({
      command: command.command,
      args: command.args,
      cwd: command.options.cwd,
      exitCode,
    });
  }
});

const applyDevelopmentIconOverrides = Effect.fn("applyDevelopmentIconOverrides")(function* (
  repoRoot: string,
  serverDir: string,
) {
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;

  for (const override of DEVELOPMENT_ICON_OVERRIDES) {
    const sourcePath = path.join(repoRoot, override.sourceRelativePath);
    const targetPath = path.join(serverDir, override.targetRelativePath);

    if (!(yield* fs.exists(sourcePath))) {
      return yield* new ServerCliDevelopmentIconSourceMissingError({ sourcePath });
    }
    if (!(yield* fs.exists(targetPath))) {
      return yield* new ServerCliDevelopmentIconTargetMissingError({ targetPath });
    }

    yield* fs.copyFile(sourcePath, targetPath);
  }

  yield* Effect.log("[cli] Applied development icon overrides to dist/client");
});

const buildCmd = Command.make(
  "build",
  {
    verbose: Flag.Boolean("verbose").pipe(Flag.withDefault(false)),
  },
  (config) =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const fs = yield* FileSystem.FileSystem;
      const repoRoot = yield* RepoRoot;
      const serverDir = path.join(repoRoot, "apps/server");

      yield* Effect.log("[cli] Running tsdown...");
      yield* runCommand(
        ChildProcess.make(process.execPath, ["--run", "build:bundle"], {
          cwd: serverDir,
          stdout: config.verbose ? "inherit" : "ignore",
          stderr: "inherit",
          shell: false,
        }),
      );

      const webDist = path.join(repoRoot, "apps/web/dist");
      const clientTarget = path.join(serverDir, "dist/client");

      if (yield* fs.exists(webDist)) {
        yield* fs.copy(webDist, clientTarget);
        yield* applyDevelopmentIconOverrides(repoRoot, serverDir);
        yield* Effect.log("[cli] Bundled web app into dist/client");
      } else {
        yield* Effect.logWarning("[cli] Web dist not found. Skipping client bundle.");
      }
    }),
).pipe(Command.withDescription("Build the server package (tsdown + bundle web client)."));

const buildExeCmd = Command.make(
  "build-exe",
  {
    verbose: Flag.Boolean("verbose").pipe(Flag.withDefault(false)),
    target: Flag.String("target").pipe(
      Flag.withDescription(
        "Cross-build for <platform>-<arch> in nodejs.org naming (for example darwin-x64); defaults to the host.",
      ),
      Flag.optional,
    ),
  },
  (config) =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const fs = yield* FileSystem.FileSystem;
      const repoRoot = yield* RepoRoot;
      const serverDir = path.join(repoRoot, "apps/server");

      yield* Effect.log("[cli] Building single-executable...");
      const spawnCommand = yield* resolveSpawnCommand("vp", ["pack"]);
      yield* runCommand(
        ChildProcess.make(spawnCommand.command, spawnCommand.args, {
          cwd: serverDir,
          env: {
            ...process.env,
            T3CODE_PACK_EXE: "1",
            ...Option.match(config.target, {
              onNone: () => ({}),
              onSome: (target) => ({ T3CODE_PACK_EXE_TARGET: target }),
            }),
          },
          stdout: config.verbose ? "inherit" : "ignore",
          stderr: "inherit",
          shell: spawnCommand.shell,
        }),
      );

      // The executable can only `import` built-ins. A file-backed import
      // passes the bundler and `node dist/bin.mjs`, then throws inside the
      // binary, so read the emitted module graph rather than trusting config.
      const bundlePath = path.join(serverDir, "dist-exe/bin.mjs");
      const specifiers = findEsmImportsOfExternalPackages(yield* fs.readFileString(bundlePath));
      if (specifiers.length > 0) {
        return yield* new ServerCliExecutableImportError({ bundlePath, specifiers });
      }
      yield* Effect.log(
        "[cli] Built dist-exe/t3 (expects client/, resource-monitor/, and the runtime-external node_modules beside it; scripts/build-cli-archive.ts assembles that tree)",
      );
    }),
).pipe(
  Command.withDescription(
    `Build the server as a Node single-executable. Native builds require Node ${rootPackageJson.engines.node}; explicit cross-target builds need a Node 25.7+ host for --build-sea. The binary still resolves native packages from a node_modules tree beside it.`,
  ),
);

/**
 * Publishes the `t3.tgz` launcher scripts/build-npm-launcher.ts produced. The
 * launcher downloads its executable from the GitHub Release, so the release
 * workflow runs this only after that release is published.
 */
const publishCmd = Command.make(
  "publish",
  {
    packagesDir: Flag.String("packages-dir").pipe(
      Flag.withDescription("Output dir of scripts/build-npm-launcher.ts."),
    ),
    tag: Flag.String("tag").pipe(Flag.withDefault("latest")),
    access: Flag.String("access").pipe(Flag.withDefault("public")),
    provenance: Flag.Boolean("provenance").pipe(Flag.withDefault(false)),
    dryRun: Flag.Boolean("dry-run").pipe(Flag.withDefault(false)),
    verbose: Flag.Boolean("verbose").pipe(Flag.withDefault(false)),
  },
  (config) =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const fs = yield* FileSystem.FileSystem;
      const packagesDir = path.resolve(config.packagesDir);
      const launcherTarball = path.join(packagesDir, "t3.tgz");
      if (!(yield* fs.exists(launcherTarball))) {
        return yield* new ServerCliBuildAssetMissingError({ assetPath: launcherTarball });
      }

      const args = ["publish", "--access", config.access, "--tag", config.tag];
      if (config.provenance) args.push("--provenance");
      if (config.dryRun) args.push("--dry-run");
      const spawnCommand = yield* resolveSpawnCommand("npm", [...args, launcherTarball]);
      yield* Effect.log(`[cli] npm ${args.join(" ")} t3.tgz`);
      yield* runCommand(
        ChildProcess.make(spawnCommand.command, spawnCommand.args, {
          cwd: packagesDir,
          stdout: config.verbose ? "inherit" : "ignore",
          stderr: "inherit",
          shell: spawnCommand.shell,
        }),
      );
    }),
).pipe(Command.withDescription("Publish the t3 launcher to npm."));

const cli = Command.make("cli").pipe(
  Command.withDescription("T3 server build & publish CLI."),
  Command.withSubcommands([buildCmd, buildExeCmd, publishCmd]),
);

Command.run(cli, { version: "0.0.0" }).pipe(
  Effect.scoped,
  Effect.provide([Logger.layer([Logger.consolePretty()]), NodeServices.layer]),
  NodeRuntime.runMain,
);
