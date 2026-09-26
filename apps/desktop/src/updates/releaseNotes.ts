import type { DesktopUpdateChannel } from "@t3tools/contracts";
import { normalizeReleaseNotes, type NormalizedReleaseNotes } from "@t3tools/shared/releaseNotes";

import { resolveDefaultDesktopUpdateChannel } from "./updateChannels.ts";

/**
 * Turns electron-updater's release notes into the groups the popover shows.
 * With `fullChangelog` on (nightly), electron-updater collects every GitHub
 * release whose version is semver-greater than the running one, whatever
 * train it belongs to; a maintainers' `-preview.` cut sorts above every
 * `-nightly.` of the same base version and would lead the list. Only
 * releases on the channel being followed are kept, the same test the
 * updater applies to the offered version itself.
 */
export function normalizeDesktopUpdateReleaseNotes(
  releaseNotes: unknown,
  fallbackVersion: string,
  channel: DesktopUpdateChannel,
): NormalizedReleaseNotes {
  return normalizeReleaseNotes(
    releaseNotes,
    fallbackVersion,
    (version) => resolveDefaultDesktopUpdateChannel(version) === channel,
  );
}
