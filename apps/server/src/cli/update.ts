import { AuthEnvironmentMaintainScope, EnvironmentHttpApi } from "@t3tools/contracts";
import { APP_NAME, CLI_COMMAND, LEGACY_CLI_COMMAND } from "@t3tools/shared/branding";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { powerShellOnly, shellCommandPath } from "@t3tools/shared/shell";
import {
  CLI_RELEASE_BASE_URL_ENV,
  CLI_RELEASE_CHANNELS,
  cliReleaseChannelOf,
  releaseAssetUrl,
  updateFeedFileName,
  type CliReleaseChannel,
} from "@t3tools/shared/cliRelease";
import * as Console from "effect/Console";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Argument, Command, Flag, GlobalFlag, Prompt } from "effect/cli";
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/http";
import * as HttpApiClient from "effect/http-api/HttpApiClient";

import packageJson from "../../package.json" with { type: "json" };
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerConfig from "../config.ts";
import * as BootService from "../service/bootService.ts";
import {
  ensurePinnedRuntimeInstalled,
  findPosixLauncher,
  launcherOwnsVersionsDir,
  isUnpublishedRelease,
  pinnedRuntimePaths,
  PinnedRuntimePreflightBlockedError,
  pinnedRuntimeVersionsDir,
  prunePinnedRuntimes,
  readPosixLauncherTarget,
  recordPinnedRuntimeLauncher,
  resolveLauncherPath,
  windowsShimTarget,
  writePosixLauncher,
} from "../service/pinnedRuntime.ts";
import {
  compareExactServiceVersions,
  decodeServiceUnit,
  isExactServiceVersion,
  SERVICE_LAUNCHER_PROTOCOL,
  SERVICE_UNIT_ENV,
} from "../service/serviceProtocol.ts";
import { runStagedServicePreflight } from "../service/servicePreflight.ts";
import { findNewestReleaseVersion } from "../service/npmRelease.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import { managedUpdateMirror, managedUpdateRefusal } from "../policy/managedUpdates.ts";
import * as ProcessRunner from "../processRunner.ts";
import {
  isProcessAlive,
  readLiveServerRuntimeState,
  readPersistedServerRuntimeState,
} from "../serverRuntimeState.ts";
import { projectLocationFlags, resolveCliAuthConfig } from "./config.ts";
import { createUpdateProgress } from "./updateProgress.ts";
import * as CliService from "./service.ts";

export class CliUpdateError extends Schema.TaggedError<CliUpdateError>()("CliUpdateError", {
  reason: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return this.reason;
  }
}

const RELEASE_INDEX_TIMEOUT = Duration.seconds(30);

export const resolveNewestVersion = Effect.fn("cli.update.resolve_newest")(function* (
  channel: CliReleaseChannel,
) {
  const version = yield* findNewestReleaseVersion(channel).pipe(
    Effect.mapError((error) => new CliUpdateError({ reason: error.reason })),
  );
  if (version !== undefined) return version;
  return yield* new CliUpdateError({ reason: `No published ${channel} release was found.` });
});

