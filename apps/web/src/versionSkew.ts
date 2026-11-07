import type {
  EnvironmentId,
  ServerConfig,
  ServerInstallation,
  ServerSelfUpdateCapability,
} from "@t3tools/contracts";
import type { ServerUpdateState } from "@t3tools/client-runtime/state/server";
import { compareSemverVersions, parseSemver } from "@t3tools/shared/semver";
import * as Schema from "effect/Schema";

import { APP_VERSION } from "./branding";
import { getLocalStorageItem, setLocalStorageItem } from "./hooks/useLocalStorage";

export interface VersionMismatch {
  readonly clientVersion: string;
  readonly serverVersion: string;
  readonly hint: string;
}

const VERSION_MISMATCH_DISMISSALS_STORAGE_KEY = "t3code:version-mismatch-dismissals:v1";

const dismissedServerUpdateFailures = new WeakSet<ServerUpdateState>();

export function isServerUpdateFailureDismissed(state: ServerUpdateState): boolean {
  return state.status === "failed" && dismissedServerUpdateFailures.has(state);
}

export function dismissServerUpdateFailure(state: ServerUpdateState): void {
  if (state.status === "failed") dismissedServerUpdateFailures.add(state);
}

const VersionMismatchDismissalsSchema = Schema.Struct({
  keys: Schema.Array(Schema.String),
});

type VersionMismatchDismissals = typeof VersionMismatchDismissalsSchema.Type;

function normalizeVersion(version: string | null | undefined): string | null {
  const trimmed = version?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

function versionCore(version: string): string {
  return version.replace(/[-+].*$/, "");
}

export function resolveVersionMismatch(
  serverVersion: string | null | undefined,
  clientVersion: string = APP_VERSION,
): VersionMismatch | null {
  const normalizedClientVersion = normalizeVersion(clientVersion);
  const normalizedServerVersion = normalizeVersion(serverVersion);
  if (!normalizedClientVersion || !normalizedServerVersion) {
    return null;
  }

  const clientCore = versionCore(normalizedClientVersion);
  const serverCore = versionCore(normalizedServerVersion);
  const compareNightlyBuilds =
    parseSemver(normalizedClientVersion)?.prerelease[0] === "nightly" &&
    parseSemver(normalizedServerVersion)?.prerelease[0] === "nightly";
  const serverIsBehind =
    parseSemver(clientCore) && parseSemver(serverCore)
      ? compareSemverVersions(
          compareNightlyBuilds ? normalizedServerVersion : serverCore,
          compareNightlyBuilds ? normalizedClientVersion : clientCore,
        ) < 0
      : normalizedServerVersion !== normalizedClientVersion;
  if (!serverIsBehind) {
    return null;
  }

  return {
    clientVersion: normalizedClientVersion,
    serverVersion: normalizedServerVersion,
    hint: "Version mismatch. Try syncing the client and server to the same T3 Code version.",
  };
}

export function resolveServerConfigVersionMismatch(
  serverConfig: Pick<ServerConfig, "environment"> | null | undefined,
): VersionMismatch | null {
  return resolveVersionMismatch(serverConfig?.environment.serverVersion);
}

export function resolveServerSelfUpdateCapability(
  serverConfig: Pick<ServerConfig, "environment"> | null | undefined,
): ServerSelfUpdateCapability | null {
  return serverConfig?.environment.capabilities.serverSelfUpdate ?? null;
}

export function supportsDesktopAppUpdate(
  serverConfig: Pick<ServerConfig, "environment"> | null | undefined,
): boolean {
  return serverConfig?.environment.capabilities.desktopAppUpdate === true;
}

export interface ManualServerUpdate {
  readonly command: string;
  readonly label: string;
  readonly title: string;
  readonly description: string;
}

const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

export function manualServerUpdate(
  targetVersion: string,
  serverLabel: string,
  installation?: ServerInstallation,
): ManualServerUpdate {
  const unit = installation?.systemdUnit;
  // systemd-escape writes `\x2d` into instance names; unquoted, the shell drops the backslash.
  const unitName = unit ? shellQuote(unit.name) : "";
  const systemctl = unit?.scope === "user" ? "systemctl --user" : "sudo systemctl";
  if (installation?.kind === "npm-global") {
    const install = `npm install --global --prefix ${shellQuote(installation.prefix)} t3@${targetVersion}`;
    return {
      command: unit ? `${install} && ${systemctl} restart ${unitName}` : install,
      label: "Copy update command",
      title: "Update command copied",
      description: unit
        ? `Run it on ${serverLabel}. It also restarts ${unit.name}, which runs this server.`
        : `Run it on ${serverLabel}, then restart t3 there with your usual options.`,
    };
  }
  const runner =
    installation?.kind === "pnpm-dlx" ? "pnpm dlx" : installation?.kind === "bunx" ? "bunx" : "npx";
  const launch = `${runner} t3@${targetVersion}`;
  if (unit) {
    return {
      // Without a reload, restart reuses the ExecStart systemd loaded before the edit.
      command: `${systemctl} daemon-reload && ${systemctl} restart ${unitName}`,
      label: "Copy restart command",
      title: "Restart command copied",
      description:
        installation?.kind === "unknown"
          ? `On ${serverLabel}, update the executable used by ${unit.name} to ${targetVersion}; keep its existing launch configuration. Then run the command. Restarting stops running agents.`
          : `On ${serverLabel}, change only the t3 version in ${unit.name}'s ExecStart to t3@${targetVersion}; keep its existing subcommand and options. Then run the command. Restarting stops running agents.`,
    };
  }
  return {
    command: installation?.subcommand ? `${launch} ${installation.subcommand}` : launch,
    label: "Copy relaunch command",
    title: "Relaunch command copied",
    description: `On ${serverLabel}, stop t3 (Ctrl+C where it runs) and wait for it to exit, then run the command with the same subcommand and options. If a service manages t3, update its launch command and restart that service instead. This does not update an installed t3 command.`,
  };
}

export function buildVersionMismatchDismissalKey(
  environmentId: EnvironmentId,
  mismatch: Pick<VersionMismatch, "clientVersion" | "serverVersion">,
): string {
  return `${environmentId}:${mismatch.clientVersion}:${mismatch.serverVersion}`;
}

function readVersionMismatchDismissals(): VersionMismatchDismissals {
  try {
    return (
      getLocalStorageItem(
        VERSION_MISMATCH_DISMISSALS_STORAGE_KEY,
        VersionMismatchDismissalsSchema,
      ) ?? { keys: [] }
    );
  } catch (error) {
    console.error("Could not read version-mismatch dismissals.", error);
    return { keys: [] };
  }
}

function writeVersionMismatchDismissals(document: VersionMismatchDismissals): void {
  try {
    setLocalStorageItem(
      VERSION_MISMATCH_DISMISSALS_STORAGE_KEY,
      document,
      VersionMismatchDismissalsSchema,
    );
  } catch (error) {
    console.error("Could not persist version-mismatch dismissals.", error);
  }
}

export function isVersionMismatchDismissed(dismissalKey: string | null | undefined): boolean {
  if (!dismissalKey) {
    return false;
  }
  return readVersionMismatchDismissals().keys.includes(dismissalKey);
}

export function dismissVersionMismatch(dismissalKey: string | null | undefined): void {
  if (!dismissalKey) {
    return;
  }
  const document = readVersionMismatchDismissals();
  if (document.keys.includes(dismissalKey)) {
    return;
  }
  writeVersionMismatchDismissals({
    keys: [...document.keys, dismissalKey],
  });
}
