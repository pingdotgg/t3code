import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";
import type { HttpClient } from "effect/http";

import * as HostProcess from "@t3tools/shared/HostProcess";

import * as ProcessRunner from "../processRunner.ts";
import { isExactServiceVersion, parseServiceState, SERVICE_STATE_FILE } from "./serviceProtocol.ts";

/**
 * An exact t3 build under <baseDir>/runtime/versions/<version>, run by the boot service and self-update.
 * [fork:lockdown] Upstream downloads a missing runtime; here only a complete one already on disk is
 * used, and anything else is a hard error. The single choke point for self-update, boot-service
 * installs and `t3 update`; invariant 2.
 */
const PINNED_RUNTIME_DIR = "runtime";
// Boot-service setup and remote update can construct separate layers. Serialize
// the complete install transaction across every caller in this process.
const pinnedRuntimeInstallLock = Semaphore.makeUnsafe(1);

export interface PinnedRuntimePaths {
  readonly versionDir: string;
  readonly entryPath: string;
  readonly sentinelPath: string;
}

export function pinnedRuntimeCommand(paths: PinnedRuntimePaths): {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
} {
  return { command: paths.entryPath, args: [] };
}

export function pinnedRuntimeVersionsDir(path: Path.Path, baseDir: string): string {
  return path.join(baseDir, PINNED_RUNTIME_DIR, "versions");
}

export function pinnedRuntimePaths(
  path: Path.Path,
  baseDir: string,
  version: string,
  platform: NodeJS.Platform,
): PinnedRuntimePaths {
  const versionDir = path.join(pinnedRuntimeVersionsDir(path, baseDir), version);
  return {
    versionDir,
    entryPath: path.join(versionDir, platform === "win32" ? "t3.exe" : "t3"),
    sentinelPath: path.join(versionDir, ".install-complete"),
  };
}

export class PinnedRuntimeInstallError extends Schema.TaggedError<PinnedRuntimeInstallError>()(
  "PinnedRuntimeInstallError",
  {
    step: Schema.String,
    exitCode: Schema.optional(Schema.Number),
    stdoutLength: Schema.optional(Schema.Number),
    stderrLength: Schema.optional(Schema.Number),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.exitCode === undefined
      ? `Pinned runtime install failed while ${this.step}.`
      : `Pinned runtime install failed while ${this.step} (exit code ${this.exitCode}).`;
  }
}

export class PinnedRuntimePreflightBlockedError extends Schema.TaggedError<PinnedRuntimePreflightBlockedError>()(
  "PinnedRuntimePreflightBlockedError",
  {
    version: Schema.String,
    reason: Schema.String,
  },
) {
  override get message(): string {
    return this.reason;
  }
}

export type PinnedRuntimeProgress =
  | { readonly stage: "download"; readonly received: number; readonly total: number | undefined }
  | { readonly stage: "verify" | "extract" | "validate" | "cached" };

/**
 * Returns the paths of a complete pinned runtime already on disk (sentinel
 * plus entry file), after validating it. Fails when the runtime is missing or
 * incomplete, because [fork:lockdown] this fork never downloads t3.
 */
interface PinnedRuntimeInstallInput {
  readonly baseDir: string;
  readonly version: string;
  readonly fs: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly runner: ProcessRunner.ProcessRunner["Service"];
  readonly validate: (
    paths: PinnedRuntimePaths,
  ) => Effect.Effect<void, PinnedRuntimeInstallError | PinnedRuntimePreflightBlockedError>;
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  // [fork:lockdown] Upstream's download inputs, kept so its call sites merge
  // unchanged. Nothing here reads them.
  readonly httpClient: HttpClient.HttpClient;
  readonly releaseBaseUrl?: string | undefined;
  readonly onProgress?: (progress: PinnedRuntimeProgress) => void;
}

