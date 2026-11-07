import { ProviderDriverKind, type ServerProvider } from "@t3tools/contracts";
import { compareSemverVersions } from "@t3tools/shared/semver";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";

import {
  enrichProviderSnapshotWithVersionAdvisory,
  makeManualOnlyProviderMaintenanceCapabilities,
  makeProviderMaintenanceCapabilities,
  type ProviderMaintenanceCapabilities,
  type ProviderMaintenanceCapabilitiesResolver,
} from "@t3tools/provider-core/server/maintenanceResolver";
import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import { parseGenericCliVersion } from "@t3tools/provider-core/server/snapshotProbe";
import { museLaunch } from "./sdk.ts";

const DRIVER = ProviderDriverKind.make("muse");
const MUSE_CHANNELS = new Set(["muse-stable", "muse-canary"]);
const WINDOWS_LAUNCHER_SHIM = [
  "@echo off",
  "setlocal",
  '"%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%~dp0.muse-launcher.ps1" %*',
  "exit /b %ERRORLEVEL%",
]
  .join("\n")
  .toLowerCase();
const ChannelManifest = Schema.Struct({
  version: Schema.String.check(Schema.isPattern(/^\d+\.\d+\.\d+-R\d+(?:\.\d+)?$/)),
});

export function parseMuseVersion(output: string): string | null {
  return output.match(/\b\d+\.\d+\.\d+-R\d+(?:\.\d+)?\b/)?.[0] ?? parseGenericCliVersion(output);
}

function comparableMuseVersion(version: string): string {
  return version.replace(/-R(\d+)(?:\.(\d+))?$/, "-release.$1.$2").replace(/\.$/, ".0");
}

const MUSE_REVISION = /-R\d+(?:\.\d+)?$/;

export const compareMuseVersions = (current: string, latest: string) =>
  MUSE_REVISION.test(current) === MUSE_REVISION.test(latest)
    ? compareSemverVersions(comparableMuseVersion(current), comparableMuseVersion(latest))
    : compareSemverVersions(current.replace(MUSE_REVISION, ""), latest.replace(MUSE_REVISION, ""));

/** Only the official launcher owns an update channel; a standalone binary cannot update itself. */
export const museMaintenance: ProviderMaintenanceCapabilitiesResolver = {
  windowsScriptExtensions: [".ps1"],
  resolve: Effect.fn("MuseMaintenance.resolve")(function* (context) {
    const manual = {
      ...makeManualOnlyProviderMaintenanceCapabilities({ provider: DRIVER, packageName: null }),
      compareVersions: compareMuseVersions,
    };
    if (!context) return manual;
    const fs = yield* FileSystem.FileSystem;
    const windows = context.platform === "win32";
    const launcherPath = yield* Effect.gen(function* () {
      const stat = yield* fs.stat(context.realCommandPath);
      if (Number(stat.size) > 128 * 1_024) return null;
      let source = yield* fs.readFileString(context.realCommandPath);
      let launcher = context.realCommandPath;
      if (windows) {
        if (/\.(?:cmd|bat)$/i.test(launcher)) {
          if (source.trim().replaceAll("\r\n", "\n").toLowerCase() !== WINDOWS_LAUNCHER_SHIM) {
            return null;
          }
          const path = yield* Path.Path;
          launcher = yield* fs.realPath(path.join(path.dirname(launcher), ".muse-launcher.ps1"));
          if (Number((yield* fs.stat(launcher)).size) > 128 * 1_024) return null;
          source = yield* fs.readFileString(launcher);
        } else if (!/\.ps1$/i.test(launcher)) {
          return null;
        }
      }
      const recognized = windows
        ? isOfficialWindowsLauncher(source)
        : source.includes("muse-code/launcher-") && source.includes("MUSE_SYNC_UPDATE");
      return recognized ? launcher : null;
    }).pipe(Effect.orElseSucceed(() => null));
    if (!launcherPath) return manual;
    const launch = windows
      ? yield* museLaunch(launcherPath, context.env)
      : { command: context.resolvedCommandPath, args: [] };
    const executable = launch.command;
    const args = [...launch.args, "--version"];
    // The launcher has no `update` subcommand. Its documented launch environment
    // forces a synchronous refresh of this executable's own installation.
    const updateEnv = {
      ...(context.env.MUSE_CHANNEL ? { MUSE_CHANNEL: context.env.MUSE_CHANNEL } : {}),
      MUSE_NO_AUTO_UPDATE: "0",
      MUSE_SYNC_UPDATE: "1",
      MUSE_UPDATE_INTERVAL_SECONDS: "0",
    };
    return {
      ...makeProviderMaintenanceCapabilities({
        provider: DRIVER,
        packageName: null,
        updateExecutable: executable,
        updateArgs: args,
        updateCommand: [
          ...Object.entries(updateEnv).map(([key, value]) =>
            windows ? `$env:${key}=${powerShellQuote(value)};` : `${key}=${shellQuote(value)}`,
          ),
          ...(windows ? ["&"] : []),
          ...[executable, ...args].map((word) =>
            windows ? powerShellQuote(word) : shellQuote(word),
          ),
        ].join(" "),
        updateLockKey: `muse:${launcherPath}`,
        platform: context.platform,
        env: { ...context.env, ...updateEnv },
      }),
      compareVersions: compareMuseVersions,
    };
  }),
};

