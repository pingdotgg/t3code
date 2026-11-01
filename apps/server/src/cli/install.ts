import * as HostProcess from "@t3tools/shared/HostProcess";
import { replaceOwnedLink } from "@t3tools/shared/ownedLink";
import { pathSetupCommand } from "@t3tools/shared/shell";
import * as Console from "effect/Console";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Command, Prompt } from "effect/cli";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import packageJson from "../../package.json" with { type: "json" };
import {
  directLinkTargets,
  generatedWindowsShimTarget,
  isVersionExecutable,
  pinnedRuntimeCommandLink,
  pinnedRuntimeVersionsDir,
} from "../cloud/pinnedRuntime.ts";
import { detectCliRunner, resolveCliCommand, resolveEntryPath } from "./invocation.ts";

export class CliInstallError extends Schema.TaggedError<CliInstallError>()("CliInstallError", {
  reason: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return this.reason;
  }
}

/** `<T3 home>/runtime/versions/<version>/t3`: the layout the install scripts and npm launcher share. */
const standaloneRuntime = Effect.gen(function* () {
  const path = yield* Path.Path;
  if (!(yield* HostProcess.IsExecutable)) return Option.none();
  const executable = yield* HostProcess.ExecutablePath;
  const versionsDir = path.dirname(path.dirname(executable));
  const runtimeDir = path.dirname(versionsDir);
  if (path.basename(versionsDir) !== "versions" || path.basename(runtimeDir) !== "runtime") {
    return Option.none();
  }
  return Option.some({ executable, versionsDir, runtimeDir });
});

/**
 * What `link` is to this T3 home: missing, its command link, an older link of this home (straight
 * to a version's t3, or the desktop app's launcher), or another program's.
 */
const classifyCommandLink = Effect.fn("cli.install.classify_command_link")(function* (
  link: string,
  baseDir: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  // A link through a symlinked T3 home names the alias, so compare real folders as well.
  const real = (file: string) =>
    fs.realPath(path.dirname(file)).pipe(
      Effect.map((directory) => path.join(directory, path.basename(file))),
      Effect.orElseSucceed(() => file),
    );
  const commandLink = pinnedRuntimeCommandLink(path, baseDir);
  const realCommandLink = yield* real(commandLink);
  if ((yield* real(link)) === realCommandLink) return "current";
  // Only the direct target: a chain through another tool's link is that tool's.
  const targets = yield* directLinkTargets(link);
  if (targets.length === 0 && Option.isNone(yield* fs.readLink(link).pipe(Effect.option))) {
    return (yield* fs.exists(link).pipe(Effect.orElseSucceed(() => true))) ? "foreign" : "missing";
  }
  if (targets.includes(commandLink) || targets.includes(realCommandLink)) return "current";
  const versionsDir = pinnedRuntimeVersionsDir(path, baseDir);
  const realVersionsDir = yield* fs
    .realPath(versionsDir)
    .pipe(Effect.orElseSucceed(() => versionsDir));
  const desktopLauncher = path.join(baseDir, "bin", "t3");
  const realDesktopLauncher = yield* real(desktopLauncher);
  const older = targets.some(
    (candidate) =>
      isVersionExecutable(path, versionsDir, candidate) ||
      isVersionExecutable(path, realVersionsDir, candidate) ||
      candidate === desktopLauncher ||
      candidate === realDesktopLauncher,
  );
  return older ? "older" : "foreign";
});

/**
 * Points this home's command link at `executable`, then makes `link` lead to it. `link` is only
 * created where nothing is, or moved over from an older link of this home. Returns false when it
 * belongs to another program; nothing changes then.
 */
