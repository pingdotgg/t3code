import { createTranslator, type TranslateFn } from "@t3tools/client-runtime/i18n";
import type { DesktopBridge, DesktopUpdateChannel, DesktopUpdateState } from "@t3tools/contracts";
import { acceptsTrackSwitchRelease } from "@t3tools/shared/cliRelease";

type TrackSwitchBridge = Pick<DesktopBridge, "setUpdateChannel">;

/** Saves the track, then, when this app must reinstall, finds a build the database check covers.
 * The saved track is the user's intent and stays even when no such build is ready yet: a track
 * saved toward Stable never offers an older build outside a guarded switch, and "Switch them"
 * retries. Saving when nothing reinstalls lets picking the old track undo a partial switch. */
export async function prepareLocalTrackSwitch(
  bridge: TrackSwitchBridge,
  input: {
    readonly channel: DesktopUpdateChannel;
    readonly version: string;
    readonly reinstall: boolean;
  },
  t: TranslateFn = createTranslator("en"),
): Promise<
  | { readonly ok: true; readonly local: DesktopUpdateState | null }
  | { readonly ok: false; readonly message: string }
> {
  let local: DesktopUpdateState;
  try {
    // A build on another track re-checks the feed, older releases allowed down to the checked one.
    local = await bridge.setUpdateChannel(
      input.channel,
      input.reinstall ? input.version : undefined,
    );
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : t("settings.system.track.trackNotChanged"),
    };
  }
  if (!input.reinstall) return { ok: true, local: null };
  const found = local.downloadedVersion ?? local.availableVersion;
  if (
    (local.status === "available" || local.status === "downloaded") &&
    found !== null &&
    acceptsTrackSwitchRelease(found, input.channel, input.version)
  ) {
    return { ok: true, local };
  }
  return {
    ok: false,
    message:
      found !== null
        ? t("settings.system.track.foundOlder", { found, version: input.version })
        : (local.message ?? t("settings.system.track.foundNone", { version: input.version })),
  };
}

/**
 * Whether this app stays put while connected machines move: its updater is off, as for a .deb
 * install or without a feed. Off only because a policy rules out its nightly channel, it moves.
 */
export function localUpdaterStaysPut(
  state: Pick<DesktopUpdateState, "enabled" | "channelBlockedByPolicy"> | null | undefined,
  target: DesktopUpdateChannel,
): boolean {
  return (
    state?.enabled === false && !(target === "latest" && state.channelBlockedByPolicy === true)
  );
}
