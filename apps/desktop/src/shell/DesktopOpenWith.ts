// @effect-diagnostics nodeBuiltinImport:off - macOS bundle paths use the host path grammar.
import {
  OpenWithBundleResolutionError,
  OpenWithEnvironmentError,
  OpenWithInvalidTargetError,
  OpenWithMissingEntryError,
  OpenWithSpawnError,
  OpenWithUnavailableApplicationError,
  PRIMARY_LOCAL_ENVIRONMENT_ID,
  type DesktopOpenWithInput,
  type OpenWithEntry,
  type OpenWithEntryPresentation,
  type OpenWithLaunchError,
} from "@t3tools/contracts";
import { resolveCommandPath, resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as NodePath from "node:path";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import { resolveMacApplicationIconDataUrl } from "../electron/MacApplicationIcon.ts";
import * as DesktopClientSettings from "../settings/DesktopClientSettings.ts";

interface ResolvedLaunch {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string | null;
  readonly shell?: boolean;
}

const statPath = (path: string) =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fileSystem) => fileSystem.stat(path)),
    Effect.map(Option.some),
    Effect.orElseSucceed(() => Option.none()),
  );

const applicationUnavailableReason = (entry: OpenWithEntry): string =>
  entry.invocation.type === "mac-application"
    ? `Application not found: ${entry.invocation.applicationPath}`
    : `Executable not found: ${entry.invocation.executable}`;

const isMacApplicationPath = (value: string): boolean =>
  NodePath.isAbsolute(value) && value.toLowerCase().endsWith(".app");

const commandExists = Effect.fn("desktop.openWith.commandExists")(function* (command: string) {
  return yield* resolveCommandPath(command).pipe(
    Effect.as(true),
    Effect.catchTag("CommandResolutionError", () => Effect.succeed(false)),
  );
});

const entryIsAvailable = Effect.fn("desktop.openWith.entryIsAvailable")(function* (
  entry: OpenWithEntry,
  platform: NodeJS.Platform,
) {
  if (entry.invocation.type === "command") {
    return yield* commandExists(entry.invocation.executable);
  }
  if (platform !== "darwin" || !isMacApplicationPath(entry.invocation.applicationPath)) {
    return false;
  }
  const stat = yield* statPath(entry.invocation.applicationPath);
  return Option.isSome(stat) && stat.value.type === "Directory";
});

const resolveIconDataUrl = (applicationPath: string) =>
  Effect.tryPromise({
    try: () => resolveMacApplicationIconDataUrl(applicationPath),
    catch: (cause) => new OpenWithIconResolutionError({ applicationPath, cause }),
  }).pipe(Effect.orElseSucceed(() => null));

class OpenWithIconResolutionError extends Schema.TaggedErrorClass<OpenWithIconResolutionError>()(
  "OpenWithIconResolutionError",
  { applicationPath: Schema.String, cause: Schema.Defect() },
) {}