function isOfficialWindowsLauncher(source: string) {
  const normalized = source
    .split(/\r?\n/)
    .map((line) => line.trim())
    .join("\n")
    .trim();
  // The banner alone also appears in wrappers; require the official entry point and updater.
  return (
    normalized.startsWith("Set-StrictMode -Version Latest\n$ErrorActionPreference = 'Stop'\n") &&
    /^\$launcher_version = '\d+'$/m.test(normalized) &&
    [
      "$launcher_url = 'https://api.meta.ai/muse-launcher.ps1'",
      '$user_agent = "muse-code/launcher-ps-$launcher_version"',
      "function Update-Launcher {",
      "function Update-Binary {",
      "function Invoke-Main {",
      "$self = $PSCommandPath\n$dir = Split-Path -Parent $self",
      "if ($env:MUSE_SYNC_UPDATE -eq '1') {\nUpdate-Launcher -Self $self\nUpdate-Binary -Dir $dir\n$binary = Get-ActiveBinary -Dir $dir",
    ].every((signature) => normalized.includes(`\n${signature}\n`)) &&
    normalized.endsWith("\nInvoke-Main @args")
  );
}

function shellQuote(word: string) {
  return /^[\w./:@=-]+$/.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`;
}

function powerShellQuote(word: string) {
  return `'${word.replace(/['\u2018\u2019\u201a\u201b]/g, "$&$&")}'`;
}

export const latestMuseVersion = Effect.fn("latestMuseVersion")(function* (
  environment: NodeJS.ProcessEnv,
  options?: { readonly fresh?: boolean },
) {
  const channel = environment.MUSE_CHANNEL || "muse-stable";
  if (!MUSE_CHANNELS.has(channel)) return null;
  const channelUrl = `https://api.meta.ai/muse-code/channels/${channel}`;
  const client = yield* HttpClient.HttpClient;
  const latestVersions = yield* ProviderLatestVersions.ProviderLatestVersions;
  return yield* latestVersions.cached(
    `muse:${channelUrl}`,
    client.execute(HttpClientRequest.get(channelUrl)).pipe(
      Effect.flatMap((response) =>
        response.status >= 200 && response.status < 300
          ? response.json.pipe(
              Effect.flatMap(Schema.decodeUnknownEffect(ChannelManifest)),
              Effect.map((manifest) => parseMuseVersion(manifest.version)),
            )
          : Effect.succeed(null),
      ),
      Effect.timeout(4_000),
      Effect.orElseSucceed(() => null),
    ),
    options,
  );
});

export const enrichMuseSnapshot = Effect.fn("enrichMuseSnapshot")(function* (input: {
  readonly snapshot: ServerProvider;
  readonly maintenanceCapabilities: ProviderMaintenanceCapabilities;
  readonly enableProviderUpdateChecks: boolean;
  readonly environment: NodeJS.ProcessEnv;
}) {
  const { snapshot } = input;
  const latestVersion =
    input.enableProviderUpdateChecks && snapshot.enabled && snapshot.installed && snapshot.version
      ? yield* latestMuseVersion(input.environment)
      : null;
  return yield* enrichProviderSnapshotWithVersionAdvisory(
    snapshot,
    { ...input.maintenanceCapabilities, latestVersion },
    { enableProviderUpdateChecks: input.enableProviderUpdateChecks },
  );
});
