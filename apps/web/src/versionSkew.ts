import type { EnvironmentId, ServerConfig, ServerSelfUpdateCapability } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { APP_VERSION } from "./branding";
import type { HostedAppChannel } from "./hostedPairing";
import { getLocalStorageItem, setLocalStorageItem } from "./hooks/useLocalStorage";

export interface VersionMismatch {
  readonly clientVersion: string;
  readonly serverVersion: string;
  readonly hint: string;
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

export const DESKTOP_UPDATE_TRACK_DESCRIPTION =
  "Stable corresponds to hosted Latest. Nightly corresponds to hosted Nightly.";

export const HOSTED_UPDATE_TRACK_DESCRIPTION =
  "Latest corresponds to Desktop Stable. Nightly corresponds to Desktop Nightly.";

export interface DesktopManagedUpdateGuidance {
  readonly guidance: string;
  readonly actionHint: string;
}

/** Channel-aware copy for desktop-managed servers so hosted web and desktop
    release-track naming stays explicit. */
export function resolveDesktopManagedUpdateGuidance(
  serverLabel: string,
  hostedAppChannel: HostedAppChannel | null,
): DesktopManagedUpdateGuidance {
  switch (hostedAppChannel) {
    case "nightly":
      return {
        guidance:
          "This web app is on Nightly, which corresponds to Desktop Nightly. Choose corresponding tracks on web and desktop, then update the desktop app if versions still differ.",
        actionHint:
          "Nightly corresponds to Desktop Nightly. Choose corresponding tracks, then update the desktop app if versions still differ.",
      };
    case "latest":
      return {
        guidance:
          "This web app is on Latest, which corresponds to Desktop Stable. Choose corresponding tracks on web and desktop, then update the desktop app if versions still differ.",
        actionHint:
          "Latest corresponds to Desktop Stable. Choose corresponding tracks, then update the desktop app if versions still differ.",
      };
    default:
      return {
        guidance: `The ${serverLabel} is run by the T3 Code desktop app on its machine — update the desktop app there to sync them.`,
        actionHint: "Update the desktop app on that machine to update this server.",
      };
  }
}

/** One sentence telling the user how to resolve version skew for a server,
    matched to the update path it offers. */
export function serverUpdateGuidance(
  capability: ServerSelfUpdateCapability | null,
  serverLabel: string,
  hostedAppChannel: HostedAppChannel | null = null,
): string {
  switch (capability) {
    case "boot-service":
    case "respawn":
      return `Update the ${serverLabel} so they stay in sync.`;
    case "desktop-managed":
      return resolveDesktopManagedUpdateGuidance(serverLabel, hostedAppChannel).guidance;
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
