import * as NodeSea from "node:sea";

import {
  HostProcessArchitecture,
  HostProcessEnvironment,
  HostProcessExecutablePath,
  HostProcessPlatform,
} from "@t3tools/shared/hostProcess";
import {
  CLI_RELEASE_BASE_URL_ENV,
  CLI_RELEASE_CHANNELS,
  cliReleaseIndexPageUrl,
  cliReleaseChannelOf,
  isArchiveDistributedVersion,
  newestCliReleaseVersion,
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
import { Argument, Command, Flag, GlobalFlag, Prompt } from "effect/unstable/cli";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http";

import packageJson from "../../package.json" with { type: "json" };
import * as BootService from "../cloud/bootService.ts";
import {
  ensurePinnedRuntimeInstalled,
  pinnedRuntimeCommand,
  PinnedRuntimeInstallError,
  pinnedRuntimePaths,
} from "../cloud/pinnedRuntime.ts";
import { compareExactServiceVersions, isExactServiceVersion } from "../cloud/serviceProtocol.ts";
import * as ProcessRunner from "../processRunner.ts";
import { isProcessAlive, readPersistedServerRuntimeState } from "../serverRuntimeState.ts";
import { projectLocationFlags, resolveCliAuthConfig } from "./config.ts";
import { bootServiceLayer } from "./service.ts";

export class CliUpdateError extends Schema.TaggedError<CliUpdateError>()("CliUpdateError", {
  reason: Schema.String,
}) {
  override get message(): string {
    return this.reason;
  }
}

const ReleaseIndex = Schema.Array(
  Schema.Struct({
    tag_name: Schema.String,
    draft: Schema.optional(Schema.Boolean),
  }),
);
const decodeReleaseIndex = Schema.decodeUnknownEffect(Schema.fromJsonString(ReleaseIndex));

const RELEASE_INDEX_TIMEOUT = Duration.seconds(30);
// Enough to walk past a long run of nightlies without hammering the API when
// a channel genuinely has nothing published.
const RELEASE_INDEX_MAX_PAGES = 10;

/** Asks GitHub for the newest published version on a channel, page by page. */
const resolveNewestVersion = Effect.fn("cli.update.resolve_newest")(function* (
  channel: CliReleaseChannel,
) {
  const httpClient = yield* HttpClient.HttpClient;
  for (let page = 1; page <= RELEASE_INDEX_MAX_PAGES; page += 1) {
    const body = yield* httpClient
      .execute(
        HttpClientRequest.get(cliReleaseIndexPageUrl(page)).pipe(
          HttpClientRequest.setHeader("Accept", "application/vnd.github+json"),
        ),
      )
      .pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.flatMap((response) => response.text),
        Effect.mapError(() => new CliUpdateError({ reason: "Could not list t3 releases." })),
        Effect.timeoutOrElse({
          duration: RELEASE_INDEX_TIMEOUT,
          orElse: () =>
            Effect.fail(new CliUpdateError({ reason: "Timed out listing t3 releases." })),
        }),
      );
    const releases = yield* decodeReleaseIndex(body).pipe(
      Effect.mapError(
        () => new CliUpdateError({ reason: "The t3 release index had an unexpected shape." }),
      ),
    );
    const version = newestCliReleaseVersion(releases, channel);
    if (version !== undefined) return version;
    if (releases.length === 0) break;
  }
  return yield* new CliUpdateError({ reason: `No published ${channel} release was found.` });
});

/**
 * The launcher the install scripts leave behind: a symlink at `<bin>/t3` on
 * POSIX, a `t3.cmd` shim on Windows. `t3 update` repoints it so the next `t3`
 * invocation is the new version. Only a launcher that already points into
 * this home's `runtime/versions` tree is touched; a plain copy of the
 * executable, or a launcher for some other install, is left alone.
 */