export const resolveMacBundleExecutable = Effect.fn("desktop.openWith.resolveMacBundleExecutable")(
  function* (applicationPath: string) {
    if (!isMacApplicationPath(applicationPath)) {
      return yield* new OpenWithBundleResolutionError({
        applicationPath,
        reason: "invalid-application-path",
      });
    }
    const infoPlistPath = NodePath.join(applicationPath, "Contents", "Info.plist");
    const plistStat = yield* statPath(infoPlistPath);
    if (Option.isNone(plistStat) || plistStat.value.type !== "File") {
      return yield* new OpenWithBundleResolutionError({
        applicationPath,
        reason: "missing-info-plist",
      });
    }

    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const executableName = yield* spawner
      .string(
        ChildProcess.make(
          "/usr/bin/plutil",
          ["-extract", "CFBundleExecutable", "raw", "-o", "-", infoPlistPath],
          { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
        ),
      )
      .pipe(
        Effect.map((output) => output.trim()),
        Effect.mapError(
          (cause) =>
            new OpenWithBundleResolutionError({
              applicationPath,
              reason: "malformed-info-plist",
              cause,
            }),
        ),
      );
    if (
      executableName.length === 0 ||
      executableName.includes("/") ||
      executableName.includes("\\")
    ) {
      return yield* new OpenWithBundleResolutionError({
        applicationPath,
        reason: "malformed-info-plist",
      });
    }
    const executablePath = NodePath.join(applicationPath, "Contents", "MacOS", executableName);
    const executableStat = yield* statPath(executablePath);
    if (Option.isNone(executableStat) || executableStat.value.type !== "File") {
      return yield* new OpenWithBundleResolutionError({
        applicationPath,
        reason: "missing-executable",
      });
    }
    return executablePath;
  },
);

const expandDirectoryArguments = (args: readonly string[], directory: string): string[] =>
  args.map((argument) => argument.replaceAll("{directory}", directory));

export const resolveOpenWithLaunch = Effect.fn("desktop.openWith.resolveLaunch")(function* (
  entry: OpenWithEntry,
  directory: string,
  platform: NodeJS.Platform,
): Effect.fn.Return<
  ResolvedLaunch,
  OpenWithLaunchError,
  FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
> {
  if (!(yield* entryIsAvailable(entry, platform))) {
    return yield* new OpenWithUnavailableApplicationError({
      entryId: entry.id,
      executable:
        entry.invocation.type === "mac-application"
          ? entry.invocation.applicationPath
          : entry.invocation.executable,
    });
  }

  if (entry.directoryMode === "open-target") {
    if (entry.invocation.type === "mac-application") {
      return {
        command: "/usr/bin/open",
        args: ["-a", entry.invocation.applicationPath, directory],
        cwd: null,
      };
    }
    const command = yield* resolveSpawnCommand(entry.invocation.executable, [
      ...entry.arguments,
      directory,
    ]);
    return { ...command, cwd: null };
  }

  if (entry.directoryMode === "working-directory") {
    if (entry.invocation.type === "mac-application") {
      return {
        command: yield* resolveMacBundleExecutable(entry.invocation.applicationPath),
        args: [...entry.arguments],
        cwd: directory,
      };
    }
    const command = yield* resolveSpawnCommand(entry.invocation.executable, entry.arguments);
    return { ...command, cwd: directory };
  }

  if (!entry.arguments.some((argument) => argument.includes("{directory}"))) {
    return yield* new OpenWithUnavailableApplicationError({
      entryId: entry.id,
      executable: "Custom arguments must include {directory}",
    });
  }
  const args = expandDirectoryArguments(entry.arguments, directory);
  if (entry.invocation.type === "mac-application") {
    return {
      command: yield* resolveMacBundleExecutable(entry.invocation.applicationPath),
      args,
      cwd: null,
    };
  }
  const command = yield* resolveSpawnCommand(entry.invocation.executable, args);
  return { ...command, cwd: null };
});

const spawnDetached = (
  entry: OpenWithEntry,
  launch: ResolvedLaunch & { readonly shell?: boolean },
) =>
  ChildProcessSpawner.ChildProcessSpawner.pipe(
    Effect.flatMap((spawner) =>
      spawner.spawn(
        ChildProcess.make(launch.command, launch.args, {
          ...(launch.cwd === null ? {} : { cwd: launch.cwd }),
          detached: true,
          shell: launch.shell ?? false,
          stdin: "ignore",
          stdout: "ignore",
          stderr: "ignore",
        }),
      ),
    ),
    Effect.flatMap((handle) => handle.unref),
    Effect.asVoid,
    Effect.scoped,
    Effect.mapError(
      (cause) =>
        new OpenWithSpawnError({
          entryId: entry.id,
          command: launch.command,
          args: [...launch.args],
          cwd: launch.cwd,
          cause,
        }),
    ),
  );

export class DesktopOpenWith extends Context.Service<
  DesktopOpenWith,
  {
    readonly resolvePresentations: Effect.Effect<readonly OpenWithEntryPresentation[]>;
    readonly open: (input: DesktopOpenWithInput) => Effect.Effect<void, OpenWithLaunchError>;
  }
>()("@t3tools/desktop/shell/DesktopOpenWith") {}

export const make = Effect.gen(function* () {
  const clientSettings = yield* DesktopClientSettings.DesktopClientSettings;
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const providePlatformServices = <A, E>(
    effect: Effect.Effect<
      A,
      E,
      FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
    >,
  ): Effect.Effect<A, E> =>
    effect.pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    );

  const resolvePresentations = Effect.gen(function* () {
    const settings = yield* clientSettings.get;
    if (Option.isNone(settings)) return [];
    return yield* Effect.forEach(settings.value.openWithEntries, (entry) =>
      Effect.gen(function* () {
        const available = yield* providePlatformServices(
          entryIsAvailable(entry, environment.platform),
        );
        const iconDataUrl =
          available && entry.invocation.type === "mac-application"
            ? yield* resolveIconDataUrl(entry.invocation.applicationPath)
            : null;
        return {
          entryId: entry.id,
          available,
          iconDataUrl,
          ...(available ? {} : { unavailableReason: applicationUnavailableReason(entry) }),
        } satisfies OpenWithEntryPresentation;
      }),
    );
  }).pipe(Effect.withSpan("desktop.openWith.resolvePresentations"));

  const open = Effect.fn("desktop.openWith.open")(function* (input: DesktopOpenWithInput) {
    if (input.environmentId !== PRIMARY_LOCAL_ENVIRONMENT_ID) {
      return yield* new OpenWithEnvironmentError({ environmentId: input.environmentId });
    }
    if (!NodePath.isAbsolute(input.directory)) {
      return yield* new OpenWithInvalidTargetError({
        directory: input.directory,
        reason: "relative",
      });
    }
    const targetStat = yield* providePlatformServices(statPath(input.directory));
    if (Option.isNone(targetStat)) {
      return yield* new OpenWithInvalidTargetError({
        directory: input.directory,
        reason: "missing",
      });
    }
    if (targetStat.value.type !== "Directory") {
      return yield* new OpenWithInvalidTargetError({
        directory: input.directory,
        reason: "not-directory",
      });
    }
    const settings = yield* clientSettings.get;
    const entry = Option.isSome(settings)
      ? settings.value.openWithEntries.find((candidate) => candidate.id === input.entryId)
      : undefined;
    if (entry === undefined) {
      return yield* new OpenWithMissingEntryError({ entryId: input.entryId });
    }
    const launch = yield* providePlatformServices(
      resolveOpenWithLaunch(entry, input.directory, environment.platform),
    );
    yield* providePlatformServices(spawnDetached(entry, launch));
  });

  return DesktopOpenWith.of({ resolvePresentations, open });
});

export const layer = Layer.effect(DesktopOpenWith, make);
