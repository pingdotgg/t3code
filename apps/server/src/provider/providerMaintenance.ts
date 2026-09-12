import {
  ProviderDriverKind,
  type ServerProvider,
  type ServerProviderVersionAdvisory,
} from "@t3tools/contracts";
import { compareSemverVersions } from "@t3tools/shared/semver";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { causeErrorTag } from "@t3tools/shared/observability";
import { resolveCommandPath, resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Config from "effect/Config";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { SqlClient } from "effect/unstable/sql";

import { collectUint8StreamText } from "../stream/collectUint8StreamText.ts";

const LATEST_VERSION_CACHE_TTL_MS = 60 * 60 * 1_000;
const LATEST_VERSION_TIMEOUT_MS = 4_000;
const INSTALLER_PROBE_TIMEOUT_MS = 10_000;
const INSTALLER_PROBE_MAX_BYTES = 256 * 1_024;
const PROVIDER_UPDATE_ACTION_TOAST_MESSAGE = "Install the update now or review provider settings.";

/**
 * Ownership is re-derived from the executable this often. Installs do not
 * move on their own, so this mostly bounds how stale a Homebrew "latest" can
 * get; the npm registry check keeps its own cache.
 */
const MAINTENANCE_CAPABILITIES_CACHE_TTL = Duration.hours(1);

const compactEnv = (input: Record<string, Option.Option<string>>): NodeJS.ProcessEnv =>
  Object.fromEntries(
    Object.entries(input).flatMap(([key, value]) =>
      Option.match(value, {
        onNone: () => [],
        onSome: (resolved) => [[key, resolved]],
      }),
    ),
  );

const CommandLookupEnvConfig = Config.all({
  PATH: Config.string("PATH").pipe(Config.option),
  Path: Config.string("Path").pipe(Config.option),
  path: Config.string("path").pipe(Config.option),
  PATHEXT: Config.string("PATHEXT").pipe(Config.option),
}).pipe(Config.map(compactEnv));

const readCommandLookupEnv = CommandLookupEnvConfig.pipe(Effect.orElseSucceed(() => ({})));

export interface ProviderMaintenanceCapabilities {
  readonly provider: ProviderDriverKind;
  readonly packageName: string | null;
  readonly update: ProviderMaintenanceCommandAction | null;
  /**
   * Latest version reported by the installer that owns the executable.
   * `undefined` means the installer has no channel of its own and the npm
   * registry entry for `packageName` is authoritative; `null` means the
   * installer was asked and did not know. An effect defers a separate lookup
   * until update checks are enabled and binds the owning instance's services.
   */
  readonly latestVersion?: string | null | Effect.Effect<string | null>;
}

export interface ProviderMaintenanceCommandAction {
  readonly command: string;
  readonly executable: string;
  readonly args: ReadonlyArray<string>;
  readonly lockKey: string;
  /** Proven Windows installer and scope; machine installs may request a UAC retry. */
  readonly windowsInstaller?: {
    readonly manager: "scoop" | "winget";
    readonly scope: "user" | "machine";
  };
  /**
   * Extra environment for the spawned updater, on top of the server's own.
   * A native updater finds its install through the same variables the
   * provider runs with (e.g. `CODEX_HOME`), so an instance with a custom home
   * must update that home and not the default one.
   */
  readonly env?: NodeJS.ProcessEnv;
}

/** Where the provider executable was found; every path is absolute. */
export interface ProviderMaintenanceResolutionContext {
  readonly binaryPath: string;
  readonly resolvedCommandPath: string;
  readonly realCommandPath: string;
  readonly env: NodeJS.ProcessEnv;
  /** Host platform; decides how the copyable command quotes the executable. */
  readonly platform: NodeJS.Platform;
}

export type ProviderMaintenanceResolverServices =
  | FileSystem.FileSystem
  | Path.Path
  | ChildProcessSpawner.ChildProcessSpawner;

export interface ProviderMaintenanceCapabilitiesResolver {
  readonly resolve: (
    context: ProviderMaintenanceResolutionContext | null,
  ) => Effect.Effect<ProviderMaintenanceCapabilities, never, ProviderMaintenanceResolverServices>;
}

export interface PackageManagedProviderMaintenanceDefinition {
  readonly provider: ProviderDriverKind;
  readonly npmPackageName: string;
  readonly wingetPackageId?: string;
  readonly nativeUpdate: {
    readonly args: ReadonlyArray<string>;
    readonly isCommandPath: (commandPath: string) => boolean;
    /** Environment the native updater needs to target this instance's install. */
    readonly env?: NodeJS.ProcessEnv;
  } | null;
}

export interface ProviderVersionCacheEntry {
  readonly expiresAt: number;
  readonly version: string | null;
}

export const ProviderVersionCache = Context.Reference<Map<string, ProviderVersionCacheEntry>>(
  "@t3tools/server/providerMaintenance/ProviderVersionCache",
  {
    defaultValue: () => new Map(),
  },
);
const NpmLatestVersionResponse = Schema.Struct({
  version: Schema.optional(Schema.String),
});

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/**
 * The copyable command must paste into a shell as-is, so an executable path
 * with spaces or quotes is quoted for the host's default shell.
 */
function quoteShellWord(word: string, platform: NodeJS.Platform): string {
  const safeWord = platform === "win32" ? /^[\w./:\\@=-]+$/ : /^[\w./:@=-]+$/;
  if (safeWord.test(word)) return word;
  return platform === "win32"
    ? `'${word.replace(/['\u2018\u2019]/g, "$&$&")}'`
    : `'${word.replaceAll("'", "'\\''")}'`;
}

function quoteUpdateExecutable(executable: string, platform: NodeJS.Platform): string {
  const quoted = quoteShellWord(executable, platform);
  // Windows terminals default to PowerShell, where a quoted executable needs &.
  return platform === "win32" && quoted !== executable ? `& ${quoted}` : quoted;
}

export function makeProviderMaintenanceCapabilities(input: {
  readonly provider: ProviderDriverKind;
  readonly packageName: string | null;
  readonly updateExecutable: string | null;
  readonly updateArgs: ReadonlyArray<string>;
  readonly updateLockKey: string | null;
  /** Shown to the user instead of `<executable> <args>`; use for a bare tool name like `brew`. */
  readonly updateCommand?: string;
  readonly platform?: NodeJS.Platform;
  readonly env?: NodeJS.ProcessEnv;
  readonly latestVersion?: Exclude<ProviderMaintenanceCapabilities["latestVersion"], undefined>;
  readonly windowsInstaller?: ProviderMaintenanceCommandAction["windowsInstaller"];
}): ProviderMaintenanceCapabilities {
  const platform = input.platform ?? HostProcessPlatform.defaultValue();
  const update =
    input.updateExecutable === null || input.updateLockKey === null
      ? null
      : {
          command:
            input.updateCommand ??
            [
              quoteUpdateExecutable(input.updateExecutable, platform),
              ...input.updateArgs.map((arg) => quoteShellWord(arg, platform)),
            ].join(" "),
          executable: input.updateExecutable,
          args: input.updateArgs,
          lockKey: input.updateLockKey,
          ...(input.env ? { env: input.env } : {}),
          ...(input.windowsInstaller ? { windowsInstaller: input.windowsInstaller } : {}),
        };
  return {
    provider: input.provider,
    packageName: input.packageName,
    update,
    ...("latestVersion" in input ? { latestVersion: input.latestVersion } : {}),
  };
}

export function makeManualOnlyProviderMaintenanceCapabilities(input: {
  readonly provider: ProviderDriverKind;
  readonly packageName: string | null;
}): ProviderMaintenanceCapabilities {
  return makeProviderMaintenanceCapabilities({
    provider: input.provider,
    packageName: input.packageName,
    updateExecutable: null,
    updateArgs: [],
    updateLockKey: null,
  });
}

export function normalizeCommandPath(commandPath: string): string {
  return commandPath.replaceAll("\\", "/").toLowerCase();
}

function isVitePlusGlobalCommandPath(commandPath: string): boolean {
  return normalizeCommandPath(commandPath).includes("/.vite-plus/bin/");
}

function isBunGlobalCommandPath(commandPath: string): boolean {
  return normalizeCommandPath(commandPath).includes("/.bun/bin/");
}

function isPnpmGlobalCommandPath(commandPath: string): boolean {
  const normalized = normalizeCommandPath(commandPath);
  return (
    normalized.includes("/.local/share/pnpm/") ||
    normalized.includes("/library/pnpm/") ||
    normalized.includes("/local/share/pnpm/") ||
    normalized.includes("/appdata/local/pnpm/") ||
    normalized.includes("/pnpm/global/")
  );
}

/**
 * The npm global prefix that owns a package, derived from the real path of
 * its entry point: `<prefix>/lib/node_modules/<pkg>/…`. Windows global
 * installs have no `lib` segment and are proven by the shim instead (see
 * `resolveNpmGlobalPrefix`). A project-local `node_modules` is not a global
 * install and yields null.
 */
export function npmGlobalPrefixFromCommandPath(
  realCommandPath: string,
  packageName: string,
): string | null {
  const slashPath = realCommandPath.replaceAll("\\", "/");
  const normalized = slashPath.toLowerCase();
  const packageSegment = `/lib/node_modules/${packageName.toLowerCase()}/`;
  const packageIndex = normalized.lastIndexOf(packageSegment);
  if (packageIndex < 0 || normalized.slice(0, packageIndex).includes("/node_modules/")) {
    return null;
  }
  // Mise's npm backend uses a global-looking layout inside a tool version.
  // Globals under its Node installation still belong to npm.
  const miseTool = /\/mise\/installs\/([^/]+)\/[^/]+$/.exec(normalized.slice(0, packageIndex))?.[1];
  if (miseTool && miseTool !== "node") {
    return null;
  }
  return packageIndex === 0 ? "/" : slashPath.slice(0, packageIndex);
}

// `<prefix>/Cellar/<name>/<version>/…` or `<prefix>/Caskroom/<name>/<version>/…`.
// Homebrew always nests a version directory under the keg.
const HOMEBREW_KEG_PATTERN = /^(.*)\/(cellar|caskroom)\/([^/]+)\/[^/]+\//i;

export interface HomebrewOwnership {
  readonly kind: "formula" | "cask";
  readonly name: string;
  /** The Homebrew prefix the keg sits under; must match `brew --prefix`. */
  readonly prefix: string;
}

/**
 * Homebrew looks like the owner when the real path runs through a versioned
 * keg or cask. It is only proven once the prefix matches the `brew` that will
 * run the upgrade (see `resolvePackageManagedProviderMaintenance`).
 */
export function homebrewOwnershipFromCommandPath(
  realCommandPath: string,
): HomebrewOwnership | null {
  const match = HOMEBREW_KEG_PATTERN.exec(realCommandPath.replaceAll("\\", "/"));
  if (!match) {
    return null;
  }
  return {
    kind: match[2]!.toLowerCase() === "cellar" ? "formula" : "cask",
    name: match[3]!,
    prefix: match[1]!,
  };
}

const HomebrewInfoResponse = Schema.Struct({
  formulae: Schema.optional(
    Schema.Array(
      Schema.Struct({
        versions: Schema.optional(Schema.Struct({ stable: Schema.optional(Schema.String) })),
      }),
    ),
  ),
  casks: Schema.optional(Schema.Array(Schema.Struct({ version: Schema.optional(Schema.String) }))),
});

const decodeHomebrewInfo = Schema.decodeUnknownOption(Schema.fromJsonString(HomebrewInfoResponse));

/** Cask versions may carry a build suffix after a comma (`1.2.3,456`). */
export function parseHomebrewLatestVersion(
  infoJson: string,
  ownership: HomebrewOwnership,
): string | null {
  const decoded = decodeHomebrewInfo(infoJson);
  if (Option.isNone(decoded)) {
    return null;
  }
  const raw =
    ownership.kind === "formula"
      ? decoded.value.formulae?.[0]?.versions?.stable
      : decoded.value.casks?.[0]?.version?.split(",", 1)[0];
  return nonEmptyString(raw);
}

/** Return stdout, or null on failure, timeout, or oversized output. */
const runInstallerProbe = Effect.fn("runInstallerProbe")(function* (
  executable: string,
  args: ReadonlyArray<string>,
  env: NodeJS.ProcessEnv,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const collect = Effect.gen(function* () {
    // reg.exe follows the console code page, including when stdout is redirected.
    // Set it before invoking reg so paths survive the UTF-8 stream decoder.
    const registryQuery = /(?:^|[\\/])reg\.exe$/i.test(executable);
    const registryScript = registryQuery
      ? `[Console]::OutputEncoding = [Text.UTF8Encoding]::new(); & ${[executable, ...args]
          .map((value) => `'${value.replaceAll("'", "''")}'`)
          .join(" ")}; exit $LASTEXITCODE`
      : null;
    const path = yield* Path.Path;
    const resolved = yield* resolveSpawnCommand(
      registryScript
        ? path.join(
            env.SystemRoot ?? "C:\\Windows",
            "System32",
            "WindowsPowerShell",
            "v1.0",
            "powershell.exe",
          )
        : executable,
      registryScript
        ? [
            "-NoProfile",
            "-NonInteractive",
            "-EncodedCommand",
            Buffer.from(registryScript, "utf16le").toString("base64"),
          ]
        : args,
      { env, extendEnv: true },
    );
    const child = yield* spawner.spawn(
      ChildProcess.make(resolved.command, resolved.args, {
        env,
        extendEnv: true,
        shell: resolved.shell,
      }),
    );
    yield* Effect.addFinalizer(() => child.kill().pipe(Effect.ignore));
    const [stdout, exitCode, stderr] = yield* Effect.all(
      [
        collectUint8StreamText({ stream: child.stdout, maxBytes: INSTALLER_PROBE_MAX_BYTES }),
        child.exitCode,
        collectUint8StreamText({ stream: child.stderr, maxBytes: INSTALLER_PROBE_MAX_BYTES }),
      ],
      { concurrency: "unbounded" },
    );
    // `reg query /s /f` exits 1 with a summary on stdout when there are no matches.
    const noMatches =
      args.includes("/s") &&
      Number(exitCode) === 1 &&
      stdout.text.trim() !== "" &&
      stderr.text.trim() === "";
    if (args[0] === "query" && stderr.text.trim() !== "") return null;
    return (Number(exitCode) !== 0 && !noMatches) ||
      stdout.truncated ||
      stderr.truncated ||
      stdout.invalidUtf8
      ? null
      : stdout.text;
  });
  return yield* collect.pipe(
    Effect.scoped,
    Effect.timeoutOption(Duration.millis(INSTALLER_PROBE_TIMEOUT_MS)),
    Effect.map(Option.getOrNull),
    Effect.catchCause((cause) => {
      const interrupts = cause.reasons.filter(Cause.isInterruptReason);
      if (interrupts.length > 0) return Effect.failCause(Cause.fromReasons<never>(interrupts));
      return Effect.logWarning("Installer probe failed", {
        subcommand: args[0],
        errorTag: causeErrorTag(cause),
      }).pipe(Effect.as(null));
    }),
  );
});

const decodeScoopMetadata = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      bucket: Schema.optional(Schema.String),
    }),
  ),
);
const decodeWingetSource = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      Identifier: Schema.String,
      Name: Schema.String,
    }),
  ),
);

const readWingetPortableIndex = Effect.fn("readWingetPortableIndex")(
  function* (filename: string) {
    const fs = yield* FileSystem.FileSystem;
    if (Number((yield* fs.stat(filename)).size) > INSTALLER_PROBE_MAX_BYTES) return null;
    const sqlite = yield* Effect.promise(async () =>
      process.versions.bun !== undefined
        ? await import("@effect/sql-sqlite-bun/SqliteClient")
        : await import("@t3tools/shared/nodeSqliteClient"),
    );
    return yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      return yield* sql`SELECT filepath, filetype, symlinktarget FROM portable`;
    }).pipe(
      Effect.provide(sqlite.layer({ filename, readonly: true })),
      Effect.flatMap(
        Schema.decodeUnknownEffect(
          Schema.Array(
            Schema.Struct({
              filepath: Schema.String,
              filetype: Schema.Number,
              symlinktarget: Schema.NullOr(Schema.String),
            }),
          ),
        ),
      ),
    );
  },
  Effect.orElseSucceed(() => null),
);

/** Windows ownership must survive explicit selection, including a shim retargeted off PATH. */
const resolveWindowsInstaller = Effect.fn("resolveWindowsInstaller")(function* (
  definition: PackageManagedProviderMaintenanceDefinition,
  context: ProviderMaintenanceResolutionContext,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const manual = {
    ...makeManualOnlyProviderMaintenanceCapabilities({
      provider: definition.provider,
      packageName: definition.npmPackageName,
    }),
    latestVersion: null,
  };
  const canonical = (value: string) => normalizeCommandPath(path.normalize(value));
  const realPath = (value: string) => fs.realPath(value).pipe(Effect.orElseSucceed(() => null));
  const read = Effect.fn("readInstallerMetadata")(function* (file: string) {
    return yield* collectUint8StreamText({
      stream: fs.stream(file, { bytesToRead: INSTALLER_PROBE_MAX_BYTES + 1 }),
      maxBytes: INSTALLER_PROBE_MAX_BYTES,
    }).pipe(
      Effect.map((result) => (result.truncated || result.invalidUtf8 ? null : result.text)),
      Effect.orElseSucceed(() => null),
    );
  });
  const resolve = (command: string) =>
    resolveCommandPath(command, { env: context.env }).pipe(
      Effect.catchTag("CommandResolutionError", () => Effect.succeed(null)),
    );
  const action = (
    windowsInstaller: NonNullable<ProviderMaintenanceCommandAction["windowsInstaller"]>,
    executable: string,
    args: string[],
    lockKey: string,
    latestVersion: Exclude<ProviderMaintenanceCapabilities["latestVersion"], undefined>,
    env = context.env,
  ) =>
    makeProviderMaintenanceCapabilities({
      provider: definition.provider,
      packageName: definition.npmPackageName,
      windowsInstaller,
      updateExecutable: executable,
      updateArgs: args,
      updateLockKey: lockKey,
      platform: context.platform,
      env,
      latestVersion,
    });

  const observed = context.resolvedCommandPath.replaceAll("\\", "/");
  // npm prefixes can contain "shims" or "apps" without belonging to Scoop.
  const npmShim =
    /\.cmd$/i.test(observed) &&
    (yield* resolveNpmGlobalPrefix(context, definition.npmPackageName)) !== null;
  const shim = npmShim ? null : /^(.*)\/shims\/[^/]+\.(?:exe|cmd|ps1)$/i.exec(observed);
  if (shim && !/\.exe$/i.test(observed)) return manual;
  const shimText = shim ? yield* read(observed.replace(/\.exe$/i, ".shim")) : null;
  const targets = [...(shimText ?? "").matchAll(/^\s*path\s*=\s*"([^"\r\n]+)"\s*$/gim)];
  const target = shim ? (targets.length === 1 ? targets[0]![1]! : null) : context.realCommandPath;
  const scoop =
    !npmShim &&
    target &&
    /^(.*)\/apps\/([\w.-]+)\/[^/]+\/(.+)$/i.exec(target.replaceAll("\\", "/"));
  if (shim || scoop) {
    if (!scoop || !target || !path.isAbsolute(target)) return manual;
    const [root, app, relative] = [scoop[1]!, scoop[2]!, scoop[3]!];
    if (/\/microsoft\/winget\//i.test(observed)) return manual;
    // Globals beside a Scoop-installed Node belong to npm, not to Node's Scoop package.
    if (/^nodejs(?:-lts|\d+)?$/i.test(app)) return null;
    if (relative.split(/[\\/]/).includes("..")) return manual;
    if (shim && canonical(shim[1]!) !== canonical(root)) return manual;
    const current = path.join(root, "apps", app, "current");
    const realCurrent = yield* realPath(current);
    const realTarget = yield* realPath(target);
    if (
      canonical(shim ? target : observed) !== canonical(path.join(current, relative)) ||
      !realCurrent ||
      !realTarget ||
      canonical(path.join(realCurrent, relative)) !== canonical(realTarget)
    )
      return manual;
    const install = decodeScoopMetadata((yield* read(path.join(current, "install.json"))) ?? "");
    const bucket = Option.isSome(install) ? install.value.bucket : null;
    if (!bucket || !/^[\w][\w.-]*$/.test(bucket)) return manual;
    const executable = yield* resolve("scoop");
    const manager =
      executable && /^(.*)\/shims\/scoop\.(?:cmd|exe)$/i.exec(executable.replaceAll("\\", "/"));
    if (!executable || !manager) return manual;
    const managerRoot = manager[1]!;
    const global = canonical(root) !== canonical(managerRoot);
    if (global) {
      const configured =
        context.env.SCOOP_GLOBAL ??
        (yield* runInstallerProbe(executable, ["config", "global_path"], context.env));
      if (configured === null) return manual;
      const globalRoot =
        !configured.trim() || /^'global_path' is not set\s*$/i.test(configured)
          ? path.join(context.env.ProgramData ?? "C:\\ProgramData", "scoop")
          : configured.trim();
      if (canonical(globalRoot) !== canonical(root)) return manual;
    }
    return action(
      { manager: "scoop", scope: global ? "machine" : "user" },
      executable,
      ["update", `${bucket}/${app}`, ...(global ? ["--global"] : [])],
      // Updating any app may first refresh this manager and its shared buckets.
      `scoop:${canonical((yield* realPath(managerRoot)) ?? managerRoot)}`,
      // Local bucket manifests can be stale; keep an explicit update check available.
      null,
      { ...context.env, SCOOP: managerRoot, ...(global ? { SCOOP_GLOBAL: root } : {}) },
    );
  }

  const packageId = definition.wingetPackageId;
  // Proven npm ownership must survive an inconclusive Windows registry probe.
  if (!packageId || npmShim) return null;
  const registry = path.join(context.env.SystemRoot ?? "C:\\Windows", "System32", "reg.exe");
  const currentVersion = "Software\\Microsoft\\Windows\\CurrentVersion";
  const uninstall = `${currentVersion}\\Uninstall`;
  const entries: Array<{
    productCode: string;
    values: Map<string, string>;
    scope: "user" | "machine";
  }> = [];
  for (const [hive, scope, view] of [
    ["HKCU", "user", "/reg:64"],
    ["HKLM", "machine", "/reg:64"],
    ["HKLM", "machine", "/reg:32"],
  ] as const) {
    const found = yield* runInstallerProbe(
      registry,
      ["query", `${hive}\\${uninstall}`, "/s", "/f", packageId, "/d", "/e", view],
      context.env,
    );
    if (found === null) {
      // A missing uninstall root is normal on fresh profiles; an unreadable one is not proof.
      const parent = `${hive === "HKCU" ? "HKEY_CURRENT_USER" : "HKEY_LOCAL_MACHINE"}\\${currentVersion}`;
      const listing = yield* runInstallerProbe(registry, ["query", parent, view], context.env);
      const keys = listing?.split(/\r?\n/).map((line) => line.trim().toLowerCase());
      if (keys !== undefined && !keys.includes(`${parent}\\Uninstall`.toLowerCase())) continue;
      return manual;
    }
    for (const key of found.match(/^HKEY_[^\r\n]+/gim) ?? []) {
      const record = yield* runInstallerProbe(registry, ["query", key.trim(), view], context.env);
      if (record === null) return manual;
      const values = new Map(
        [...record.matchAll(/^\s*(\w+)\s+REG_(?:SZ|DWORD)\s+(.+?)\s*$/gm)].map((match) => [
          match[1]!,
          match[2]!,
        ]),
      );
      if (values.get("WinGetPackageIdentifier")?.toLowerCase() === packageId.toLowerCase())
        entries.push({ productCode: key.trim().split("\\").at(-1)!, values, scope });
    }
  }
  const matches = [];
  for (const entry of entries) {
    const { values, productCode } = entry;
    const targetPath = values.get("TargetFullPath");
    // A matching link name alone is insufficient: the link may now point elsewhere.
    if (targetPath) {
      if (canonical(targetPath) === canonical(context.realCommandPath)) matches.push(entry);
      continue;
    }
    const location = values.get("InstallLocation");
    if (
      !location ||
      !path.isAbsolute(location) ||
      !/^[\w.-]+$/.test(productCode) ||
      !canonical(context.realCommandPath).startsWith(`${canonical(location).replace(/\/+$/, "")}/`)
    )
      continue;
    // Archive portables record ownership in <ARP product code>.db, not TargetFullPath.
    const files = yield* readWingetPortableIndex(path.join(location, `${productCode}.db`));
    if (!files) return manual;
    const owned = files.filter(
      (file) =>
        file.filetype === 1 && canonical(file.filepath) === canonical(context.realCommandPath),
    );
    const links = files.filter(
      (file) =>
        file.filetype === 3 &&
        file.symlinktarget &&
        canonical(file.symlinktarget) === canonical(context.realCommandPath),
    );
    if (owned.length !== 1 || links.length !== 1) return manual;
    const linkTarget = yield* realPath(links[0]!.filepath);
    const directoryOnPath = /^(?:0x0*1|1)$/i.test(values.get("InstallDirectoryAddedToPath") ?? "");
    if (
      linkTarget ? canonical(linkTarget) !== canonical(context.realCommandPath) : !directoryOnPath
    )
      return manual;
    matches.push(entry);
  }
  if (matches.length === 0)
    return /\/microsoft\/winget\//i.test(
      `${observed}/${context.realCommandPath.replaceAll("\\", "/")}`,
    )
      ? manual
      : null;
  if (matches.length !== 1) return manual;
  const { values, scope } = matches[0]!;
  if (values.get("WinGetInstallerType") !== "portable") return manual;
  const sourceId = values.get("WinGetSourceIdentifier");
  // --id/--source/--scope cannot distinguish two records with the same identity.
  if (
    !sourceId ||
    entries.filter(
      (entry) => entry.scope === scope && entry.values.get("WinGetSourceIdentifier") === sourceId,
    ).length !== 1
  )
    return manual;
  let executable = yield* resolve("winget");
  if (!executable && context.env.LOCALAPPDATA) {
    const alias = path.join(context.env.LOCALAPPDATA, "Microsoft", "WindowsApps", "winget.exe");
    // App Installer's execution alias is a reparse point, not a regular executable.
    if (yield* fs.readLink(alias).pipe(Effect.orElseSucceed(() => null))) executable = alias;
  }
  if (!executable) return manual;
  const sources = yield* runInstallerProbe(
    executable,
    ["source", "export", "--disable-interactivity"],
    context.env,
  );
  const sourceMatches = (sources ?? "").split(/\r?\n/).flatMap((line) => {
    const source = decodeWingetSource(line);
    return Option.isSome(source) && source.value.Identifier === sourceId ? [source.value.Name] : [];
  });
  if (sourceMatches.length !== 1 || !sourceMatches[0]) return manual;
  const selection = ["--id", packageId, "--exact", "--source", sourceMatches[0]];
  const unattended = ["--accept-source-agreements", "--disable-interactivity"];
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const latest = yield* runInstallerProbe(
    executable,
    ["show", ...selection, "--versions", ...unattended],
    context.env,
  ).pipe(
    Effect.map((versions) =>
      (versions?.match(/^\s*\d+\.\d+\.\d+(?:-[\w.-]+)?\s*$/gm) ?? [])
        .map((version) => version.trim())
        .reduce<string | null>(
          (latest, version) =>
            latest === null || compareSemverVersions(version, latest) > 0 ? version : latest,
          null,
        ),
    ),
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    Effect.provideService(FileSystem.FileSystem, fs),
    Effect.provideService(Path.Path, path),
    Effect.cached,
  );
  return action(
    { manager: "winget", scope },
    executable,
    [
      "upgrade",
      ...selection,
      "--scope",
      scope,
      // Portable upgrades otherwise relocate custom installs to WinGet's default directory.
      "--location",
      values.get("InstallLocation") ?? path.dirname(context.realCommandPath),
      // Single-file portable upgrades otherwise revert a custom executable name.
      ...(values.has("TargetFullPath") ? ["--rename", path.basename(context.realCommandPath)] : []),
      ...unattended,
    ],
    `winget:${sourceId}:${packageId}:${scope}:${canonical(context.realCommandPath)}`,
    latest,
  );
});

/**
 * Derive update capabilities from where the executable actually lives. Every
 * branch that yields a one-click command has evidence that the named tool
 * owns that path; anything unproven stays manual-only so T3 Code never runs
 * a package manager against an install it did not create.
 */
export const resolvePackageManagedProviderMaintenance = Effect.fn(
  "resolvePackageManagedProviderMaintenance",
)(function* (
  definition: PackageManagedProviderMaintenanceDefinition,
  context: ProviderMaintenanceResolutionContext | null,
) {
  const manual = makeManualOnlyProviderMaintenanceCapabilities({
    provider: definition.provider,
    packageName: definition.npmPackageName,
  });
  if (!context) {
    return manual;
  }
  if (context.platform === "win32") {
    const windows = yield* resolveWindowsInstaller(definition, context).pipe(
      Effect.timeoutOrElse({
        duration: Duration.millis(INSTALLER_PROBE_TIMEOUT_MS),
        orElse: () => Effect.succeed({ ...manual, latestVersion: null }),
      }),
    );
    if (windows) return windows;
  }
  const commandPaths = [context.resolvedCommandPath, context.realCommandPath];
  const packageName = definition.npmPackageName;

  const nativeUpdate = definition.nativeUpdate;
  if (nativeUpdate && commandPaths.some((commandPath) => nativeUpdate.isCommandPath(commandPath))) {
    return makeProviderMaintenanceCapabilities({
      provider: definition.provider,
      packageName,
      updateExecutable: context.resolvedCommandPath,
      updateArgs: nativeUpdate.args,
      updateLockKey: `${definition.provider}-native`,
      platform: context.platform,
      ...(nativeUpdate.env ? { env: nativeUpdate.env } : {}),
    });
  }
  if (commandPaths.some(isVitePlusGlobalCommandPath)) {
    return makeProviderMaintenanceCapabilities({
      provider: definition.provider,
      packageName,
      updateExecutable: "vp",
      updateArgs: ["i", "-g", packageName],
      updateLockKey: "vite-plus-global",
    });
  }
  if (commandPaths.some(isBunGlobalCommandPath)) {
    return makeProviderMaintenanceCapabilities({
      provider: definition.provider,
      packageName,
      updateExecutable: "bun",
      updateArgs: ["i", "-g", `${packageName}@latest`],
      updateLockKey: "bun-global",
    });
  }
  if (commandPaths.some(isPnpmGlobalCommandPath)) {
    return makeProviderMaintenanceCapabilities({
      provider: definition.provider,
      packageName,
      updateExecutable: "pnpm",
      updateArgs: ["add", "-g", `${packageName}@latest`],
      updateLockKey: "pnpm-global",
    });
  }

  // npm proof names the package, so it outranks a keg the path merely passes
  // through: a Homebrew-installed Node keeps its globals under
  // `Cellar/node/<ver>/lib/node_modules/`, and that is npm's install, not brew's.
  const npmPrefix = yield* resolveNpmGlobalPrefix(context, packageName);
  if (npmPrefix) {
    // npm 12 blocks install scripts by default (empty allow-scripts allowlist)
    // and still exits 0, so a package whose postinstall finishes the install
    // (claude copies its native binary over a placeholder stub) is left broken
    // while the update reports success. Allow this one package's scripts.
    // Older npm warns about the unknown config and continues.
    return makeProviderMaintenanceCapabilities({
      provider: definition.provider,
      packageName,
      updateExecutable: "npm",
      updateArgs: [
        "install",
        "-g",
        "--prefix",
        npmPrefix,
        `--allow-scripts=${packageName}`,
        `${packageName}@latest`,
      ],
      updateLockKey: `npm-global:${normalizeCommandPath(npmPrefix)}`,
    });
  }

  const homebrew = homebrewOwnershipFromCommandPath(context.realCommandPath);
  if (homebrew) {
    // Mise shims resolve to the version manager, not the provider.
    if (homebrew.kind === "formula" && homebrew.name.toLowerCase() === "mise") {
      return manual;
    }
    const brewPath = yield* resolveCommandPath("brew", { env: context.env }).pipe(
      Effect.catchTags({ CommandResolutionError: () => Effect.succeed(null) }),
    );
    if (!brewPath) {
      return manual;
    }
    // A keg-shaped path is only Homebrew's if it sits under the prefix of the
    // `brew` that would upgrade it; `brew --prefix` is a cheap shell script.
    const fileSystem = yield* FileSystem.FileSystem;
    const brewPrefix = nonEmptyString(
      yield* runInstallerProbe(brewPath, ["--prefix"], context.env),
    );
    const realBrewPrefix = brewPrefix
      ? yield* fileSystem.realPath(brewPrefix).pipe(Effect.orElseSucceed(() => brewPrefix))
      : null;
    if (
      !realBrewPrefix ||
      normalizeCommandPath(realBrewPrefix) !== normalizeCommandPath(homebrew.prefix)
    ) {
      return manual;
    }
    const args =
      homebrew.kind === "cask" ? ["upgrade", "--cask", homebrew.name] : ["upgrade", homebrew.name];
    // Homebrew lags npm by hours on every release, so compare against what
    // `brew upgrade` can actually deliver.
    const info = yield* runInstallerProbe(
      brewPath,
      ["info", "--json=v2", homebrew.name],
      context.env,
    );
    return makeProviderMaintenanceCapabilities({
      provider: definition.provider,
      packageName,
      updateExecutable: brewPath,
      updateArgs: args,
      updateLockKey: "homebrew",
      updateCommand: ["brew", ...args].join(" "),
      latestVersion: info ? parseHomebrewLatestVersion(info, homebrew) : null,
    });
  }

  return manual;
});

/**
 * POSIX npm links `<prefix>/bin/<cmd>` into the package, so the real path is
 * proof. Windows npm writes `.cmd` shims beside `node_modules`, so the proof
 * is the package manifest next to the shim.
 */
const resolveNpmGlobalPrefix = Effect.fn("resolveNpmGlobalPrefix")(function* (
  context: ProviderMaintenanceResolutionContext,
  packageName: string,
) {
  const fromRealPath = npmGlobalPrefixFromCommandPath(context.realCommandPath, packageName);
  if (fromRealPath) {
    return fromRealPath;
  }
  if ((yield* HostProcessPlatform) !== "win32") {
    return null;
  }
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const shimDir = path.dirname(context.resolvedCommandPath);
  const manifestPath = path.join(
    shimDir,
    "node_modules",
    ...packageName.split("/"),
    "package.json",
  );
  // npm writes both `<cmd>.cmd` and an extensionless sh script into the
  // Windows prefix; either one sits directly beside `node_modules`. A POSIX
  // project checkout has the same shape, which is why this is Windows-only.
  const hasManifest = yield* fileSystem
    .exists(manifestPath)
    .pipe(Effect.orElseSucceed(() => false));
  return hasManifest ? shimDir : null;
});

export function makePackageManagedProviderMaintenanceResolver(
  definition: PackageManagedProviderMaintenanceDefinition,
): ProviderMaintenanceCapabilitiesResolver {
  return {
    resolve: (context) => resolvePackageManagedProviderMaintenance(definition, context),
  };
}

function makeManualProviderMaintenanceCapabilities(
  provider: ProviderDriverKind,
): ProviderMaintenanceCapabilities {
  return makeManualOnlyProviderMaintenanceCapabilities({
    provider,
    packageName: null,
  });
}

/**
 * Locate the configured provider executable, follow symlinks, and hand the
 * result to the resolver. A binary that cannot be found yields the resolver's
 * no-context answer.
 */
export const resolveProviderMaintenanceCapabilitiesEffect = Effect.fn(
  "resolveProviderMaintenanceCapabilitiesEffect",
)(function* (
  resolver: ProviderMaintenanceCapabilitiesResolver,
  options?: {
    readonly binaryPath?: string | null;
    readonly env?: NodeJS.ProcessEnv;
  },
) {
  const binaryPath = nonEmptyString(options?.binaryPath);
  if (!binaryPath) {
    return yield* resolver.resolve(null);
  }

  const env = options?.env ?? (yield* readCommandLookupEnv);
  // resolveCommandPath checks explicit paths for existence too, so a missing
  // binary always lands in the no-context branch and never gets an update
  // command it cannot run.
  const resolvedCommandPath = yield* resolveCommandPath(binaryPath, { env }).pipe(
    Effect.catchTags({ CommandResolutionError: () => Effect.succeed(null) }),
  );
  if (!resolvedCommandPath) {
    return yield* resolver.resolve(null);
  }

  const fileSystem = yield* FileSystem.FileSystem;
  const realCommandPath = yield* fileSystem
    .realPath(resolvedCommandPath)
    .pipe(Effect.orElseSucceed(() => null));
  if (!realCommandPath) {
    return yield* resolver.resolve(null);
  }
  return yield* resolver.resolve({
    binaryPath,
    resolvedCommandPath,
    realCommandPath,
    env,
    platform: yield* HostProcessPlatform,
  });
});

/**
 * Turn a one-shot resolution into the shape drivers expose: a cached read for
 * advisories and a `fresh` read that update execution uses so it never trusts
 * ownership derived before the user clicked.
 */
export const makeCachedProviderMaintenanceResolution = Effect.fn(
  "makeCachedProviderMaintenanceResolution",
)(function* (resolve: Effect.Effect<ProviderMaintenanceCapabilities>) {
  const semaphore = yield* Semaphore.make(1);
  let cached: { value: ProviderMaintenanceCapabilities; expiresAt: number } | undefined;
  return (options?: { readonly fresh?: boolean }) =>
    semaphore.withPermit(
      Effect.gen(function* () {
        if (options?.fresh) cached = undefined;
        if (cached && cached.expiresAt > (yield* Clock.currentTimeMillis)) return cached.value;
        const value = yield* resolve;
        cached = {
          value,
          expiresAt:
            (yield* Clock.currentTimeMillis) +
            Duration.toMillis(MAINTENANCE_CAPABILITIES_CACHE_TTL),
        };
        return value;
      }),
    );
});

/** Bind the instance's lookup services once; callers need no resolver services. */
export const makeProviderMaintenanceResolution = Effect.fn("makeProviderMaintenanceResolution")(
  function* (
    resolver: ProviderMaintenanceCapabilitiesResolver,
    options: { readonly binaryPath: string; readonly env: NodeJS.ProcessEnv },
  ) {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    return yield* makeCachedProviderMaintenanceResolution(
      resolveProviderMaintenanceCapabilitiesEffect(resolver, options).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
      ),
    );
  },
);

function deriveVersionAdvisory(input: {
  readonly currentVersion: string | null;
  readonly latestVersion: string | null;
}): Pick<ServerProviderVersionAdvisory, "status" | "message"> {
  if (!input.currentVersion) {
    return { status: "unknown", message: null };
  }
  if (!input.latestVersion) {
    return { status: "unknown", message: null };
  }
  if (compareSemverVersions(input.currentVersion, input.latestVersion) < 0) {
    return {
      status: "behind_latest",
      message: PROVIDER_UPDATE_ACTION_TOAST_MESSAGE,
    };
  }
  return { status: "current", message: null };
}

export function createProviderVersionAdvisory(input: {
  readonly driver: ProviderDriverKind;
  readonly currentVersion: string | null;
  readonly latestVersion?: string | null;
  readonly checkedAt?: string | null;
  readonly maintenanceCapabilities?: ProviderMaintenanceCapabilities;
}): ServerProviderVersionAdvisory {
  const capabilities =
    input.maintenanceCapabilities ?? makeManualProviderMaintenanceCapabilities(input.driver);
  const latestVersion = input.latestVersion ?? null;
  const advisory = deriveVersionAdvisory({
    currentVersion: input.currentVersion,
    latestVersion,
  });

  return {
    status: advisory.status,
    currentVersion: input.currentVersion,
    latestVersion,
    updateCommand: capabilities.update?.command ?? null,
    canUpdate: capabilities.update !== null,
    checkedAt: input.checkedAt ?? null,
    message: advisory.message,
  };
}

const fetchNpmLatestVersion = Effect.fn("fetchNpmLatestVersion")(function* (packageName: string) {
  const client = yield* HttpClient.HttpClient;
  const request = HttpClientRequest.get(
    `https://registry.npmjs.org/${encodeURIComponent(packageName)}/latest`,
  ).pipe(HttpClientRequest.setHeader("accept", "application/json"));
  const response = yield* client.execute(request).pipe(
    Effect.timeoutOption(LATEST_VERSION_TIMEOUT_MS),
    Effect.orElseSucceed(() => Option.none()),
  );
  if (Option.isNone(response)) {
    return null;
  }
  const httpResponse = response.value;
  if (httpResponse.status < 200 || httpResponse.status >= 300) {
    return null;
  }
  const payload = yield* httpResponse.json.pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(NpmLatestVersionResponse)),
    Effect.orElseSucceed(() => null),
  );
  return payload ? nonEmptyString(payload.version) : null;
});