/** The version an update mirror's feed file for this platform offers on `channel`. */
export const resolveMirrorVersion = Effect.fn("cli.update.resolve_mirror")(function* (
  mirror: { readonly organization: string; readonly feedUrl: string },
  channel: CliReleaseChannel,
) {
  if (channel === "preview") {
    return yield* new CliUpdateError({
      reason: `${mirror.organization}'s update mirror has no preview builds.`,
    });
  }
  const httpClient = yield* HttpClient.HttpClient;
  const fileName = updateFeedFileName(
    channel === "nightly" ? "nightly" : "latest",
    yield* HostProcess.Platform,
    yield* HostProcess.Architecture,
  );
  const url = releaseAssetUrl(mirror.feedUrl, fileName);
  // Not the URL, whose query can hold the mirror's access token.
  const unreadable = new CliUpdateError({
    reason: `Could not read ${fileName} from ${mirror.organization}'s update mirror.`,
  });
  const body = yield* httpClient.get(url).pipe(
    Effect.flatMap(HttpClientResponse.filterStatusOk),
    Effect.flatMap((response) => response.text),
    Effect.mapError(() => unreadable),
    Effect.timeoutOrElse({
      duration: RELEASE_INDEX_TIMEOUT,
      orElse: () => Effect.fail(unreadable),
    }),
  );
  const version = /^version:\s*["']?([^"'\s]+)/m.exec(body)?.[1];
  if (
    version === undefined ||
    !isExactServiceVersion(version) ||
    cliReleaseChannelOf(version) !== channel
  ) {
    return yield* unreadable;
  }
  return version;
});

/** What a legacy symlink or a launcher script on macOS and Linux runs. */
const posixLauncherTarget = Effect.fn("cli.update.posix_launcher_target")(function* (
  launcher: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const link = yield* fs.readLink(launcher).pipe(Effect.option);
  return Option.isSome(link)
    ? path.resolve(path.dirname(launcher), link.value)
    : yield* readPosixLauncherTarget(launcher).pipe(Effect.orElseSucceed(() => undefined));
});

/**
 * The launcher this process ran through and its `ada`/`t3` sibling, each kept only when it already
 * points into this home's `runtime/versions` tree. A plain copy of the executable, or a launcher
 * for some other install, is another program's.
 */
const ownedLaunchers = Effect.fn("cli.update.owned_launchers")(function* (input: {
  readonly launchedAs: string | undefined;
  readonly baseDir: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcess.Platform;
  if (input.launchedAs === undefined) return [];
  const versionsDir = pinnedRuntimeVersionsDir(path, input.baseDir);
  const ownsTarget = (candidate: string) => launcherOwnsVersionsDir(path, versionsDir, candidate);
  const owned = (launcher: string) =>
    platform === "win32"
      ? fs.readFileString(launcher).pipe(
          Effect.map((contents) => {
            const target = windowsShimTarget(contents);
            return target !== undefined && ownsTarget(target);
          }),
          Effect.orElseSucceed(() => false),
        )
      : posixLauncherTarget(launcher).pipe(
          Effect.map((target) => target !== undefined && ownsTarget(target)),
        );
  const launcher =
    platform === "win32"
      ? yield* findWindowsShim(input.launchedAs)
      : yield* findPosixLauncher({ launchedAs: input.launchedAs, versionsDir });
  if (launcher === undefined || !(yield* owned(launcher))) return [];
  const result = [launcher];
  for (const sibling of launcherSiblings(path, launcher)) {
    if (yield* owned(sibling)) result.push(sibling);
  }
  return result;
});

/**
 * The first of `ada` then `t3` that PATH runs as one of this home's launchers, and, with `runs`,
 * one that starts that runtime. A foreign program of either name earlier on PATH would run instead,
 * and older installs have only `t3`, so owning a launcher file is not enough.
 */
export const ownedCommandOnPath = Effect.fn("cli.update.owned_command_on_path")(function* (input: {
  readonly baseDir: string;
  readonly runs?: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcess.Platform;
  const environment = yield* HostProcess.Environment;
  const windows = platform === "win32";
  const versionsDir = pinnedRuntimeVersionsDir(path, input.baseDir);
  const normalize = (file: string) =>
    windows ? path.resolve(file).toLowerCase() : path.resolve(file);
  const targetOf = (launcher: string) =>
    windows
      ? fs.readFileString(launcher).pipe(
          Effect.map(windowsShimTarget),
          Effect.orElseSucceed(() => undefined),
        )
      : posixLauncherTarget(launcher);
  const cwd = yield* HostProcess.WorkingDirectory;
  // POSIX shells search an empty entry (`:dir`, `dir::`) as the working directory.
  const directories = (environment["PATH"] ?? environment["Path"] ?? "")
    .split(windows ? ";" : ":")
    .flatMap((directory) => (directory.length > 0 ? [directory] : windows ? [] : [cwd]));
  // Windows tries each PATHEXT extension in order; only a .cmd can be one of our shims.
  const extensions = windows
    ? (environment["PATHEXT"] ?? ".COM;.EXE;.BAT;.CMD")
        .split(";")
        .filter((extension) => extension.startsWith("."))
        .map((extension) => extension.toLowerCase())
    : [""];
  // A shell skips a file it cannot execute; Windows runs any PATHEXT match.
  const runnable = (candidate: string) =>
    fs.stat(candidate).pipe(
      Effect.map((info) => info.type === "File" && (windows || (Number(info.mode) & 0o111) !== 0)),
      Effect.orElseSucceed(() => false),
    );
  for (const name of [CLI_COMMAND, LEGACY_CLI_COMMAND]) {
    let first: string | undefined;
    search: for (const directory of directories) {
      for (const extension of extensions) {
        const candidate = path.join(directory, `${name}${extension}`);
        if (yield* runnable(candidate)) {
          first = candidate;
          break search;
        }
      }
    }
    if (first === undefined) continue;
    const target = yield* targetOf(first);
    if (
      target !== undefined &&
      launcherOwnsVersionsDir(path, versionsDir, target) &&
      (input.runs === undefined || normalize(target) === normalize(input.runs))
    ) {
      return name;
    }
  }
  return undefined;
});

/** Where a pasted command must run, for the Windows path form cmd.exe cannot read. */
const inShell = (command: string) => (powerShellOnly(command) ? " in PowerShell" : "");

/**
 * Repoints the launchers {@link ownedLaunchers} finds. Each is recorded before it moves, so
 * prune never meets a repointed launcher it does not know about.
 */
export const repointLauncher = Effect.fn("cli.update.repoint_launcher")(function* (input: {
  readonly launchedAs: string | undefined;
  readonly baseDir: string;
  readonly targetEntryPath: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const platform = yield* HostProcess.Platform;
  const [launcher, ...siblings] = yield* ownedLaunchers(input);
  if (launcher === undefined) return Option.none<string>();
  const remember = (file: string) =>
    recordPinnedRuntimeLauncher({ baseDir: input.baseDir, launcher: file }).pipe(
      Effect.mapError(
        () =>
          new CliUpdateError({
            reason: `Could not record the ${CLI_COMMAND} launcher at ${file}.`,
          }),
      ),
    );
  const repoint = (file: string) =>
    remember(file).pipe(
      Effect.andThen(
        platform === "win32"
          ? fs
              .writeFileString(file, `@echo off\r\n"${input.targetEntryPath}" %*`)
              .pipe(
                Effect.mapError(
                  () =>
                    new CliUpdateError({ reason: `Could not rewrite the launcher at ${file}.` }),
                ),
              )
          : writePosixLauncher({
              launcher: file,
              executable: input.targetEntryPath,
              exclusive: false,
            }).pipe(
              Effect.mapError(
                (cause) =>
                  new CliUpdateError({
                    reason: `Could not repoint the launcher at ${file}.`,
                    cause,
                  }),
              ),
            ),
      ),
    );
  yield* repoint(launcher);
  for (const sibling of siblings) yield* repoint(sibling).pipe(Effect.ignore);
  return Option.some(launcher);
});

/** `ada` and `t3` run the same install, so an update moves both and neither keeps an older version. */
const launcherSiblings = (path: Path.Path, launcher: string) => {
  const extension = path.extname(launcher);
  const name = path.basename(launcher, extension);
  const names = [CLI_COMMAND, LEGACY_CLI_COMMAND];
  if (!names.includes(name)) return [];
  return names
    .filter((other) => other !== name)
    .map((other) => path.join(path.dirname(launcher), `${other}${extension}`));
};

/** Windows executables see their own path, so find the installer shim by matching t3.cmd targets on PATH. */
export const findWindowsShim = Effect.fn("cli.update.find_windows_shim")(function* (
  executablePath: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const environment = yield* HostProcess.Environment;
  const candidates = [
    ...(environment["T3CODE_INSTALL_BIN_DIR"] ? [environment["T3CODE_INSTALL_BIN_DIR"]] : []),
    ...(environment["PATH"] ?? environment["Path"] ?? "").split(";"),
  ].filter((entry) => entry.trim().length > 0);
  for (const directory of candidates) {
    for (const name of [LEGACY_CLI_COMMAND, CLI_COMMAND]) {
      const shimPath = path.join(directory, `${name}.cmd`);
      const contents = yield* fs.readFileString(shimPath).pipe(Effect.option);
      if (Option.isNone(contents)) continue;
      const target = windowsShimTarget(contents.value);
      if (
        target !== undefined &&
        path.resolve(target).toLowerCase() === path.resolve(executablePath).toLowerCase()
      ) {
        return shimPath;
      }
    }
  }
  return undefined;
});

const updateFlags = {
  ...projectLocationFlags,
  channel: Flag.Literals("channel", CLI_RELEASE_CHANNELS).pipe(
    Flag.withDescription(
      `Release channel to follow. Defaults to the channel this ${APP_NAME} was published on.`,
    ),
    Flag.optional,
  ),
  allowDowngrade: Flag.Boolean("allow-downgrade").pipe(
    Flag.withDescription("Allow moving to an older version than the one running."),
    Flag.withDefault(false),
  ),
  yes: Flag.Boolean("yes").pipe(
    Flag.withAlias("y"),
    Flag.withDescription(
      "Restart the background service without asking. Required to restart it from a script, where there is no prompt.",
    ),
    Flag.withDefault(false),
  ),
};

const versionArgument = Argument.String("version").pipe(
  Argument.withDescription(
    "Exact version to install. Defaults to the newest release on the channel.",
  ),
  Argument.optional,
);

export const updateCommand = Command.make("update", {
  ...updateFlags,
  version: versionArgument,
}).pipe(
  Command.withDescription(
    `Download a newer ${APP_NAME} and switch this machine to it, including the background service when one is installed.`,
  ),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const logLevel = yield* GlobalFlag.LogLevel;
      const config = yield* resolveCliAuthConfig(flags, logLevel);
      const pause = askLiveServer(config, ({ server, headers }) =>
        server.pauseForUpdate({ headers }).pipe(Effect.map((result) => result.pausedRuns)),
      );
      const resume = askLiveServer(config, ({ server, headers }) =>
        server.resumeAfterUpdate({ headers }),
      ).pipe(Effect.asVoid);
      const liveServerContext = yield* Effect.context<
        Effect.Services<typeof pause> | Effect.Services<typeof resume>
      >();
      return yield* runUpdate({
        pauseLiveServerRuns: Effect.provideContext(pause, liveServerContext),
        resumeLiveServerRuns: Effect.provideContext(resume, liveServerContext),
        baseDir: config.baseDir,
        logsDir: config.logsDir,
        databasePath: config.dbPath,
        serverRuntimeStatePath: config.serverRuntimeStatePath,
        channel: Option.getOrUndefined(flags.channel),
        requestedVersion: Option.getOrUndefined(flags.version),
        allowDowngrade: flags.allowDowngrade,
        assumeYes: flags.yes,
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            CliService.layer(config),
            ProcessRunner.layer,
            FetchHttpClient.layer,
            ManagedPolicy.layer,
          ),
        ),
      );
    }),
  ),
);

