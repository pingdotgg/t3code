import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import type { ServerInstallation } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { isCommandAvailable } from "@t3tools/shared/shell";

import packageJson from "../../package.json" with { type: "json" };

export type CliRunner = "npx" | "pnpm dlx" | "bunx";

/**
 * How the CLI was launched, judged by where its entry script lives. Each
 * package runner executes out of a distinctive cache/temp layout:
 *
 *   npx      ~/.npm/_npx/<hash>/node_modules/...
 *   pnpm dlx ~/.cache/pnpm/dlx/..., $PNPM_HOME/.pnpm/dlx/...,
 *            or %LOCALAPPDATA%/pnpm-cache/dlx/... on Windows
 *   bunx     ~/.bun/install/cache/... or $TMPDIR/bunx-<uid>-<spec>/...
 *
 * Global installs and repo checkouts match none of these and return null.
 * Detection is best-effort; callers must fail closed to a plain `t3` command.
 */
function detectCliRunner(entryPath: string): CliRunner | null {
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
  optionalDependencies: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
});
const decodeInstallManifest = Schema.decodeUnknownEffect(Schema.fromJsonString(InstallManifest));

/** Prove the running package and its global bin belong together before suggesting an update. */
export const resolveServerInstallation = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const args = yield* HostProcess.Arguments;
  const executable = yield* HostProcess.IsExecutable;
  const executablePath = yield* HostProcess.ExecutablePath;
  const platform = yield* HostProcess.Platform;
  const entry = yield* fs.realPath(executable ? executablePath : (args[1] ?? ""));
  const match =
    /^(.*)\/lib\/node_modules\/t3\/(?:dist\/bin\.mjs|bin\/t3\.js|node_modules\/@t3code\/t3-[^/]+\/t3)$/.exec(
      entry,
    );
  if (!match) {
    const runner = detectCliRunner(entry);
    return runner === null
      ? null
      : ({ kind: runner === "pnpm dlx" ? "pnpm-dlx" : runner } satisfies ServerInstallation);
  }
  // A global prefix can contain runner-like names; prove its ownership first.
  // Windows shims and other package managers need their own ownership proof.
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
  if (globalBin !== bin) return null;
  if (executable) {
    const nativeManifest = yield* fs
      .readFileString(path.join(path.dirname(entry), "package.json"))
      .pipe(Effect.flatMap(decodeInstallManifest));
    if (
      manifest.bin.t3 !== "./bin/t3.js" ||
      manifest.optionalDependencies?.[nativeManifest.name] !== nativeManifest.version ||
      nativeManifest.version !== manifest.version
    )
      return null;
  } else if (bin !== entry) {
    return null;
  }
  return { kind: "npm-global", prefix } satisfies ServerInstallation;
}).pipe(Effect.orElseSucceed(() => null));

/**
 * The `t3` package spec to suggest. The literal spec the user typed (e.g.
 * `t3@nightly`) is resolved away before our process starts, so re-derive it
 * from the running version: nightly builds re-suggest the nightly channel,
 * anything else suggests the bare package.
 */
function suggestedPackageSpec(version: string): string {
  const channel = /^[^-+]+-(nightly|preview)\./.exec(version)?.[1];
  return channel === undefined ? "t3" : `t3@${channel}`;
}

/**
 * Render a `t3 <subcommand>` suggestion that matches how this process was
 * launched, so copy/pasting it actually works: `npx t3 connect` suggests
 * `npx t3 serve`, a global install suggests `t3 serve`, and a nightly build
 * keeps the `@nightly` tag.
 */
export function formatCliCommand(input: {
  readonly subcommand: string;
  readonly entryPath: string;
  readonly version: string;
}): string {
  const runner = detectCliRunner(input.entryPath);
  if (runner === null) {
    return `t3 ${input.subcommand}`;
  }
  return `${runner} ${suggestedPackageSpec(input.version)} ${input.subcommand}`;
}

/** `formatCliCommand` against this process's real entry path and version. */
export const resolveCliCommand = (subcommand: string) =>
  Effect.map(HostProcess.Arguments, (processArguments) =>
    formatCliCommand({
      subcommand,
      entryPath: processArguments[1] ?? "",
      version: packageJson.version,
    }),
  );

/** Quotes `value` for a POSIX shell when it needs it. */
const shellWord = (value: string) =>
  /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", `'"'"'`)}'`;

/**
 * The launcher a person can type to run this install when `t3` is not on
 * PATH: the desktop app's `t3` shim, which the app and the shim itself name in
 * `T3CODE_CLI_PATH`, or a standalone binary's own path. Script installs (a
 * repo checkout) have no single launcher and keep plain `t3`.
 */
const resolveInstallLauncher = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const shim = (yield* HostProcess.Environment).T3CODE_CLI_PATH?.trim();
  if (shim && (yield* fs.exists(shim).pipe(Effect.orElseSucceed(() => false)))) {
    return Option.some(shim);
  }
  return (yield* HostProcess.IsExecutable)
    ? Option.some(yield* HostProcess.ExecutablePath)
    : Option.none<string>();
});

/**
 * `t3 <subcommand>` for a person to run on this host: `t3` when it is on PATH,
 * the package runner this process came from, or else the absolute path of the
 * launcher for this install, such as the one the desktop app installs.
 */
const resolveHostCliCommand = (subcommand: string) =>
  Effect.gen(function* () {
    const command = yield* resolveCliCommand(subcommand);
    if (command !== `t3 ${subcommand}`) return { command, launcher: false };
    if (yield* isCommandAvailable("t3")) return { command, launcher: false };
    const launcher = yield* resolveInstallLauncher;
    return Option.isSome(launcher)
      ? { command: `${shellWord(launcher.value)} ${subcommand}`, launcher: true }
      : { command, launcher: false };
  });

/**
 * `t3 <subcommand>` as root, for setup a person runs once on the host. `sudo`
 * resets PATH on most distributions, which drops a user-installed Node (nvm,
 * fnm, a tarball) and with it `npx` or a global `t3`, so the command carries
 * PATH through unless Node is on root's PATH too. An absolute launcher needs
 * neither.
 */
export const resolveRootCliCommand = (subcommand: string) =>
  Effect.gen(function* () {
    const { command, launcher } = yield* resolveHostCliCommand(subcommand);
    if (launcher) return `sudo ${command}`;
    const executablePath = yield* HostProcess.ExecutablePath;
    const systemNode = ROOT_PATH_DIRECTORIES.some((directory) =>
      executablePath.startsWith(`${directory}/`),
    );
    return systemNode ? `sudo ${command}` : `sudo env "PATH=$PATH" ${command}`;
  });

/** Debian and Ubuntu's sudo `secure_path`, minus snap. */
const ROOT_PATH_DIRECTORIES = [
  "/usr/local/sbin",
  "/usr/local/bin",
  "/usr/sbin",
  "/usr/bin",
  "/sbin",
  "/bin",
];