export const linkCommand = Effect.fn("cli.install.link_command")(function* (input: {
  readonly link: string;
  readonly baseDir: string;
  readonly executable: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const kind = yield* classifyCommandLink(input.link, input.baseDir);
  if (kind === "foreign") return false;
  const commandLink = pinnedRuntimeCommandLink(path, input.baseDir);
  // Inside the T3 home, so swapping it in place cannot replace another program's file. Still,
  // only a link is ever replaced there.
  if (
    Option.isNone(yield* fs.readLink(commandLink).pipe(Effect.option)) &&
    (yield* fs.exists(commandLink))
  ) {
    return yield* new CliInstallError({
      reason: `${commandLink} is not a link. Remove it, then run this again.`,
    });
  }
  const staging = `${commandLink}.${process.pid}.tmp`;
  yield* fs
    .remove(staging, { force: true })
    .pipe(
      Effect.andThen(fs.symlink(input.executable, staging)),
      Effect.andThen(
        fs
          .rename(staging, commandLink)
          .pipe(Effect.tapError(() => fs.remove(staging, { force: true }).pipe(Effect.ignore))),
      ),
    );
  if (kind === "missing") yield* fs.symlink(commandLink, input.link);
  if (kind !== "older") return true;
  return yield* replaceOwnedLink({
    link: input.link,
    target: commandLink,
    owns: (candidate) =>
      classifyCommandLink(candidate, input.baseDir).pipe(
        Effect.map((found) => found !== "foreign"),
      ),
  });
});

/** Links this runtime as the `t3` command the way the install scripts do, never over another t3. */
export const installCli = Effect.fn("cli.install.install")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcess.Platform;
  const environment = yield* HostProcess.Environment;
  const home = yield* HostProcess.HomeDirectory;
  const runtime = yield* standaloneRuntime;
  const windows = platform === "win32";
  if (Option.isNone(runtime)) {
    const script = windows
      ? "irm https://t3.codes/install.ps1 | iex"
      : "curl -fsSL https://t3.codes/install.sh | sh";
    return yield* new CliInstallError({
      reason: `Only the standalone t3 can install itself. Use \`${script}\`, or Settings in the desktop app.`,
    });
  }
  const { executable, versionsDir, runtimeDir } = runtime.value;
  // cmd.exe expands `%` and reads the shim in the OEM code page, so such a path would not run.
  if (windows && /[%\u0080-\uffff]/.test(executable)) {
    return yield* new CliInstallError({
      reason: `A t3.cmd cannot run ${executable}, because the path has % or non-ASCII characters. Keep using npx t3.`,
    });
  }
  // Absolute, so the PATH hint never adds a folder that changes with the working directory.
  const binDir = path.resolve(
    environment.T3CODE_INSTALL_BIN_DIR?.trim() || path.join(home, ".local", "bin"),
  );
  const name = windows ? "t3.cmd" : "t3";
  const link = path.join(binDir, name);
  const failed = (reason: string) => (cause: unknown) => new CliInstallError({ reason, cause });

  if (windows) {
    // Resolve fully so a shim through a symlinked T3 home still counts as ours.
    const realVersionsDir = yield* fs
      .realPath(versionsDir)
      .pipe(Effect.orElseSucceed(() => versionsDir));
    const current = yield* fs
      .readFileString(link)
      .pipe(Effect.map(generatedWindowsShimTarget), Effect.option);
    // A dangling symlink is occupied too: writing the shim would follow it.
    const occupied =
      Option.isSome(current) ||
      (yield* fs.exists(link)) ||
      Option.isSome(yield* fs.readLink(link).pipe(Effect.option));
    if (
      occupied &&
      !(
        Option.isSome(current) &&
        current.value !== undefined &&
        (isVersionExecutable(path, versionsDir, current.value) ||
          isVersionExecutable(path, realVersionsDir, current.value) ||
          // This home's desktop launcher, which install.sh also replaces.
          current.value === path.join(path.dirname(runtimeDir), "bin", name))
      )
    ) {
      return yield* new CliInstallError({
        reason: `Another t3 is already at ${link}. Remove it, then run this again.`,
      });
    }
    yield* fs
      .makeDirectory(binDir, { recursive: true })
      .pipe(Effect.mapError(failed(`Could not create ${binDir}.`)));
    // An empty spot is created exclusively, so a file that appears after the check above is kept.
    yield* fs
      .writeFileString(link, `@echo off\r\n"${executable}" %*`, occupied ? {} : { flag: "wx" })
      .pipe(Effect.mapError(failed(`Could not write ${link}.`)));
  } else {
    yield* fs
      .makeDirectory(binDir, { recursive: true })
      .pipe(Effect.mapError(failed(`Could not create ${binDir}.`)));
    // The command link is replaced in place, which is safe only away from the public name.
    const real = (directory: string) =>
      fs.realPath(directory).pipe(Effect.orElseSucceed(() => directory));
    if ((yield* real(binDir)) === (yield* real(runtimeDir))) {
      return yield* new CliInstallError({
        reason: `T3CODE_INSTALL_BIN_DIR cannot be ${runtimeDir}. Choose another folder.`,
      });
    }
    const linked = yield* linkCommand({ link, baseDir: path.dirname(runtimeDir), executable }).pipe(
      Effect.catchTags({
        PlatformError: (cause) =>
          Effect.fail(new CliInstallError({ reason: `Could not link ${link}.`, cause })),
      }),
    );
    if (!linked) {
      return yield* new CliInstallError({
        reason: `Another t3 is already at ${link}. Remove it, then run this again.`,
      });
    }
  }

  // Pruning keeps what recorded launchers point at; a background service cannot see binDir otherwise.
  const recorded = path.join(
    yield* fs.realPath(binDir).pipe(Effect.orElseSucceed(() => binDir)),
    name,
  );
  const launchersFile = path.join(runtimeDir, "launchers");
  const launchers = yield* fs.readFileString(launchersFile).pipe(Effect.orElseSucceed(() => ""));
  if (!launchers.split(/\r?\n/).includes(recorded)) {
    yield* fs
      .writeFileString(launchersFile, `${recorded}\n`, { flag: "a" })
      .pipe(
        Effect.catch(() =>
          Console.error(
            `Warning: could not record ${recorded} in ${launchersFile}. Cleanup may remove the version it runs.`,
          ),
        ),
      );
  }

  // resolve() drops trailing separators, so `~/.local/bin/` on PATH still matches.
  const normalize = (value: string) =>
    windows ? path.resolve(value).toLowerCase() : path.resolve(value);
  const same = (entry: string) => entry !== "" && normalize(entry) === normalize(binDir);
  const entries = (environment.PATH ?? environment.Path ?? "").split(windows ? ";" : ":");
  const onPath = entries.some(same);
  // A t3 earlier on PATH runs instead, and an added folder goes last. Runner caches (npx's own
  // .bin) are not installs.
  const firstOther = Effect.gen(function* () {
    for (const entry of entries) {
      if (same(entry)) return undefined;
      if (!path.isAbsolute(entry) || detectCliRunner(`${entry}/`) !== null) continue;
      for (const name of windows ? ["t3.cmd", "t3.exe"] : ["t3"]) {
        const candidate = path.join(entry, name);
        if (yield* fs.exists(candidate).pipe(Effect.orElseSucceed(() => false))) return candidate;
      }
    }
    return undefined;
  });
  const shadowedBy = yield* firstOther;
  return {
    link,
    onPath: onPath && shadowedBy === undefined,
    shadowedBy,
    pathCommand:
      onPath || shadowedBy !== undefined
        ? undefined
        : pathSetupCommand({
            directory: binDir,
            home,
            shell: environment.SHELL,
            platform,
            configHome: environment.XDG_CONFIG_HOME,
            zdotdir: environment.ZDOTDIR,
          }),
    binDir,
  };
});

