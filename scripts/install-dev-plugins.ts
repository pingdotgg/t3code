#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off - This installer must use lstat to avoid overwriting real plugin directories.

import * as NodeFs from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";

const PLUGINS = [
  {
    id: "t3.automations",
    packagePath: "packages/plugins/automations",
  },
  {
    id: "t3.voice-input",
    packagePath: "packages/plugins/voice-input",
  },
] as const;

const execFileAsync = promisify(execFile);

class InstallDevPluginsError extends Data.TaggedError("InstallDevPluginsError")<{
  readonly message: string;
  readonly code?: string;
  readonly cause?: unknown;
}> {}

function resolveT3Home(): string {
  const configured = process.env["T3CODE_HOME"]?.trim();
  return configured ? NodePath.resolve(configured) : NodePath.join(NodeOS.homedir(), ".t3");
}

function hasErrorCode(cause: unknown): cause is { readonly code: string } {
  return (
    typeof cause === "object" && cause !== null && "code" in cause && typeof cause.code === "string"
  );
}

function toInstallError(message: string, cause: unknown): InstallDevPluginsError {
  const code = hasErrorCode(cause) ? cause.code : undefined;
  return new InstallDevPluginsError({
    message,
    ...(code === undefined ? {} : { code }),
    cause,
  });
}

const lstatOrNull = (filePath: string) =>
  Effect.tryPromise({
    try: () => NodeFs.lstat(filePath),
    catch: (cause) => toInstallError(`Could not inspect ${filePath}.`, cause),
  }).pipe(
    Effect.catch((error) => {
      if (error.code === "ENOENT") {
        return Effect.succeed(null);
      }
      return Effect.fail(error);
    }),
  );

const unlink = (filePath: string) =>
  Effect.tryPromise({
    try: () => NodeFs.unlink(filePath),
    catch: (cause) => toInstallError(`Could not remove ${filePath}.`, cause),
  });

const mkdir = (directory: string) =>
  Effect.tryPromise({
    try: () => NodeFs.mkdir(directory, { recursive: true }),
    catch: (cause) => toInstallError(`Could not create ${directory}.`, cause),
  });

const symlink = (sourcePath: string, targetPath: string) =>
  Effect.tryPromise({
    try: () => NodeFs.symlink(sourcePath, targetPath, "dir"),
    catch: (cause) => toInstallError(`Could not link ${targetPath} to ${sourcePath}.`, cause),
  });

const buildPlugin = (sourcePath: string) =>
  Effect.tryPromise({
    try: () =>
      execFileAsync("pnpm", ["--dir", sourcePath, "run", "build"], {
        cwd: process.cwd(),
        maxBuffer: 10 * 1024 * 1024,
      }),
    catch: (cause) => toInstallError(`Could not build plugin at ${sourcePath}.`, cause),
  }).pipe(
    Effect.tap(() => Effect.log(`Built plugin package: ${sourcePath}`)),
    Effect.asVoid,
  );

const linkPlugin = (input: {
  readonly pluginsDir: string;
  readonly id: string;
  readonly sourcePath: string;
}) =>
  Effect.gen(function* () {
    const targetPath = NodePath.join(input.pluginsDir, input.id);
    const sourcePath = NodePath.resolve(input.sourcePath);
    const existing = yield* lstatOrNull(targetPath);

    if (existing !== null) {
      if (!existing.isSymbolicLink()) {
        yield* Effect.logWarning(`Skipped ${input.id}: ${targetPath} exists and is not a symlink.`);
        return;
      }
      yield* unlink(targetPath);
    }

    yield* symlink(sourcePath, targetPath);
    yield* Effect.log(`Linked ${input.id}: ${targetPath} -> ${sourcePath}`);
  });

const program = Effect.gen(function* () {
  const t3Home = resolveT3Home();
  const pluginsDir = NodePath.join(t3Home, "plugins");

  yield* mkdir(pluginsDir);
  yield* Effect.forEach(
    PLUGINS,
    (plugin) => {
      const sourcePath = NodePath.resolve(plugin.packagePath);
      return buildPlugin(sourcePath).pipe(
        Effect.andThen(
          linkPlugin({
            pluginsDir,
            id: plugin.id,
            sourcePath,
          }),
        ),
      );
    },
    { concurrency: 1, discard: true },
  );
});

NodeRuntime.runMain(program);
