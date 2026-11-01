import type {
  DesktopAppBranding,
  DesktopAppStageLabel,
  DesktopDiscordPresence,
  DiscordPresenceField,
} from "@t3tools/contracts";

import type { DiscordActivity } from "./discordIpc.ts";

/** Discord truncates the details/state/large_text lines at 128 characters. */
const MAX_TEXT_LENGTH = 128;

/**
 * Which build channel this app is, so the presence shows the matching uploaded
 * art and labels itself accurately. `version` is the app version string.
 */
export interface DiscordPresenceBranding {
  readonly assetKey: string;
  readonly label: string;
  readonly version: string;
}

export const DEFAULT_DISCORD_PRESENCE_BRANDING: DiscordPresenceBranding = {
  assetKey: "black",
  label: "T3 Code",
  version: "",
};

const ASSET_KEY_BY_STAGE: Readonly<Record<DesktopAppStageLabel, string>> = {
  Dev: "blueprint",
  Nightly: "nightly",
  Alpha: "black",
  Beta: "black",
};

/** Stage label maps to the asset key uploaded to the Discord application. */
export function resolveDiscordPresenceBranding(input: {
  readonly branding: DesktopAppBranding;
  readonly appVersion: string;
}): DiscordPresenceBranding {
  return {
    assetKey: ASSET_KEY_BY_STAGE[input.branding.stageLabel],
    label: input.branding.displayName,
    version: input.appVersion,
  };
}

const clampText = (value: string): string =>
  value.length <= MAX_TEXT_LENGTH ? value : `${value.slice(0, MAX_TEXT_LENGTH - 1)}…`;

export function discordPresenceStateLine(presence: DesktopDiscordPresence): string {
  if (presence.workingThreads > 0) {
    return presence.workingThreads === 1
      ? "Running an agent"
      : `Running ${presence.workingThreads} agents`;
  }
  if (presence.attentionThreads > 0) {
    return presence.attentionThreads === 1
      ? "Waiting for you"
      : `${presence.attentionThreads} threads need you`;
  }
  return "Idle";
}

export function discordActivityForPresence(
  presence: DesktopDiscordPresence,
  sessionStartedAtMs: number,
  fields: ReadonlyArray<DiscordPresenceField>,
  branding: DiscordPresenceBranding,
): DiscordActivity {
  const details =
    fields.includes("project") && presence.projectName !== null
      ? `In ${presence.projectName}`
      : null;
  const stateTokens: string[] = [];
  if (fields.includes("model") && presence.modelLabel !== null) {
    stateTokens.push(presence.modelLabel);
  }
  if (fields.includes("activity")) {
    stateTokens.push(discordPresenceStateLine(presence));
  }
  return {
    ...(details === null ? {} : { details: clampText(details) }),
    ...(stateTokens.length === 0 ? {} : { state: clampText(stateTokens.join(" · ")) }),
    ...(fields.includes("elapsed") ? { timestamps: { start: sessionStartedAtMs } } : {}),
    assets: {
      large_image: branding.assetKey,
      // The hover tooltip is the one place the build channel and version are
      // legible: the activity image only shows the channel glyph.
      large_text: clampText(`${branding.label} ${branding.version}`.trim()),
    },
  };
}