const UPDATE_PAUSE_TIMEOUT = Duration.seconds(40);

const liveServerClient = Effect.fn("cli.update.live_server_client")(function* (
  config: ServerConfig.ServerConfig["Service"],
) {
  const runtimeState = yield* readLiveServerRuntimeState(config.serverRuntimeStatePath);
  if (Option.isNone(runtimeState)) return undefined;
  const environmentAuth = yield* EnvironmentAuth.EnvironmentAuth;
  const issued = yield* Effect.acquireRelease(
    environmentAuth.issueSession({
      scopes: [AuthEnvironmentMaintainScope],
      label: `${CLI_COMMAND} update`,
      ttl: Duration.minutes(1),
    }),
    (session) =>
      environmentAuth.revokeSession(session.sessionId).pipe(Effect.ignore({ log: true })),
  );
  const client = yield* HttpApiClient.make(EnvironmentHttpApi, {
    baseUrl: runtimeState.value.origin,
  });
  return { server: client.server, headers: { authorization: `Bearer ${issued.token}` } };
});

type LiveServer = NonNullable<Effect.Success<ReturnType<typeof liveServerClient>>>;

/** The live server's answer, or undefined when it is down, too old, or slow. */
const askLiveServer = <A, E>(
  config: ServerConfig.ServerConfig["Service"],
  call: (live: LiveServer) => Effect.Effect<A, E>,
) =>
  liveServerClient(config).pipe(
    Effect.flatMap((live) => (live === undefined ? Effect.undefined : call(live))),
    Effect.scoped,
    Effect.provide(
      Layer.merge(
        EnvironmentAuth.layerRuntime.pipe(Layer.provide(ServerConfig.layer(config))),
        FetchHttpClient.layer,
      ),
    ),
    Effect.timeoutOption(UPDATE_PAUSE_TIMEOUT),
    Effect.map(Option.getOrUndefined),
    Effect.catchCause((cause) =>
      Effect.logDebug("Could not reach the running server about the update", cause).pipe(
        Effect.as(undefined),
      ),
    ),
  );

