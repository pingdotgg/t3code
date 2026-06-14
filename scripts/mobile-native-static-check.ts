#!/usr/bin/env node

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { isCommandAvailable, resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Console from "effect/Console";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Logger from "effect/Logger";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import { Command } from "effect/unstable/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

interface NativeStaticTool {
  readonly command: string;
  readonly installHint: string;
}

class NativeStaticCheckError extends Data.TaggedError("NativeStaticCheckError")<{
  readonly message: string;
}> {}

const tools = [
  {
    command: "swiftlint",
    installHint: "brew install swiftlint",
  },
  {
    command: "ktlint",
    installHint: "brew install ktlint",
  },
  {
    command: "detekt",
    installHint: "brew install detekt",
  },
] as const satisfies ReadonlyArray<NativeStaticTool>;

const sourceExtensions = new Set([".swift", ".kt", ".kts"]);
const excludedDirectories = new Set([
  ".expo",
  ".git",
  "build",
  "DerivedData",
  "node_modules",
  "Pods",
  "Vendor",
]);
const generatedNativeProjectDirectories = new Set(["android", "ios"]);

const appRoot = Effect.service(Path.Path).pipe(
  Effect.flatMap((path) => path.fromFileUrl(new URL("../apps/mobile", import.meta.url))),
);

const commandOutputOptions = {
  stdout: "inherit",
  stderr: "inherit",
} as const;

const commandExists = Effect.fn("commandExists")(function* (command: string) {
  return yield* isCommandAvailable(command);
});

const warnMissingTool = (tool: NativeStaticTool, checkName: string) =>
  Effect.logWarning(
    `${tool.command} is not installed; skipping ${checkName}. Install it with '${tool.installHint}' or run 'brew bundle install --file apps/mobile/Brewfile'.`,
  );

const runCommand = Effect.fn("runCommand")(function* (
  command: string,
  args: ReadonlyArray<string>,
  cwd: string,
) {
  yield* Console.log(`$ ${[command, ...args].join(" ")}`);
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const spawnCommand = yield* resolveSpawnCommand(command, args);
  const child = yield* spawner.spawn(
    ChildProcess.make(spawnCommand.command, spawnCommand.args, {
      cwd,
      ...commandOutputOptions,
      shell: spawnCommand.shell,
    }),
  );
  const exitCode = Number(yield* child.exitCode);

  if (exitCode !== 0) {
    return yield* new NativeStaticCheckError({
      message: `Command exited with non-zero exit code (${exitCode})`,
    });
  }
});

function collectSources(
  directory: string,
  root: string,
): Effect.Effect<
  ReadonlyArray<string>,
  PlatformError.PlatformError,
  FileSystem.FileSystem | Path.Path
> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const entries = yield* fs.readDirectory(directory);
    const sources: Array<string> = [];

    for (const entry of entries) {
      const entryPath = path.join(directory, entry);
      const stat = yield* fs.stat(entryPath);

      if (stat.type === "Directory") {
        const isGeneratedNativeProjectDirectory =
          directory === root && generatedNativeProjectDirectories.has(entry);

        if (excludedDirectories.has(entry) || isGeneratedNativeProjectDirectory) {
          continue;
        }

        sources.push(...(yield* collectSources(entryPath, root)));
        continue;
      }

      if (stat.type === "File" && sourceExtensions.has(path.extname(entry))) {
        sources.push(entryPath);
      }
    }

    return sources;
  });
}

const runNativeStaticChecks = Effect.fn("runNativeStaticChecks")(function* () {
  const path = yield* Path.Path;
  const root = yield* appRoot;
  const sources = yield* collectSources(root, root);
  const swiftSources = sources.filter((source) => path.extname(source) === ".swift");
  const kotlinSources = sources.filter((source) => {
    const extension = path.extname(source);
    return extension === ".kt" || extension === ".kts";
  });
  const availableTools = new Map<string, boolean>();

  for (const tool of tools) {
    availableTools.set(tool.command, yield* commandExists(tool.command));
  }

  yield* Console.log(
    `Found ${swiftSources.length} Swift and ${kotlinSources.length} Kotlin native source files.`,
  );

  if (swiftSources.length > 0) {
    if (availableTools.get("swiftlint")) {
      yield* runCommand("swiftlint", ["lint", "--config", ".swiftlint.yml", "--strict"], root);
    } else {
      yield* warnMissingTool(tools[0], "SwiftLint");
    }
  }

  if (kotlinSources.length > 0) {
    const relativeKotlinSources = kotlinSources.map((source) => path.relative(root, source));

    if (availableTools.get("ktlint")) {
      yield* runCommand("ktlint", relativeKotlinSources, root);
    } else {
      yield* warnMissingTool(tools[1], "ktlint");
    }

    if (availableTools.get("detekt")) {
      yield* runCommand(
        "detekt",
        [
          "--config",
          "detekt.yml",
          "--input",
          relativeKotlinSources.join(","),
          "--build-upon-default-config",
        ],
        root,
      );
    } else {
      yield* warnMissingTool(tools[2], "detekt");
    }
  }

  yield* Console.log("Skipping generated native project folders: android/, ios/.");
});

export const mobileNativeStaticCheckCommand = Command.make("mobile-native-static-check", {}, () =>
  runNativeStaticChecks(),
).pipe(
  Command.withDescription("Run mobile native static analysis when native tools are available."),
);

if (import.meta.main) {
  Command.run(mobileNativeStaticCheckCommand, { version: "0.0.0" }).pipe(
    Effect.scoped,
    Effect.provide([Logger.layer([Logger.consolePretty()]), NodeServices.layer]),
    NodeRuntime.runMain,
  );
}