export const repointLauncher = Effect.fn("cli.update.repoint_launcher")(function* (input: {
  /** Path the current process was started through, if known. */
  readonly launchedAs: string | undefined;
  /** `<baseDir>/runtime/versions` of the home being updated. */
  readonly versionsDir: string;
  readonly targetEntryPath: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcessPlatform;
  if (input.launchedAs === undefined) return Option.none<string>();
  const ownsTarget = (candidate: string) => {
    const relative = path.relative(input.versionsDir, path.resolve(candidate));
    return relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative);
  };

  if (platform === "win32") {
    // The shim runs the executable by absolute path, so the executable sees
    // itself as argv0; the shim is the `t3.cmd` next to it only when launched
    // from an install script's bin directory. Find it by searching the
    // directories that would resolve `t3` on this shell's PATH.
    const shimPath = yield* findWindowsShim(input.launchedAs);
    if (shimPath === undefined) return Option.none<string>();
    const current = yield* fs.readFileString(shimPath).pipe(Effect.option);
    const quoted = Option.isSome(current) ? /^"([^"]+)"/m.exec(current.value)?.[1] : undefined;
    if (quoted === undefined || !ownsTarget(quoted)) return Option.none<string>();
    yield* fs
      .writeFileString(shimPath, `@echo off\r\n"${input.targetEntryPath}" %*`)
      .pipe(
        Effect.mapError(
          () => new CliUpdateError({ reason: `Could not rewrite the t3 launcher at ${shimPath}.` }),
        ),
      );
    return Option.some(shimPath);
  }

  const linkTarget = yield* fs.readLink(input.launchedAs).pipe(Effect.option);
  if (Option.isNone(linkTarget)) return Option.none<string>();
  const resolvedTarget = path.resolve(path.dirname(input.launchedAs), linkTarget.value);
  if (!ownsTarget(resolvedTarget)) return Option.none<string>();
  const tempLink = `${input.launchedAs}.${process.pid}.tmp`;
  yield* fs.symlink(input.targetEntryPath, tempLink).pipe(
    Effect.andThen(fs.rename(tempLink, input.launchedAs)),
    Effect.mapError(
      () =>
        new CliUpdateError({ reason: `Could not repoint the t3 launcher at ${input.launchedAs}.` }),
    ),
  );
  return Option.some(input.launchedAs);
});

/**
 * On Windows a `.cmd` shim is what PATH resolves, but the executable it runs
 * only ever sees its own path. Walk PATH for a `t3.cmd` whose target is the
 * running executable; that is the launcher the install script wrote.
 */
const findWindowsShim = Effect.fn("cli.update.find_windows_shim")(function* (
  executablePath: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const environment = yield* HostProcessEnvironment;
  const candidates = [
    ...(environment["T3CODE_INSTALL_BIN_DIR"] ? [environment["T3CODE_INSTALL_BIN_DIR"]] : []),
    ...(environment["PATH"] ?? environment["Path"] ?? "").split(";"),
  ].filter((entry) => entry.trim().length > 0);
  for (const directory of candidates) {
    const shimPath = path.join(directory, "t3.cmd");
    const contents = yield* fs.readFileString(shimPath).pipe(Effect.option);
    if (Option.isNone(contents)) continue;
    const target = /^"([^"]+)"/m.exec(contents.value)?.[1];
    if (
      target !== undefined &&
      path.resolve(target).toLowerCase() === path.resolve(executablePath).toLowerCase()
    ) {
      return shimPath;
    }
  }
  return undefined;
});

const updateFlags = {
  ...projectLocationFlags,
  channel: Flag.choice("channel", CLI_RELEASE_CHANNELS).pipe(
    Flag.withDescription(
      "Release channel to follow. Defaults to the channel this t3 was published on.",
    ),
    Flag.optional,
  ),
  allowDowngrade: Flag.boolean("allow-downgrade").pipe(
    Flag.withDescription("Allow moving to an older version than the one running."),
    Flag.withDefault(false),
  ),
  yes: Flag.boolean("yes").pipe(
    Flag.withAlias("y"),
    Flag.withDescription(
      "Restart the background service without asking. Required to restart it from a script, where there is no prompt.",
    ),
    Flag.withDefault(false),
  ),
};