const installPinnedRuntime = Effect.fn("cloud.pinned_runtime.ensure_installed")(function* (
  input: PinnedRuntimeInstallInput,
) {
  const { fs } = input;
  const paths = pinnedRuntimePaths(input.path, input.baseDir, input.version, input.platform);
  const [entryExists, sentinel] = yield* Effect.all([
    fs.exists(paths.entryPath),
    fs.readFileString(paths.sentinelPath).pipe(Effect.option),
  ]).pipe(
    Effect.mapError(
      (cause) => new PinnedRuntimeInstallError({ step: "checking the pinned runtime", cause }),
    ),
  );
  const alreadyPinned =
    entryExists && Option.isSome(sentinel) && sentinel.value.trim() === input.version;
  if (alreadyPinned) {
    input.onProgress?.({ stage: "cached" });
    yield* input.validate(paths);
    return paths;
  }

  return yield* new PinnedRuntimeInstallError({
    step: `refusing to download t3 ${input.version}: this fork only runs builds provisioned on this machine; place a complete runtime at ${paths.versionDir} (executable at ${paths.entryPath}, "${input.version}" in ${paths.sentinelPath})`,
  });
});

export const ensurePinnedRuntimeInstalled = (input: PinnedRuntimeInstallInput) =>
  pinnedRuntimeInstallLock.withPermit(installPinnedRuntime(input));

const PINNED_RUNTIME_PRUNED_PREFIX = ".pruned-";
/**
 * Another process may have just published a runtime it has not yet pointed anything at: an
 * update, a downgrade, or the install script between unpacking and linking. The install lock only
 * covers this process, so recently completed runtimes are left for a later prune.
 */
const PINNED_RUNTIME_PRUNE_GRACE = Duration.hours(1);
/**
 * One `t3` launcher path per line, appended by the install scripts and by any prune that finds a
 * launcher on PATH. A service does not see the installer's `T3CODE_INSTALL_BIN_DIR` or the
 * interactive PATH, so this is how it finds a custom one, including installs that predate the file.
 */
const PINNED_RUNTIME_LAUNCHERS_FILE = "launchers";

export function launcherOwnsVersionsDir(
  path: Path.Path,
  versionsDir: string,
  candidate: string,
): boolean {
  const relative = path.relative(versionsDir, path.resolve(candidate));
  return relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative);
}

/** The executable a `t3.cmd` shim written by the install script or `t3 update` runs. */
export const windowsShimTarget = (contents: string) => /^"([^"]+)"/m.exec(contents)?.[1];

/** Where the `t3` launchers written by the install scripts and `t3 update` point. */
const shellLauncherTargets = Effect.fn("cloud.pinned_runtime.shell_launcher_targets")(function* (
  baseDir: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcess.Platform;
  const environment = yield* HostProcess.Environment;
  const home = yield* HostProcess.HomeDirectory;
  const launcherName = platform === "win32" ? "t3.cmd" : "t3";
  const launchersFile = path.join(baseDir, PINNED_RUNTIME_DIR, PINNED_RUNTIME_LAUNCHERS_FILE);
  const recorded = (yield* fs.readFileString(launchersFile).pipe(Effect.orElseSucceed(() => "")))
    .split(/\r?\n/)
    .filter((launcher) => launcher.trim().length > 0);
  const found = [
    environment["T3CODE_INSTALL_BIN_DIR"] || path.join(home, ".local", "bin"),
    ...(environment["PATH"] ?? environment["Path"] ?? "").split(platform === "win32" ? ";" : ":"),
  ]
    .filter((directory) => path.isAbsolute(directory))
    .map((directory) => path.join(directory, launcherName));
  const versionsDir = pinnedRuntimeVersionsDir(path, baseDir);
  const realVersionsDir = yield* fs
    .realPath(versionsDir)
    .pipe(Effect.orElseSucceed(() => versionsDir));
  const unrecorded: Array<string> = [];
  const targets: Array<string> = [];
  for (const launcher of [...recorded, ...found]) {
    const target =
      platform === "win32"
        ? yield* fs.readFileString(launcher).pipe(
            Effect.map(windowsShimTarget),
            Effect.orElseSucceed(() => undefined),
          )
        : // Fully resolved, through chained links and a symlinked T3 home alike.
          yield* fs.realPath(launcher).pipe(Effect.orElseSucceed(() => undefined));
    if (target === undefined) continue;
    targets.push(target);
    if (
      (launcherOwnsVersionsDir(path, versionsDir, target) ||
        launcherOwnsVersionsDir(path, realVersionsDir, target)) &&
      !recorded.includes(launcher) &&
      !unrecorded.includes(launcher)
    ) {
      unrecorded.push(launcher);
    }
  }
  if (unrecorded.length > 0) {
    yield* fs
      .writeFileString(launchersFile, unrecorded.map((launcher) => `${launcher}\n`).join(""), {
        flag: "a",
      })
      .pipe(Effect.ignore);
  }
  return targets;
});

