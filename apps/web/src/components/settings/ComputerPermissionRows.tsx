import type { EnvironmentId } from "@t3tools/contracts";

/**
 * The desktop-only part of Settings → Computer use: the per-environment offer, and the macOS
 * grants the helper needs.
 *
 * Phase D fills this in from the desktop bridge. The web build has no bridge to read, so it
 * renders nothing.
 */
export function ComputerPermissionRows({
  environmentId: _environmentId,
}: {
  readonly environmentId: EnvironmentId | null;
}): null {
  return null;
}