const findForegroundServer = Effect.fn("cli.update.find_foreground_server")(function* (input: {
  readonly serverRuntimeStatePath: string;
  readonly serviceInstalled: boolean;
}) {
  const state = yield* readPersistedServerRuntimeState(input.serverRuntimeStatePath);
  if (Option.isNone(state) || state.value.serviceManaged || !isProcessAlive(state.value.pid)) {
    return undefined;
  }
  if (input.serviceInstalled && (yield* belongsToBootService(state.value.pid))) return undefined;
  return state.value;
});

const belongsToBootService = Effect.fn("cli.update.belongs_to_boot_service")(function* (
  pid: number,
) {
  const platform = yield* HostProcess.Platform;
  const fs = yield* FileSystem.FileSystem;
  const runner = yield* ProcessRunner.ProcessRunner;
  if (platform === "linux") {
    const cgroup = yield* fs.readFileString(`/proc/${pid}/cgroup`).pipe(Effect.option);
    return Option.isSome(cgroup) && cgroup.value.includes("/t3code.service");
  }
  if (platform === "darwin") {
    const parent = yield* runner
      .run({
        command: "ps",
        args: ["-o", "ppid=", "-p", String(pid)],
        timeout: Duration.seconds(5),
      })
      .pipe(Effect.option);
    const ppid = Option.isSome(parent) && parent.value.code === 0 ? parent.value.stdout.trim() : "";
    if (!/^\d+$/.test(ppid)) return false;
    const command = yield* runner
      .run({ command: "ps", args: ["-o", "command=", "-p", ppid], timeout: Duration.seconds(5) })
      .pipe(
        Effect.map((result) => (result.code === 0 ? result.stdout : "")),
        Effect.orElseSucceed(() => ""),
      );
    return /__service-launcher/.test(command);
  }
  return false;
});