const versionArgument = Argument.string("version").pipe(
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
    "Download a newer t3 and switch this machine to it, including the background service when one is installed.",
  ),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const logLevel = yield* GlobalFlag.LogLevel;
      const config = yield* resolveCliAuthConfig(flags, logLevel);
      return yield* runUpdate({
        baseDir: config.baseDir,
        serverRuntimeStatePath: config.serverRuntimeStatePath,
        channel: Option.getOrUndefined(flags.channel),
        requestedVersion: Option.getOrUndefined(flags.version),
        allowDowngrade: flags.allowDowngrade,
        assumeYes: flags.yes,
      }).pipe(
        Effect.provide(
          Layer.mergeAll(bootServiceLayer(config), ProcessRunner.layer, FetchHttpClient.layer),
        ),
      );
    }),
  ),
);

/**
 * A `t3 serve` or `t3` someone started by hand, as opposed to the one the
 * background service supervises. The server records its pid on startup; a
 * stale file from a crashed server is ignored by checking the pid is alive.
 *
 * Servers from before `serviceManaged` was recorded cannot be told apart by
 * the file alone, so the launcher-supervised case is also recognised by
 * lineage: a service server's parent is the launcher, and on Linux that
 * launcher runs inside the unit's cgroup.
 */
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
  const platform = yield* HostProcessPlatform;
  const fs = yield* FileSystem.FileSystem;
  const runner = yield* ProcessRunner.ProcessRunner;
  if (platform === "linux") {
    const cgroup = yield* fs.readFileString(`/proc/${pid}/cgroup`).pipe(Effect.option);
    return Option.isSome(cgroup) && cgroup.value.includes("/t3code.service");
  }
  if (platform === "darwin") {
    // The service server's parent is the launcher process.
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
    return /__service-launcher|service-launcher\.mjs/.test(command);
  }
  return false;
});