/**
 * Resolved executables rather than command lines: a server started through the `t3` symlink
 * shows up as `t3 serve`, possibly from another T3 home that runs this home's runtimes. Windows
 * has no symlink launcher, and its `t3.cmd` shim runs the absolute path, so command lines do there.
 */
const runningExecutables = Effect.fn("cloud.pinned_runtime.running_executables")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const runner = yield* ProcessRunner.ProcessRunner;
  const platform = yield* HostProcess.Platform;
  if (platform === "linux") {
    const pids = yield* fs.readDirectory("/proc").pipe(Effect.option);
    if (Option.isNone(pids)) return Option.none<string>();
    const executables: Array<string> = [];
    for (const pid of pids.value) {
      if (!/^\d+$/.test(pid)) continue;
      // Unreadable ones belong to other users or are this user's non-dumpable daemons (systemd
      // --user, ssh-agent). Neither runs a t3 runtime, and bailing on them would never prune.
      const executable = yield* fs.readLink(`/proc/${pid}/exe`).pipe(Effect.option);
      if (Option.isSome(executable)) executables.push(executable.value);
    }
    return executables.length === 0 ? Option.none<string>() : Option.some(executables.join("\n"));
  }
  const result = yield* runner
    .run({
      ...(platform === "win32"
        ? {
            command: "powershell.exe",
            args: [
              "-NoProfile",
              "-NonInteractive",
              "-Command",
              "Get-CimInstance Win32_Process | Select-Object -ExpandProperty CommandLine",
            ],
          }
        : { command: "lsof", args: ["-nP", "-w", "-d", "txt", "-F", "n"] }),
      timeout: Duration.seconds(10),
      maxOutputBytes: 16 * 1024 * 1024,
    })
    .pipe(Effect.option);
  return Option.isSome(result) && result.value.code === 0 && result.value.stdout.length > 0
    ? Option.some(result.value.stdout)
    : Option.none<string>();
});