export const runUpdate = Effect.fn("cli.update.run")(function* (input: {
  readonly pauseLiveServerRuns: Effect.Effect<number | undefined>;
  readonly resumeLiveServerRuns: Effect.Effect<void>;
  readonly baseDir: string;
  readonly logsDir: string;
  readonly databasePath: string;
  readonly serverRuntimeStatePath: string;
  readonly channel: CliReleaseChannel | undefined;
  readonly requestedVersion: string | undefined;
  readonly allowDowngrade: boolean;
  readonly assumeYes: boolean;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const runner = yield* ProcessRunner.ProcessRunner;
  const platform = yield* HostProcess.Platform;
  const arch = yield* HostProcess.Architecture;
  const environment = yield* HostProcess.Environment;
  const httpClient = yield* HttpClient.HttpClient;
  const service = yield* BootService.BootService;
  const policy = yield* ManagedPolicy.ManagedPolicy;
  const mirror = managedUpdateMirror(policy.document);

  const currentVersion = packageJson.version;
  const channel = input.channel ?? cliReleaseChannelOf(currentVersion);
  const refusal = managedUpdateRefusal(
    policy.document,
    input.requestedVersion === undefined ? channel : cliReleaseChannelOf(input.requestedVersion),
  );
  if (refusal !== undefined) {
    return yield* new CliUpdateError({ reason: refusal });
  }
  if (input.requestedVersion !== undefined && !isExactServiceVersion(input.requestedVersion)) {
    return yield* new CliUpdateError({
      reason: `'${input.requestedVersion}' is not an exact ${APP_NAME} version.`,
    });
  }
  const progress = createUpdateProgress();
  progress.status("Checking for updates...");
  const targetVersion = yield* (
    input.requestedVersion !== undefined
      ? Effect.succeed(input.requestedVersion)
      : mirror === undefined
        ? resolveNewestVersion(channel)
        : resolveMirrorVersion(mirror, channel)
  ).pipe(Effect.ensuring(Effect.sync(progress.finish)));
  const targetChannel = cliReleaseChannelOf(targetVersion);

  const launchedAs = (yield* HostProcess.IsExecutable) ? yield* resolveLauncherPath : undefined;
  // What the user just ran runs this program, so it is the fallback before the new runtime exists.
  const command =
    (yield* ownedCommandOnPath({ baseDir: input.baseDir })) ??
    (launchedAs === undefined ? LEGACY_CLI_COMMAND : shellCommandPath(launchedAs, platform));

  const currentChannel = cliReleaseChannelOf(currentVersion);
  if (targetChannel === "preview" && currentChannel !== "preview") {
    yield* Console.log(
      [
        `t3@${targetVersion} is a preview build.`,
        "  Preview builds are cut by maintainers from unreleased branches to exercise the release",
        "  pipeline. They can be broken, receive no fixes, and are never offered as updates; you",
        `  will have to switch back to ${currentChannel} yourself with \`${command} update --channel ${currentChannel} --allow-downgrade\`${inShell(command)}.`,
      ].join("\n"),
    );
    if (!(process.stdin.isTTY && process.stdout.isTTY)) {
      return yield* new CliUpdateError({
        reason:
          "Refusing to install a preview build without confirmation. Run this from a terminal to confirm, or pass --channel preview from an interactive shell.",
      });
    }
    const confirmed = yield* Prompt.run(
      Prompt.Confirm({ message: "Install the preview build anyway?", initial: false }),
    ).pipe(Effect.catchTags({ QuitError: () => Effect.succeed(false) }));
    if (!confirmed) {
      yield* Console.log("Left as is.");
      return;
    }
  }

  const status = yield* service.status;
  // Service names are per user, so another home's unit belongs to a different install.
  const servesThisHome =
    status.installedBaseDir !== undefined &&
    path.resolve(status.installedBaseDir) === path.resolve(input.baseDir);
  const serviceInstalled = status.supported && status.installed && servesThisHome;
  const foreground = yield* findForegroundServer({
    serverRuntimeStatePath: input.serverRuntimeStatePath,
    serviceInstalled,
  });
  const serviceVersion = serviceInstalled ? status.installedVersion : undefined;
  const executableCurrent = targetVersion === currentVersion;
  const restartPending = status.problems?.includes("restart-pending") === true;
  const serviceCurrent =
    !serviceInstalled ||
    (serviceVersion === targetVersion &&
      (executableCurrent ? status.current : (status.problems ?? []).length === 0));
  const newestInstalled =
    serviceVersion !== undefined && compareExactServiceVersions(serviceVersion, currentVersion) > 0
      ? serviceVersion
      : currentVersion;

  if (executableCurrent && serviceCurrent) {
    yield* Console.log(
      serviceVersion !== undefined
        ? `${APP_NAME} and its background service are already on ${targetVersion} (${targetChannel}).`
        : `${APP_NAME} is already on ${targetVersion} (${targetChannel}).`,
    );
    return;
  }
  if (!input.allowDowngrade && compareExactServiceVersions(targetVersion, newestInstalled) < 0) {
    return yield* new CliUpdateError({
      reason: `t3@${targetVersion} is older than the installed ${newestInstalled}. Pass --allow-downgrade to install it anyway.`,
    });
  }

  const alreadyOnDisk = yield* fs
    .readFileString(pinnedRuntimePaths(path, input.baseDir, targetVersion, platform).sentinelPath)
    .pipe(
      Effect.map((sentinel) => sentinel.trim() === targetVersion),
      Effect.orElseSucceed(() => false),
    );

  progress.heading(
    executableCurrent && restartPending
      ? `The background service is still running the version before ${targetVersion} (${targetChannel}).`
      : executableCurrent
        ? `Updating the background service ${serviceVersion ?? "(unknown version)"} -> ${targetVersion} (${targetChannel}).`
        : alreadyOnDisk
          ? `Switching ${APP_NAME}`
          : `Updating ${APP_NAME}`,
    executableCurrent
      ? ""
      : `${currentVersion} → ${targetVersion}${targetChannel === "stable" ? "" : ` (${targetChannel})`}`,
  );
  let restartService = false;
  if (serviceInstalled && !serviceCurrent) {
    yield* Console.log(
      `  A background service is installed for this ${APP_NAME} home. Restarting it interrupts anything running in it: agent turns, terminals, remote clients.`,
    );
    if (input.assumeYes) {
      restartService = true;
    } else if (process.stdin.isTTY && process.stdout.isTTY) {
      restartService = yield* Prompt.run(
        Prompt.Confirm({
          message: "Restart the background service once the download is verified?",
          initial: true,
        }),
      ).pipe(Effect.catchTags({ QuitError: () => Effect.succeed(false) }));
    } else {
      yield* Console.log(
        `  Not a terminal, so the service keeps running its current version. Rerun with --yes to restart it now, or run \`${command} service restart\`${inShell(command)} later.`,
      );
    }
  }

  const runtime = yield* ensurePinnedRuntimeInstalled({
    onProgress: progress.report,
    baseDir: input.baseDir,
    version: targetVersion,
    fs,
    path,
    runner,
    httpClient,
    platform,
    arch,
    releaseBaseUrl: mirror?.feedUrl ?? (environment[CLI_RELEASE_BASE_URL_ENV]?.trim() || undefined),
    requirePublishedRelease: mirror !== undefined,
    validate: (runtime) =>
      runStagedServicePreflight({
        runner,
        runtime,
        targetVersion,
        databasePath: input.databasePath,
        // The target then runs under its own launcher, so only its database check matters. Older
        // builds may predate protocol 4; every stable release since 0.0.43 accepts 3.
        launcherProtocol:
          compareExactServiceVersions(targetVersion, currentVersion) < 0
            ? 3
            : SERVICE_LAUNCHER_PROTOCOL,
      }).pipe(
        Effect.catchTags({
          PinnedRuntimeInstallError: (error) =>
            Effect.fail(
              error.exitCode === undefined
                ? error
                : new PinnedRuntimePreflightBlockedError({
                    version: targetVersion,
                    reason: `t3@${targetVersion} could not confirm it supports this database (its check exited with code ${error.exitCode}), so ${APP_NAME} did not switch to it.`,
                  }),
            ),
        }),
      ),
  }).pipe(
    Effect.ensuring(Effect.sync(progress.finish)),
    Effect.catchTags({
      PinnedRuntimePreflightBlockedError: (error) =>
        Effect.fail(new CliUpdateError({ reason: error.reason })),
    }),
    Effect.catchIf(isUnpublishedRelease, () =>
      Effect.fail(
        new CliUpdateError({
          reason:
            mirror === undefined
              ? `No release archive was published for t3@${targetVersion}.`
              : `${mirror.organization}'s update mirror has no t3@${targetVersion} for this machine.`,
        }),
      ),
    ),
  );

  yield* repointLauncher({
    launchedAs,
    baseDir: input.baseDir,
    targetEntryPath: runtime.entryPath,
  });

  // Use today's service manager for the target version. Inside the service it hands off to
  // the target CLI, so stopping this process cannot interrupt the switch.
  let servicePlan: BootService.BootServicePlan | undefined;
  if (serviceInstalled && !serviceCurrent) {
    // From inside the service, pausing would interrupt the turn running this update.
    let pausedRuns: number | undefined;
    if (restartService && foreground === undefined && !environment[SERVICE_UNIT_ENV]) {
      pausedRuns = yield* input.pauseLiveServerRuns;
      if (pausedRuns !== undefined && pausedRuns > 0) {
        yield* Console.log(
          pausedRuns === 1
            ? "  Paused 1 running turn; it resumes after the restart."
            : `  Paused ${pausedRuns} running turns; they resume after the restart.`,
        );
      }
    }
    yield* Console.log(
      restartService
        ? "Restarting the background service..."
        : "Updating the background service...",
    );
    servicePlan = yield* BootService.BootService.pipe(
      Effect.flatMap((target) =>
        target.install({ allowDowngrade: input.allowDowngrade, start: restartService }),
      ),
      Effect.tapCause(() => (pausedRuns === undefined ? Effect.void : input.resumeLiveServerRuns)),
      Effect.provide(
        BootService.layer({
          baseDir: input.baseDir,
          logsDir: input.logsDir,
          cliVersion: targetVersion,
        }),
      ),
      Effect.mapError(
        (error) =>
          new CliUpdateError({
            reason: `t3@${targetVersion} is installed but the background service could not be ${restartService ? "updated" : "pointed at it"}: ${error.message}`,
          }),
      ),
    );
  }

  // A handed-off service install rewrites the unit later, while the old launcher may be stopped.
  if (servicePlan?.handedOff !== true) {
    // A stopped service's unit still names the launcher runtime it will start.
    const unit = yield* fs
      .readFile(status.unitPath)
      .pipe(Effect.map(decodeServiceUnit), Effect.option);
    yield* prunePinnedRuntimes({
      baseDir: input.baseDir,
      keep: [currentVersion, targetVersion],
      references: Option.toArray(Option.flatMapNullishOr(unit, BootService.bootServiceProgramOf)),
    });
  }

  const commandOnPath = yield* ownedCommandOnPath({
    baseDir: input.baseDir,
    runs: runtime.entryPath,
  });
  const installedCommand = commandOnPath ?? shellCommandPath(runtime.entryPath, platform);
  progress.success(`Installed ${APP_NAME} ${targetVersion}`);
  yield* Console.log(
    commandOnPath === undefined
      ? `  Run ${installedCommand}${inShell(installedCommand)}\n`
      : `  Run ${installedCommand} to get started.\n`,
  );
  if (servicePlan?.handedOff === true) {
    yield* Console.log(
      `  Background service switching to ${targetVersion} outside this session, since this session runs inside it and disconnects when it restarts. Result: ${servicePlan.logPath}`,
    );
  } else if (servicePlan !== undefined && restartService) {
    yield* Console.log(`  Background service restarted on ${targetVersion}`);
  } else if (serviceInstalled && serviceCurrent) {
    yield* Console.log(`  Background service already on ${targetVersion}`);
  } else if (serviceInstalled) {
    // A pending restart means the service already points at serviceVersion but runs an older one.
    const running =
      serviceVersion === undefined
        ? "an unknown version"
        : restartPending
          ? `the version before ${serviceVersion}`
          : serviceVersion;
    yield* Console.log(
      `  Background service still running ${running}. Run \`${installedCommand} service restart\`${inShell(installedCommand)} when you are ready to switch it to ${targetVersion}.`,
    );
  } else if (status.installed && !servesThisHome) {
    yield* Console.log(
      `  The background service serves ${status.installedBaseDir ?? `another ${APP_NAME} home`} and was left unchanged.`,
    );
  }
  if (foreground !== undefined) {
    yield* Console.log(
      `  A server started by hand is still running at ${foreground.origin} (pid ${foreground.pid}). Stop it and start it again to pick up ${targetVersion}.`,
    );
  }
});