const reportInstalled = Effect.fn("cli.install.report")(function* (
  installed: Effect.Success<ReturnType<typeof installCli>>,
) {
  yield* Console.log(`Installed t3 ${packageJson.version} at ${installed.link}.`);
  if (installed.shadowedBy !== undefined) {
    return yield* Console.log(
      `Another t3 at ${installed.shadowedBy} runs first, so run ${installed.link} to use this one.`,
    );
  }
  if (installed.onPath) return yield* Console.log("Run `t3` to get started.");
  if (installed.pathCommand === undefined) {
    return yield* Console.log(`Add ${installed.binDir} to your PATH, then run \`t3\`.`);
  }
  yield* Console.log(`${installed.binDir} is not on your PATH yet. Add it with:`);
  yield* Console.log(`  ${installed.pathCommand}`);
  yield* Console.log("Then open a new terminal and run `t3`.");
});

export const installCommand = Command.make("install").pipe(
  Command.withDescription("Install this version as the `t3` command."),
  Command.withHandler(() => installCli().pipe(Effect.flatMap(reportInstalled))),
);

/** Saying no lasts until the next minor release: `0.2` covers `0.2.5` and `0.2.6-nightly.…`. */
const minorRelease = (version: string) => version.split(".").slice(0, 2).join(".");

const SKIPPED_ARGUMENTS = new Set([
  "help",
  "--help",
  "-h",
  "--version",
  "-v",
  // Scripts and machine-readable output; a prompt would stall them or corrupt their output.
  "--json",
  "--yes",
  "-y",
]);

/** The subcommand, past global flags that may come first (two take a value). */
const topLevelCommand = (args: ReadonlyArray<string>) => {
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "--log-level" || arg === "--completions") index++;
    else if (!arg.startsWith("-")) return arg;
  }
  return undefined;
};

/** Agents can run commands in a terminal that nobody answers; no answer counts as no. */
const PROMPT_TIMEOUT = Duration.seconds(30);

/** `/proc/<pid>/stat` fields after the parenthesized command name: state ppid pgrp session tty_nr tpgid. */
export const isForegroundProcStat = (stat: string) => {
  const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  return fields[2] !== undefined && fields[2] !== "" && fields[2] === fields[5];
};

/** Output of `ps -o tpgid=,pgid=`; tpgid is -1 without a controlling terminal. */
export const isForegroundPs = (output: string) => {
  const [tpgid, pgid] = output.trim().split(/\s+/);
  return tpgid !== undefined && tpgid !== "" && tpgid === pgid;
};