const selectUnusedRuntimes = Effect.fn("cloud.pinned_runtime.select_unused")(function* (input: {
  readonly baseDir: string;
  readonly keep: ReadonlyArray<string>;
  readonly references: ReadonlyArray<string>;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const versionsDir = pinnedRuntimeVersionsDir(path, input.baseDir);
  const entries = yield* fs.readDirectory(versionsDir).pipe(Effect.orElseSucceed(() => []));
  // An interrupted prune has already renamed its runtime out of the way.
  const pruned = new Set(
    entries
      .filter((entry) => entry.startsWith(PINNED_RUNTIME_PRUNED_PREFIX))
      .map((entry) => path.join(versionsDir, entry)),
  );

  const settledBefore =
    (yield* Clock.currentTimeMillis) - Duration.toMillis(PINNED_RUNTIME_PRUNE_GRACE);
  const completed: Array<string> = [];
  for (const version of entries) {
    if (!isExactServiceVersion(version)) continue;
    const versionDir = path.join(versionsDir, version);
    const sentinelPath = path.join(versionDir, ".install-complete");
    const isLink = yield* fs.readLink(versionDir).pipe(Effect.isSuccess);
    const sentinel = yield* fs.readFileString(sentinelPath).pipe(Effect.option);
    const completedAt = yield* fs.stat(sentinelPath).pipe(
      Effect.map((info) => Option.getOrUndefined(info.mtime)?.getTime()),
      Effect.orElseSucceed(() => undefined),
    );
    if (
      !isLink &&
      Option.isSome(sentinel) &&
      sentinel.value.trim() === version &&
      completedAt !== undefined &&
      completedAt < settledBefore
    ) {
      completed.push(version);
    }
  }
  if (completed.length === 0) return pruned;

  const keep = new Set(input.keep);
  const stateText = yield* fs
    .readFileString(path.join(input.baseDir, PINNED_RUNTIME_DIR, SERVICE_STATE_FILE))
    .pipe(
      Effect.asSome,
      Effect.catch((error) =>
        Effect.succeed(error.reason._tag === "NotFound" ? Option.none<string>() : undefined),
      ),
    );
  // State this version cannot read may reference runtimes in ways it does not know.
  if (stateText === undefined) return pruned;
  if (Option.isSome(stateText)) {
    const state = parseServiceState(stateText.value);
    if (state === undefined) return pruned;
    keep.add(state.activeVersion);
    if (state.update !== undefined) {
      keep.add(state.update.fromVersion);
      keep.add(state.update.targetVersion);
    }
  }
  const executables = yield* runningExecutables();
  // Without a process list, a runtime in use would look unused.
  if (Option.isNone(executables)) return pruned;
  const platform = yield* HostProcess.Platform;
  // Windows paths are case-insensitive, and shims and process lists need not agree on case.
  const foldCase = (value: string) => (platform === "win32" ? value.toLowerCase() : value);
  const references = [
    executables.value,
    ...(yield* shellLauncherTargets(input.baseDir)),
    ...input.references,
  ].map(foldCase);
  // Process executables are resolved, so they name the real path of a symlinked T3 home.
  const realVersionsDir = yield* fs
    .realPath(versionsDir)
    .pipe(Effect.orElseSucceed(() => versionsDir));

  for (const version of completed) {
    const versionDir = path.join(versionsDir, version);
    const prefixes = [versionDir, path.join(realVersionsDir, version)].map((dir) =>
      foldCase(dir + path.sep),
    );
    if (
      keep.has(version) ||
      references.some((reference) => prefixes.some((prefix) => reference.includes(prefix)))
    ) {
      continue;
    }
    const target = path.join(versionsDir, `${PINNED_RUNTIME_PRUNED_PREFIX}${version}`);
    // Renaming first means an interrupted removal never leaves a partial tree that still carries
    // its sentinel and would pass for a complete install.
    yield* fs.remove(target, { recursive: true, force: true }).pipe(
      Effect.andThen(fs.rename(versionDir, target)),
      Effect.andThen(Effect.sync(() => pruned.add(target))),
      Effect.catch((cause) =>
        Effect.logWarning("Could not remove an unused t3 runtime.", { version, cause }),
      ),
    );
  }
  return pruned;
});

/**
 * Keep runtimes named by callers, service state, running processes, launchers, or references,
 * and anything published within an hour. Only prune completed runtimes; leave staging
 * directories, symlinks, and unexpected entries untouched.
 */
export const prunePinnedRuntimes = Effect.fn("cloud.pinned_runtime.prune")(function* (input: {
  readonly baseDir: string;
  readonly keep: ReadonlyArray<string>;
  readonly references?: ReadonlyArray<string>;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  // Only selection and the renames race an install; deleting renamed trees can take a while.
  const pruned = yield* pinnedRuntimeInstallLock.withPermit(
    selectUnusedRuntimes({ ...input, references: input.references ?? [] }),
  );
  const removed: Array<string> = [];
  for (const target of pruned) {
    yield* fs.remove(target, { recursive: true, force: true }).pipe(
      Effect.andThen(
        Effect.sync(() =>
          removed.push(path.basename(target).slice(PINNED_RUNTIME_PRUNED_PREFIX.length)),
        ),
      ),
      Effect.catch((cause) =>
        Effect.logWarning("Could not remove an unused t3 runtime.", { target, cause }),
      ),
    );
  }
  return removed;
});
