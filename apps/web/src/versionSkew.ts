import type { EnvironmentId, ServerConfig, ServerSelfUpdateCapability } from "@t3tools/contracts";
import { compareSemverVersions, parseSemver } from "@t3tools/shared/semver";
import * as Schema from "effect/Schema";

import { APP_VERSION } from "./branding";
import { getLocalStorageItem, setLocalStorageItem } from "./hooks/useLocalStorage";

export interface VersionMismatch {
  readonly clientVersion: string;
  readonly serverVersion: string;
  readonly hint: string;
}

export type CompatibilityChannel = "Stable" | "Nightly";

export interface CompatibilityChannelMismatch {
  readonly clientVersion: string;
  readonly clientChannel: CompatibilityChannel;
  readonly serverVersion: string;
  readonly serverChannel: CompatibilityChannel;
  readonly newerSide: "client" | "server" | null;
}

export const VERSION_MISMATCH_DISMISSALS_STORAGE_KEY = "t3code:version-mismatch-dismissals:v1";

const VersionMismatchDismissalsSchema = Schema.Struct({
  keys: Schema.Array(Schema.String),
});

type VersionMismatchDismissals = typeof VersionMismatchDismissalsSchema.Type;

function normalizeVersion(version: string | null | undefined): string | null {
  const trimmed = version?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

function compatibilityChannel(
  version: string,
  stageLabel?: string | null,
): CompatibilityChannel | null {
  const normalizedStage = stageLabel?.trim().toLowerCase();
  if (normalizedStage === "dev" || version === "0.0.0" || /-(?:dev|test)(?:\.|$)/i.test(version)) {
    return null;
  }
  if (normalizedStage === "nightly" || /-nightly(?:\.|$)/i.test(version)) {
    return "Nightly";
  }
  return "Stable";
}

function newerCompatibilitySide(
  clientVersion: string,
  serverVersion: string,
): CompatibilityChannelMismatch["newerSide"] {
  if (!parseSemver(clientVersion) || !parseSemver(serverVersion)) {
    return null;
  }

  const comparison = compareSemverVersions(clientVersion, serverVersion);
  return comparison === 0 ? null : comparison > 0 ? "client" : "server";
}

export function resolveCompatibilityChannelMismatch({
  clientVersion,
  clientStageLabel,
  serverVersion,
}: {
  readonly clientVersion: string | null | undefined;
  readonly clientStageLabel: string | null | undefined;
  readonly serverVersion: string | null | undefined;
}): CompatibilityChannelMismatch | null {
  const normalizedClientVersion = normalizeVersion(clientVersion);
  const normalizedServerVersion = normalizeVersion(serverVersion);
  if (!normalizedClientVersion || !normalizedServerVersion) {
    return null;
  }

  const clientChannel = compatibilityChannel(normalizedClientVersion, clientStageLabel);
  const serverChannel = compatibilityChannel(normalizedServerVersion);
  if (!clientChannel || !serverChannel || clientChannel === serverChannel) {
    return null;
  }

  return {
    clientVersion: normalizedClientVersion,
    clientChannel,
    serverVersion: normalizedServerVersion,
    serverChannel,
    newerSide: newerCompatibilitySide(normalizedClientVersion, normalizedServerVersion),
  };
}

export function resolveVersionMismatch(
  serverVersion: string | null | undefined,
): VersionMismatch | null {
  const normalizedClientVersion = normalizeVersion(APP_VERSION);
  const normalizedServerVersion = normalizeVersion(serverVersion);
  if (
    !normalizedClientVersion ||
    !normalizedServerVersion ||
    normalizedClientVersion === normalizedServerVersion
  ) {
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

/** The update path the connected server offers, or null when it only
    supports a manual relaunch (older servers, dev checkouts, Windows). */
export function resolveServerSelfUpdateCapability(
  serverConfig: Pick<ServerConfig, "environment"> | null | undefined,
): ServerSelfUpdateCapability | null {
  return serverConfig?.environment.capabilities.serverSelfUpdate ?? null;
}

/** The command to hand users whose server cannot update itself. */
export function manualServerUpdateCommand(targetVersion: string): string {
  return `npx t3@${targetVersion}`;
}

/** One sentence telling the user how to resolve version skew for a server,
    matched to the update path it offers. */
export function serverUpdateGuidance(
  capability: ServerSelfUpdateCapability | null,
  serverLabel: string,
): string {
  switch (capability) {
    case "boot-service":
    case "respawn":
      return `Update the ${serverLabel} so they stay in sync.`;
    case "desktop-managed":
      return `The ${serverLabel} is run by the T3 Code desktop app on its machine — update the desktop app there to sync them.`;
    default:
      return `Relaunch the ${serverLabel} with the copied command to sync them.`;
  }
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

export function appendVersionMismatchHint(
  message: string | null | undefined,
  mismatch: VersionMismatch | null | undefined,
): string | null {
  const normalizedMessage = normalizeVersion(message);
  if (!normalizedMessage) {
    return mismatch?.hint ?? null;
  }
  if (!mismatch) {
    return normalizedMessage;
  }
  return `${normalizedMessage} Hint: ${mismatch.hint}`;
}
