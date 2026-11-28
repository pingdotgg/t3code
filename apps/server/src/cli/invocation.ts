import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import type { ServerInstallation } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveCommandPath } from "@t3tools/shared/shell";

import packageJson from "../../package.json" with { type: "json" };
import {
  findPosixLauncher,
  readPosixLauncherTarget,
  resolveLauncherPath,
} from "../cloud/pinnedRuntime.ts";

const PINNED_RUNTIME_ENTRY = /^(.*)\/runtime\/versions\/[^/]+\/t3$/;

export type CliRunner = "npx" | "pnpm dlx" | "bunx";

/** Detection is best-effort; callers must fail closed to a plain `hyakki` command. */
export function detectCliRunner(entryPath: string): CliRunner | null {
  const path = entryPath.replaceAll("\\", "/");
  if (path.includes("/_npx/")) {
    return "npx";
  }
  if (
    path.includes("/pnpm/dlx/") ||
    path.includes("/.pnpm/dlx/") ||
    path.includes("/pnpm-cache/dlx/")
  ) {
    return "pnpm dlx";
  }
  if (path.includes("/.bun/install/cache/") || path.includes("/bunx-")) {
    return "bunx";
  }
  return null;
}

const InstallManifest = Schema.Struct({
  name: Schema.String,
  version: Schema.String,
  bin: Schema.optionalKey(Schema.Struct({ t3: Schema.String })),
});
const decodeInstallManifest = Schema.decodeUnknownEffect(Schema.fromJsonString(InstallManifest));

/**
 * `HYAKKI_NPM_LAUNCHER_PATH` is inherited by child shells, so accept it only for this package
 * version to avoid claiming another `hyakki` invocation is the npm install.
 */
export const resolveEntryPath = Effect.gen(function* () {
  const npmLauncher = (yield* HostProcess.Environment).HYAKKI_NPM_LAUNCHER_PATH?.trim();
  if (npmLauncher) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const manifest = yield* fs
      .readFileString(path.join(path.dirname(npmLauncher), "../package.json"))
      .pipe(Effect.flatMap(decodeInstallManifest), Effect.option);
    if (
      Option.isSome(manifest) &&
      manifest.value.name === "t3" &&
      manifest.value.version === packageJson.version
    ) {
      return npmLauncher;
    }
  }
  if (yield* HostProcess.IsExecutable) return yield* HostProcess.ExecutablePath;
  return (yield* HostProcess.Arguments)[1] ?? "";
});

export const resolveServerInstallation = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcess.Platform;
  const entry = yield* fs.realPath(yield* resolveEntryPath);
  const runtime = PINNED_RUNTIME_ENTRY.exec(entry);
  if (runtime) {
    const launchedAs = yield* resolveLauncherPath;
    if (launchedAs === undefined) return null;
    const link = yield* fs.readLink(launchedAs).pipe(Effect.option);
    // A launcher script execs the runtime itself, so look for the script that runs it.
    const launcher = Option.isSome(link)
      ? launchedAs
      : yield* findPosixLauncher({
          launchedAs,
          versionsDir: path.join(runtime[1] || "/", "runtime/versions"),
        });
    // None for a runtime started directly, as SSH launches do, or through a copy.
    if (launcher === undefined) return null;
    const target = Option.isSome(link)
      ? path.resolve(path.dirname(launcher), link.value)
      : yield* readPosixLauncherTarget(launcher);
    // Keep the home as the launcher spells it; `hyakki update` only repoints launchers into that spelling.
    const linked = target === undefined ? null : PINNED_RUNTIME_ENTRY.exec(target);
    if (!linked || (yield* fs.realPath(linked[1] || "/")) !== (runtime[1] || "/")) return null;
    return {
      kind: "t3-launcher",
      launcher,
      baseDir: linked[1] || "/",
    } satisfies ServerInstallation;
  }
  const match = /^(.*)\/lib\/node_modules\/t3\/(?:dist\/bin\.mjs|bin\/t3\.mjs)$/.exec(entry);
  if (!match) {
    const runner = detectCliRunner(entry);
    return runner === null
      ? null
      : ({ kind: runner === "pnpm dlx" ? "pnpm-dlx" : runner } satisfies ServerInstallation);
  }
  if (platform === "win32") return null;
  const prefix = match[1] || "/";
  if (
    prefix.includes("/node_modules/") ||
    /\/(?:Cellar|Caskroom)\//i.test(prefix) ||
    /\/mise\/installs\/(?!node\/)[^/]+\//.test(prefix)
  )
    return null;

  const packageRoot = path.join(prefix, "lib/node_modules/t3");
  const manifest = yield* fs
    .readFileString(path.join(packageRoot, "package.json"))
    .pipe(Effect.flatMap(decodeInstallManifest));
  if (manifest.name !== "t3" || !manifest.bin) return null;
  const bin = yield* fs.realPath(path.join(packageRoot, manifest.bin.t3));
  const globalBin = yield* fs.realPath(path.join(prefix, "bin/t3"));
  if (globalBin !== bin || bin !== entry) return null;
  return { kind: "npm-global", prefix } satisfies ServerInstallation;
}).pipe(Effect.orElseSucceed(() => null));

