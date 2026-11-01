import * as HostProcess from "@t3tools/shared/HostProcess";
import { DESKTOP_CLI_LAUNCHER_MARKER } from "@t3tools/shared/desktopCliLauncher";
import { replaceOwnedLink } from "@t3tools/shared/ownedLink";
import { pathSetupCommand } from "@t3tools/shared/shell";
import * as Console from "effect/Console";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Random from "effect/Random";
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
import { resolveBaseDir } from "../os-jank.ts";
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
  // The command link itself, through any alias of its folder. A bind mount shows the same folder
  // under another real path, where it may be a shared bin folder, so it is refused.
  const folderId = (file: string) =>
    fs.stat(path.dirname(file)).pipe(
      Effect.map((info) => Option.map(info.ino, (ino) => `${info.dev}:${ino}`)),
      Effect.orElseSucceed(() => Option.none<string>()),
    );
  const linkFolder = yield* folderId(link);
  if (
    path.basename(link) === path.basename(commandLink) &&
    Option.isSome(linkFolder) &&
    Option.getOrUndefined(yield* folderId(commandLink)) === linkFolder.value
  ) {
    return (yield* real(link)) === realCommandLink ? "current" : "foreign";
  }
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
  // The desktop app's launcher carries its marker; a linked bin folder could hold a user's own t3.
  const isDesktopLauncher = Effect.fn("cli.install.is_desktop_launcher")(
    function* (file: string) {
      // The app writes a file; a link there leads to another home's or another tool's t3.
      if (Option.isSome(yield* fs.readLink(file).pipe(Effect.option))) return false;
      const info = yield* fs.stat(file);
      if (info.type !== "File" || Number(info.size) > 16_384) return false;
      return (yield* fs.readFileString(file)).includes(DESKTOP_CLI_LAUNCHER_MARKER);
    },
    Effect.orElseSucceed(() => false),
  );
  // The desktop app writes this exact path, also when the home's bin folder is a link.
  const text = yield* fs.readLink(link).pipe(Effect.option);
  if (
    Option.isSome(text) &&
    path.isAbsolute(text.value) &&
    !text.value.split(/[\\/]/).includes("..") &&
    !/[\\/]\.?$/.test(text.value) &&
    path.normalize(text.value) === desktopLauncher &&
    (yield* isDesktopLauncher(desktopLauncher))
  ) {
    return "older";
  }
  if (
    targets.some(
      (candidate) =>
        isVersionExecutable(path, versionsDir, candidate) ||
        isVersionExecutable(path, realVersionsDir, candidate),
    )
  ) {
    return "older";
  }
  for (const candidate of targets) {
    if (
      (candidate === desktopLauncher || candidate === realDesktopLauncher) &&
      (yield* isDesktopLauncher(candidate))
    ) {
      return "older";
    }
  }
  return "foreign";
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
  // only a link in a real folder is ever replaced there.
  const folder = path.dirname(commandLink);
  if (Option.isSome(yield* fs.readLink(folder).pipe(Effect.option))) {
    return yield* new CliInstallError({
      reason: `${folder} is a link, not a folder. Remove it, then run this again.`,
    });
  }
  yield* fs.makeDirectory(folder, { recursive: true });
  if (
    Option.isNone(yield* fs.readLink(commandLink).pipe(Effect.option)) &&
    (yield* fs.exists(commandLink))
  ) {
    return yield* new CliInstallError({
      reason: `${commandLink} is not a link. Remove it, then run this again.`,
    });
  }
  // Created exclusively and removed only once it is this call's own.
  const switchCommandLink = Effect.gen(function* () {
    const staging = `${commandLink}.${process.pid}.${yield* Random.nextIntBetween(0, 0x7fffffff)}.tmp`;
    yield* fs.symlink(input.executable, staging);
    yield* fs
      .rename(staging, commandLink)
      .pipe(Effect.tapError(() => fs.remove(staging, { force: true }).pipe(Effect.ignore)));
  });
  // The home's command switches first: if `link` then fails, the home runs the version asked for
  // and only `link` is missing, never a third version.
  yield* switchCommandLink;
  if (kind === "missing") {
    // A concurrent install may have made the same link a moment ago.
    yield* fs
      .symlink(commandLink, input.link)
      .pipe(
        Effect.catch((error) =>
          classifyCommandLink(input.link, input.baseDir).pipe(
            Effect.flatMap((found) => (found === "current" ? Effect.void : Effect.fail(error))),
          ),
        ),
      );
  }
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
    // The command link is replaced in place, which is safe only away from the public name. Same
    // device and inode, so an alias or a bind mount of its folder counts too.
    // Spelled as the T3 home this t3 is set up with, which every t3 compares links against; the
    // executable's own path names a symlinked home by its real path.
    const configured = yield* resolveBaseDir(environment.T3CODE_HOME);
    const realHome = (directory: string) =>
      fs.realPath(directory).pipe(Effect.orElseSucceed(() => directory));
    const baseDir =
      (yield* realHome(configured)) === (yield* realHome(path.dirname(runtimeDir)))
        ? configured
        : path.dirname(runtimeDir);
    const spelled = path.join(baseDir, path.relative(path.dirname(runtimeDir), executable));
    const commandFolder = path.dirname(pinnedRuntimeCommandLink(path, baseDir));
    const folderId = (directory: string) =>
      fs.stat(directory).pipe(
        Effect.map((info) => Option.map(info.ino, (ino) => `${info.dev}:${ino}`)),
        Effect.orElseSucceed(() => Option.none<string>()),
      );
    const binId = yield* folderId(binDir);
    if (
      path.resolve(binDir) === commandFolder ||
      (Option.isSome(binId) &&
        Option.getOrUndefined(yield* folderId(commandFolder)) === binId.value)
    ) {
      return yield* new CliInstallError({
        reason: `T3CODE_INSTALL_BIN_DIR cannot be ${commandFolder}. Choose another folder.`,
      });
    }
    // Checked before the home's command switches, so a bin folder that cannot be written changes
    // nothing.
    if (!(yield* fs.access(binDir, { writable: true }).pipe(Effect.isSuccess))) {
      return yield* new CliInstallError({ reason: `Cannot write to ${binDir}.` });
    }
    const linked = yield* linkCommand({ link, baseDir, executable: spelled }).pipe(
      Effect.catchTags({
        PlatformError: (cause) =>
          Effect.fail(new CliInstallError({ reason: `Could not link ${link}.`, cause })),
        OwnedLinkError: (cause) =>
          Effect.fail(
            new CliInstallError({ reason: `Could not link ${link}. ${cause.message}`, cause }),
          ),
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