/**
 * A background job (`npx t3 serve &`) that reads the terminal is stopped by the shell, so only
 * the terminal's foreground process group may prompt. Unknown counts as background.
 */
export const inTerminalForeground = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const platform = yield* HostProcess.Platform;
  if (platform === "win32") return true;
  if (platform === "linux") {
    return isForegroundProcStat(
      yield* fs.readFileString("/proc/self/stat").pipe(Effect.orElseSucceed(() => "")),
    );
  }
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return isForegroundPs(
    yield* spawner
      .string(
        // Absolute: under npx, PATH starts with a project's node_modules/.bin.
        ChildProcess.make("/bin/ps", ["-o", "tpgid=,pgid=", "-p", String(process.pid)], {
          stdin: "ignore",
          stderr: "ignore",
        }),
      )
      .pipe(Effect.orElseSucceed(() => "")),
  );
});

/**
 * Before a command run through npx, pnpm dlx, or bunx at a terminal, asks to install the `t3`
 * command. Yes is the default. No, no answer, or a failed install is saved in the T3 home until
 * the next minor release. Returns false when the user quits the prompt, so the command does not run.
 */
export const offerCliInstall = Effect.fn("cli.install.offer")(function* <E, R, E2, R2>(input: {
  readonly args: ReadonlyArray<string>;
  readonly interactive: boolean;
  readonly foreground: Effect.Effect<boolean, E2, R2>;
  /** Undefined when the user quits the prompt. */
  readonly confirm: Effect.Effect<boolean | void, E, R>;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcess.Platform;
  const environment = yield* HostProcess.Environment;
  if (!input.interactive || environment.CI || environment.SUDO_USER) return true;
  if (environment.TERM === "dumb") return true;
  // `--json=true` and `-y=true` are the same flags.
  if (input.args.some((arg) => SKIPPED_ARGUMENTS.has(arg.split("=")[0]!))) return true;
  const command = topLevelCommand(input.args);
  if (command === "install" || command === "uninstall") return true;
  if (detectCliRunner(yield* resolveEntryPath) === null) return true;
  const runtime = yield* standaloneRuntime;
  if (Option.isNone(runtime)) return true;
  const { runtimeDir } = runtime.value;

  // Any t3 already installed means no prompt: ours (even when off PATH) or another on PATH.
  // Runners put their own cache's node_modules/.bin on PATH, so skip those.
  const windows = platform === "win32";
  const names = windows ? ["t3.cmd", "t3.exe"] : ["t3"];
  const launchers = yield* fs
    .readFileString(path.join(runtimeDir, "launchers"))
    .pipe(Effect.orElseSucceed(() => ""));
  const candidates = [
    ...launchers.split(/\r?\n/).filter(Boolean),
    path.join(path.dirname(runtimeDir), "bin", windows ? "t3.cmd" : "t3"),
    ...(environment.PATH ?? environment.Path ?? "")
      .split(windows ? ";" : ":")
      .filter(
        (directory) => path.isAbsolute(directory) && detectCliRunner(`${directory}/`) === null,
      )
      .flatMap((directory) => names.map((name) => path.join(directory, name))),
  ];
  for (const candidate of candidates) {
    if (yield* fs.exists(candidate).pipe(Effect.orElseSucceed(() => false))) return true;
  }

  const declinedFile = path.join(runtimeDir, "install-prompt-declined");
  const declined = yield* fs.readFileString(declinedFile).pipe(Effect.orElseSucceed(() => ""));
  const minor = minorRelease(packageJson.version);
  if (declined.trim() === minor) return true;
  if (!(yield* input.foreground)) return true;

  const installHint = `Run \`${yield* resolveCliCommand("install")}\` any time.`;
  const saveDecline = fs.writeFileString(declinedFile, `${minor}\n`).pipe(Effect.ignore);
  const answer = yield* input.confirm.pipe(Effect.timeoutOption(PROMPT_TIMEOUT));
  if (Option.isNone(answer)) {
    yield* saveDecline;
    yield* Console.log(`\nNo answer, so t3 was not installed. ${installHint}\n`);
    return true;
  }
  if (answer.value === undefined) return false;
  if (!answer.value) {
    yield* saveDecline;
    yield* Console.log(`Skipped. ${installHint}\n`);
    return true;
  }
  yield* installCli().pipe(
    Effect.flatMap(reportInstalled),
    Effect.catch((error) =>
      Effect.andThen(saveDecline, Console.error(`Could not install t3: ${error.message}`)),
    ),
  );
  yield* Console.log("");
  return true;
});

export const confirmCliInstall = Prompt.run(
  Prompt.Confirm({
    message: "Install the t3 command? Then you can run `t3` directly.",
    initial: true,
  }),
).pipe(Effect.catchTags({ QuitError: () => Effect.void }));