export const resolveCliCommand = (subcommand: string) => Effect.succeed(`hyakki ${subcommand}`);

const shellWord = (value: string) =>
  /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", `'"'"'`)}'`;

/** PowerShell also treats typographic quotes as delimiters; escape them and suppress expansion. */
const powershellWord = (value: string) =>
  `"${value
    .replaceAll("`", "``")
    .replaceAll("$", "`$")
    .replace(/["\u201C\u201D\u201E]/g, "$&$&")}"`;

export const hostShellWord = (platform: NodeJS.Platform, value: string) =>
  platform === "win32" ? powershellWord(value) : shellWord(value);

/** Script installs have no single launcher; desktop shims and standalone binaries do. */
const resolveInstallLauncher = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const shim = (yield* HostProcess.Environment).HYAKKI_CLI_PATH?.trim();
  if (shim && (yield* fs.exists(shim).pipe(Effect.orElseSucceed(() => false)))) {
    return Option.some(shim);
  }
  return (yield* HostProcess.IsExecutable)
    ? Option.some(yield* HostProcess.ExecutablePath)
    : Option.none<string>();
});

/**
 * Uses this install's `hyakki` on PATH, the originating runner, or its absolute launcher path.
 * Arguments are quoted for POSIX shells or PowerShell on Windows.
 */
export const resolveHostCliCommand = Effect.fn("invocation.resolveHostCliCommand")(function* (
  subcommand: string,
  args: ReadonlyArray<string> = [],
) {
  const platform = yield* HostProcess.Platform;
  const withArgs = (prefix: string) =>
    // An empty subcommand names the root `hyakki` command.
    [prefix.trimEnd(), ...args.map((arg) => hostShellWord(platform, arg))].join(" ");
  const command = yield* resolveCliCommand(subcommand);
  if (command !== `hyakki ${subcommand}`) return { command: withArgs(command), launcher: false };
  const onPath = yield* resolveCommandPath("hyakki");
  if (onPath !== null) {
    const shim = (yield* HostProcess.Environment).HYAKKI_CLI_PATH?.trim();
    const fs = yield* FileSystem.FileSystem;
    const real = (file: string) => fs.realPath(file).pipe(Effect.orElseSucceed(() => null));
    // Windows `t3.cmd` shims are text files that never realpath to the executable they run.
    const own = shim
      ? yield* real(shim)
      : platform !== "win32" && (yield* HostProcess.IsExecutable)
        ? yield* resolveEntryPath.pipe(
            Effect.flatMap((entry) =>
              real(entry).pipe(Effect.map((resolved) => resolved ?? entry)),
            ),
          )
        : null;
    if (own === null || own === (yield* real(onPath))) {
      const path = yield* Path.Path;
      const searchPath = (yield* HostProcess.Environment).PATH ?? "";
      // With an empty or relative PATH entry, plain `hyakki` depends on the directory it runs from.
      const cwdDependent =
        platform !== "win32" &&
        searchPath.length > 0 &&
        searchPath.split(":").some((entry) => !path.isAbsolute(entry));
      if (!cwdDependent) return { command: withArgs(command), launcher: false };
      const quoted = hostShellWord(platform, path.resolve(onPath));
      return { command: withArgs(`${quoted} ${subcommand}`), launcher: false };
    }
  }
  const launcher = yield* resolveInstallLauncher;
  if (Option.isNone(launcher)) return { command: withArgs(command), launcher: false };
  // PowerShell runs a quoted path only through the call operator.
  const quoted = hostShellWord(platform, launcher.value);
  const call = platform === "win32" ? `& ${quoted}` : quoted;
  return { command: withArgs(`${call} ${subcommand}`), launcher: true };
});

/** A hint's command, run against the caller's `--base-dir` when one was given. */
export const resolveHostCliHint = (
  subcommand: string,
  baseDir: Option.Option<string>,
  args: ReadonlyArray<string> = [],
) =>
  resolveHostCliCommand(subcommand, [
    ...Option.match(baseDir, { onNone: () => [], onSome: (dir) => ["--base-dir", dir] }),
    ...args,
  ]).pipe(Effect.map(({ command }) => command));

/**
 * `sudo` resets PATH on most distributions, which drops a user-installed Node
 * (nvm, fnm, a tarball) and with it `npx` or a global `hyakki`, so the command
 * carries PATH through unless Node is on root's PATH too. An absolute launcher
 * needs neither.
 */
export const resolveRootCliCommand = Effect.fn("invocation.resolveRootCliCommand")(function* (
  subcommand: string,
  args: ReadonlyArray<string> = [],
) {
  const { command, launcher } = yield* resolveHostCliCommand(subcommand, args);
  if (launcher) return `sudo ${command}`;
  const executablePath = yield* HostProcess.ExecutablePath;
  const systemNode = ROOT_PATH_DIRECTORIES.some((directory) =>
    executablePath.startsWith(`${directory}/`),
  );
  return systemNode ? `sudo ${command}` : `sudo env "PATH=$PATH" ${command}`;
});

const ROOT_PATH_DIRECTORIES = [
  "/usr/local/sbin",
  "/usr/local/bin",
  "/usr/sbin",
  "/usr/bin",
  "/sbin",
  "/bin",
];