const runUpdate = Effect.fn("cli.update.run")(function* (input: {
  readonly baseDir: string;
  readonly serverRuntimeStatePath: string;
  readonly channel: CliReleaseChannel | undefined;
  readonly requestedVersion: string | undefined;
  readonly allowDowngrade: boolean;
  readonly assumeYes: boolean;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const runner = yield* ProcessRunner.ProcessRunner;
  const platform = yield* HostProcessPlatform;
  const arch = yield* HostProcessArchitecture;
  const execPath = yield* HostProcessExecutablePath;
  const environment = yield* HostProcessEnvironment;
  const httpClient = yield* HttpClient.HttpClient;
  const service = yield* BootService.BootService;

  const currentVersion = packageJson.version;
  const channel = input.channel ?? cliReleaseChannelOf(currentVersion);
  if (input.requestedVersion !== undefined && !isExactServiceVersion(input.requestedVersion)) {
    return yield* new CliUpdateError({
      reason: `'${input.requestedVersion}' is not an exact t3 version.`,
    });
  }
  const targetVersion = input.requestedVersion ?? (yield* resolveNewestVersion(channel));
  const targetChannel = cliReleaseChannelOf(targetVersion);

  // Preview is a maintainers' dogfooding train: it is cut by hand from
  // unmerged branches, receives no fixes, and is never offered to anyone.
  // Reaching it from stable or nightly takes an explicit ask and an explicit
  // acknowledgement; the flag alone is not enough from a script.
  const currentChannel = cliReleaseChannelOf(currentVersion);
  if (targetChannel === "preview" && currentChannel !== "preview") {
    yield* Console.log(
      [
        `t3@${targetVersion} is a preview build.`,
        "  Preview builds are cut by maintainers from unreleased branches to exercise the release",
        "  pipeline. They can be broken, receive no fixes, and are never offered as updates; you",
        `  will have to switch back to ${currentChannel} yourself with \`t3 update --channel ${currentChannel} --allow-downgrade\`.`,
      ].join("\n"),
    );
    if (!(process.stdin.isTTY && process.stdout.isTTY)) {
      return yield* new CliUpdateError({
        reason:
          "Refusing to install a preview build without confirmation. Run this from a terminal to confirm, or pass --channel preview from an interactive shell.",
      });
    }
    const confirmed = yield* Prompt.run(
      Prompt.confirm({ message: "Install the preview build anyway?", initial: false }),
    ).pipe(Effect.catchTag("QuitError", () => Effect.succeed(false)));
    if (!confirmed) {
      yield* Console.log("Left as is.");
      return;
    }
  }

  // Work out everything that will be touched before touching anything, so the
  // user sees one plan and one question rather than a surprise restart.
  const status = yield* service.status;
  // The unit name is per user, not per T3 home. Only touch the service when it
  // serves the home this update targets; otherwise it belongs to another
  // install on this machine and restarting it would take that server down.
  const servesThisHome =
    status.installedBaseDir !== undefined &&
    path.resolve(status.installedBaseDir) === path.resolve(input.baseDir);
  const serviceInstalled = status.supported && status.installed && servesThisHome;
  const foreground = yield* findForegroundServer({
    serverRuntimeStatePath: input.serverRuntimeStatePath,
    serviceInstalled,
  });
  // What this machine runs is the executable behind the launcher and, when a
  // service is installed for this home, the version that service runs. Either
  // being stale is an update to do, and the newest of the two is what the
  // downgrade check protects.
  const serviceVersion = serviceInstalled ? status.installedVersion : undefined;
  const executableCurrent = targetVersion === currentVersion;
  const serviceCurrent = serviceVersion === undefined || serviceVersion === targetVersion;
  const newestInstalled =
    serviceVersion !== undefined && compareExactServiceVersions(serviceVersion, currentVersion) > 0
      ? serviceVersion
      : currentVersion;

  // Only archive-distributed versions install without Node and npm on the
  // machine. Until nightly and stable ship archives, updating onto them from
  // here would reintroduce the dependency this command exists to remove.
  if (!isArchiveDistributedVersion(targetVersion)) {
    return yield* new CliUpdateError({
      reason: `t3@${targetVersion} is published on npm only. Install it with \`npm install -g t3@${targetVersion}\`, or pick a version from the preview channel.`,
    });
  }
  if (executableCurrent && serviceCurrent) {
    yield* Console.log(
      serviceVersion !== undefined
        ? `t3 and its background service are already on ${targetVersion} (${targetChannel}).`
        : `t3 is already on ${targetVersion} (${targetChannel}).`,
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

  yield* Console.log(
    executableCurrent
      ? `Updating the background service ${serviceVersion} -> ${targetVersion} (${targetChannel}).`
      : alreadyOnDisk
        ? `Switching t3 ${currentVersion} -> ${targetVersion} (${targetChannel}, already downloaded).`
        : `Updating t3 ${currentVersion} -> ${targetVersion} (${targetChannel}).`,
  );
  let restartService = false;
  if (serviceInstalled && !serviceCurrent) {
    yield* Console.log(
      "  A background service is installed for this T3 home. Restarting it interrupts anything running in it: agent turns, terminals, remote clients.",
    );
    if (input.assumeYes) {
      restartService = true;
    } else if (process.stdin.isTTY && process.stdout.isTTY) {
      restartService = yield* Prompt.run(
        Prompt.confirm({
          message: "Restart the background service once the download is verified?",
          initial: true,
        }),
      ).pipe(Effect.catchTag("QuitError", () => Effect.succeed(false)));
    } else {
      yield* Console.log(
        "  Not a terminal, so the service is left on its current version. Rerun with --yes to restart it, or run `t3 service update` later.",
      );
    }
  }

  const runtime = yield* ensurePinnedRuntimeInstalled({
    baseDir: input.baseDir,
    version: targetVersion,
    fs,
    path,
    runner,
    httpClient,
    platform,
    arch,
    releaseBaseUrl: environment[CLI_RELEASE_BASE_URL_ENV]?.trim() || undefined,
    validate: (paths) =>
      runner
        .run({
          command: pinnedRuntimeCommand(paths, execPath).command,
          args: [...pinnedRuntimeCommand(paths, execPath).args, "--version"],
          timeout: Duration.seconds(30),
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new PinnedRuntimeInstallError({ step: "verifying the downloaded t3", cause }),
          ),
          Effect.flatMap((result) =>
            result.code === 0 && /\bv(\S+)\s*$/.exec(result.stdout)?.[1] === targetVersion
              ? Effect.void
              : Effect.fail(
                  new PinnedRuntimeInstallError({
                    step: "verifying the downloaded t3",
                    exitCode: Number(result.code),
                  }),
                ),
          ),
        ),
  }).pipe(
    Effect.catchIf(
      (error): error is PinnedRuntimeInstallError =>
        error._tag === "PinnedRuntimeInstallError" &&
        error.step.startsWith("downloading the t3 release checksums") &&
        String(error.cause).includes("404"),
      () =>
        Effect.fail(
          new CliUpdateError({
            reason: `No release archive was published for t3@${targetVersion}.`,
          }),
        ),
    ),
  );

  // Node rewrites argv[0] and execPath to the resolved binary, but argv0 is
  // the string the shell actually passed, which is the launcher symlink when
  // the executable was started through one. A relative argv0 (`./t3`) is
  // resolved against the working directory the process started in.
  const launchedAs = NodeSea.isSea() ? path.resolve(process.argv0) : undefined;
  const repointed = yield* repointLauncher({
    launchedAs,
    versionsDir: path.dirname(runtime.versionDir),
    targetEntryPath: runtime.entryPath,
  });

  // The new executable owns the service switch: it verifies itself, writes its
  // own version into the unit, and restarts the service on it.
  let serviceUpdated = false;
  if (restartService) {
    const result = yield* runner.run({
      command: runtime.entryPath,
      args: [
        "service",
        "update",
        "--base-dir",
        input.baseDir,
        ...(input.allowDowngrade ? ["--allow-downgrade"] : []),
      ],
      timeout: Duration.minutes(5),
    });
    if (result.code !== 0) {
      return yield* new CliUpdateError({
        reason: `t3@${targetVersion} is installed but the background service could not be updated (exit ${String(result.code)}).\n${result.stderr.trim() || result.stdout.trim()}`,
      });
    }
    serviceUpdated = true;
  }

  yield* Console.log("");
  yield* Console.log(`t3 ${targetVersion} is installed at ${runtime.entryPath}`);
  if (Option.isSome(repointed)) {
    yield* Console.log(`  ${repointed.value} now runs ${targetVersion}`);
  } else {
    yield* Console.log(`  Run it as ${runtime.entryPath}, or point your \`t3\` launcher at it.`);
  }
  if (serviceUpdated) {
    yield* Console.log(`  Background service restarted on ${targetVersion}`);
  } else if (serviceInstalled && serviceCurrent) {
    yield* Console.log(`  Background service already on ${targetVersion}`);
  } else if (serviceInstalled) {
    yield* Console.log(
      `  Background service still running ${serviceVersion}. Run \`t3 service update\` when you are ready to restart it.`,
    );
  } else if (status.installed && !servesThisHome) {
    yield* Console.log(
      `  The background service serves ${status.installedBaseDir ?? "another T3 home"} and was left unchanged.`,
    );
  }
  if (foreground !== undefined) {
    yield* Console.log(
      `  A server started by hand is still running at ${foreground.origin} (pid ${foreground.pid}). Stop it and start it again to pick up ${targetVersion}.`,
    );
  }
});