export const resolveLatestProviderVersion = Effect.fn("resolveLatestProviderVersion")(function* (
  maintenanceCapabilities: ProviderMaintenanceCapabilities,
) {
  if (maintenanceCapabilities.latestVersion !== undefined) {
    return Effect.isEffect(maintenanceCapabilities.latestVersion)
      ? yield* maintenanceCapabilities.latestVersion
      : maintenanceCapabilities.latestVersion;
  }
  const packageName = maintenanceCapabilities.packageName;
  if (!packageName) {
    return null;
  }

  const latestVersionCache = yield* ProviderVersionCache;
  const cached = latestVersionCache.get(packageName);
  const now = DateTime.toEpochMillis(yield* DateTime.now);
  if (cached && cached.expiresAt > now) {
    return cached.version;
  }

  const version = yield* fetchNpmLatestVersion(packageName);
  latestVersionCache.set(packageName, {
    expiresAt: now + LATEST_VERSION_CACHE_TTL_MS,
    version,
  });
  return version;
});

export const enrichProviderSnapshotWithVersionAdvisory = Effect.fn(
  "enrichProviderSnapshotWithVersionAdvisory",
)(function* (
  snapshot: ServerProvider,
  maintenanceCapabilities?: ProviderMaintenanceCapabilities,
  options?: {
    readonly enableProviderUpdateChecks: boolean | undefined;
  },
) {
  const capabilities =
    maintenanceCapabilities ?? makeManualProviderMaintenanceCapabilities(snapshot.driver);
  const shouldResolveLatestVersion =
    options?.enableProviderUpdateChecks !== false &&
    snapshot.enabled &&
    snapshot.installed &&
    Boolean(snapshot.version);
  if (!shouldResolveLatestVersion) {
    return {
      ...snapshot,
      versionAdvisory: createProviderVersionAdvisory({
        driver: snapshot.driver,
        currentVersion: snapshot.version,
        checkedAt: snapshot.checkedAt,
        maintenanceCapabilities: capabilities,
      }),
    };
  }

  const latestVersion = yield* resolveLatestProviderVersion(capabilities);
  return {
    ...snapshot,
    versionAdvisory: createProviderVersionAdvisory({
      driver: snapshot.driver,
      currentVersion: snapshot.version,
      latestVersion,
      checkedAt: DateTime.formatIso(yield* DateTime.now),
      maintenanceCapabilities: capabilities,
    }),
  };
});
