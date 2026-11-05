import {
  managedNightlyDeniedMessage,
  managedUpdatesMessage,
  type ManagedPolicyDocument,
} from "@t3tools/contracts";
import type { CliReleaseChannel } from "@t3tools/shared/cliRelease";

/**
 * Why the managed policy refuses an update a user or maintainer asked for, or `undefined` when it
 * allows it. The server never updates on its own, so `auto` allows every explicit request.
 * Pass `targetChannel` when the caller picks the release; the desktop app gates its own channel.
 */
export function managedUpdateRefusal(
  document: ManagedPolicyDocument | undefined,
  targetChannel?: CliReleaseChannel,
): string | undefined {
  const updates = document?.limits?.updates;
  if (document === undefined || updates === undefined) return undefined;
  if (updates.mode === "off") return managedUpdatesMessage(document.organization);
  if (updates.allowNightly === false && targetChannel !== undefined && targetChannel !== "stable") {
    return managedNightlyDeniedMessage(document.organization);
  }
  return undefined;
}
