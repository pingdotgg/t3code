import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import {
  listConnectedTeams,
  resolveTeamNotificationSoundPreset,
} from "@t3tools/client-runtime/team";
import {
  DEFAULT_TEAM_NOTIFICATION_SOUND,
  TEAM_NOTIFICATION_SOUND_PRESETS,
  type TeamId,
  type TeamNotificationSoundPreset,
  type TeamWorkspace,
} from "@t3tools/contracts";
import { msg, T, useGT, useMessages } from "gt-react";
import { PlayIcon } from "lucide-react";

import { persistClientSettingsUpdate, useClientSettings } from "../../hooks/useSettings";
import { m as resolveMessage } from "../../i18n/messages";
import { useTeamStatesByEnvironment } from "../../state/team";
import { hasNotificationSound, previewTeamNotificationSound } from "../../threadNotifications";
import { SettingResetButton, SettingsRow } from "../settings/settingsLayout";
import { useSearchableSetting } from "../settings/settingsSearch";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "../ui/menu";
import { SelectButton } from "../ui/select";
import { toastManager } from "../ui/toast";

const soundOptionRowClassName = "grid grid-cols-[1fr_auto]";

const SOUND_PRESET_LABELS: Readonly<Record<TeamNotificationSoundPreset, string>> = {
  chime: msg("Chime", { $context: "name of a notification sound preset" }),
  bell: msg("Bell", { $context: "name of a notification sound preset" }),
  marimba: msg("Marimba", { $context: "name of a notification sound preset" }),
  pulse: msg("Pulse", { $context: "name of a notification sound preset" }),
  classic: msg("Classic (Personal)", {
    $context: "notification sound preset matching personal threads",
  }),
  off: msg("Off", { $context: "team notification sound turned off" }),
};

function reportTeamNotificationSoundSaveFailure(error: unknown): void {
  const title = resolveMessage(msg("Setting not saved"));
  toastManager.add({
    type: "error",
    title,
    description: thrownErrorMessage(error, resolveMessage) ?? title,
  });
}

function saveTeamNotificationSoundPreset(
  teamId: TeamId,
  preset: TeamNotificationSoundPreset,
): void {
  void persistClientSettingsUpdate((current) => ({
    ...current,
    teamNotificationSounds: {
      ...current.teamNotificationSounds,
      [teamId]: preset,
    },
  })).catch(reportTeamNotificationSoundSaveFailure);
}

function resetTeamNotificationSoundPreset(teamId: TeamId): void {
  void persistClientSettingsUpdate((current) => {
    if (!Object.hasOwn(current.teamNotificationSounds, teamId)) return current;
    const nextSounds = { ...current.teamNotificationSounds };
    delete nextSounds[teamId];
    return {
      ...current,
      teamNotificationSounds: nextSounds,
    };
  }).catch(reportTeamNotificationSoundSaveFailure);
}

function TeamSoundPresetLabel({
  preset,
  m,
}: {
  readonly preset: TeamNotificationSoundPreset;
  readonly m: ReturnType<typeof useMessages>;
}) {
  if (preset === DEFAULT_TEAM_NOTIFICATION_SOUND) {
    return (
      <T>
        Chime <span className="text-muted-foreground">(Default)</span>
      </T>
    );
  }
  return <>{m(SOUND_PRESET_LABELS[preset])}</>;
}

function TeamNotificationSoundControl({
  team,
  preset,
  testIdPrefix,
}: {
  readonly team: Pick<TeamWorkspace, "id" | "name">;
  readonly preset: TeamNotificationSoundPreset;
  readonly testIdPrefix: string;
}) {
  const gt = useGT();
  const m = useMessages();
  const presetDisplayLabel =
    preset === DEFAULT_TEAM_NOTIFICATION_SOUND
      ? gt("Chime (Default)")
      : m(SOUND_PRESET_LABELS[preset]);

  return (
    <div className="flex items-center gap-2">
      <Menu>
        <MenuTrigger
          aria-label={gt("Notification sound for {team}: {sound}", {
            team: team.name,
            sound: presetDisplayLabel,
          })}
          data-testid={`${testIdPrefix}-select-${team.id}`}
          render={<SelectButton size="sm" />}
          className="w-auto min-w-0"
        >
          <TeamSoundPresetLabel preset={preset} m={m} />
        </MenuTrigger>
        <MenuPopup align="end">
          <MenuRadioGroup
            value={preset}
            onValueChange={(value) => {
              if (TEAM_NOTIFICATION_SOUND_PRESETS.includes(value as TeamNotificationSoundPreset)) {
                saveTeamNotificationSoundPreset(team.id, value as TeamNotificationSoundPreset);
              }
            }}
          >
            {TEAM_NOTIFICATION_SOUND_PRESETS.map((option) =>
              option === "off" ? (
                <MenuRadioItem
                  key={option}
                  closeOnClick
                  value={option}
                  data-testid={`${testIdPrefix}-option-${option}`}
                >
                  <TeamSoundPresetLabel preset={option} m={m} />
                </MenuRadioItem>
              ) : (
                <div key={option} className={soundOptionRowClassName}>
                  <MenuRadioItem
                    closeOnClick
                    value={option}
                    data-testid={`${testIdPrefix}-option-${option}`}
                  >
                    <TeamSoundPresetLabel preset={option} m={m} />
                  </MenuRadioItem>
                  <MenuItem
                    aria-label={gt("Preview {sound}", { sound: m(SOUND_PRESET_LABELS[option]) })}
                    closeOnClick={false}
                    data-testid={`${testIdPrefix}-option-preview-${option}`}
                    onClick={() => void previewTeamNotificationSound(option)}
                  >
                    <PlayIcon />
                  </MenuItem>
                </div>
              ),
            )}
          </MenuRadioGroup>
        </MenuPopup>
      </Menu>
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={preset === "off"}
        aria-label={gt("Preview {team} notification sound", { team: team.name })}
        data-testid={`${testIdPrefix}-preview-${team.id}`}
        onClick={() => void previewTeamNotificationSound(preset)}
      >
        <PlayIcon />
        <T>Preview</T>
      </Button>
    </div>
  );
}

/** Per-team notification sound row rendered inside Settings → Teams for the selected team. */
export function TeamNotificationSoundRow({
  team,
}: {
  readonly team: Pick<TeamWorkspace, "id" | "name">;
}) {
  const gt = useGT();
  const { notificationMode, teamNotificationSounds } = useClientSettings((settings) => ({
    notificationMode: settings.notificationMode,
    teamNotificationSounds: settings.teamNotificationSounds,
  }));
  const preset = resolveTeamNotificationSoundPreset({
    teamId: team.id,
    teamNotificationSounds,
  });
  const isCustomized = preset !== DEFAULT_TEAM_NOTIFICATION_SOUND;

  return (
    <SettingsRow
      id="teams-notification-sound"
      devicePreference
      title={gt("Notification sound")}
      description={gt(
        "Distinct alert sound for threads in {team} (both remote and local team projects). Personal threads continue using the classic sound.",
        { team: team.name },
      )}
      status={
        !hasNotificationSound(notificationMode)
          ? gt("Thread notification sounds are currently off in General settings.")
          : undefined
      }
      resetAction={
        isCustomized ? (
          <SettingResetButton
            ariaLabel={gt("Reset {team} notification sound to default", { team: team.name })}
            onClick={() => resetTeamNotificationSoundPreset(team.id)}
          />
        ) : null
      }
      control={
        <TeamNotificationSoundControl
          team={team}
          preset={preset}
          testIdPrefix="team-settings-sound"
        />
      }
    />
  );
}

/**
 * Per-team notification sound controls rendered in Settings → General → Notifications.
 * Returns null when no team is connected so personal mode remains visually unchanged.
 */
export function ConnectedTeamsNotificationSoundSettings() {
  const gt = useGT();
  const searchableSetting = useSearchableSetting();
  const teamStates = useTeamStatesByEnvironment();
  const connectedTeams = listConnectedTeams(teamStates);
  const { notificationMode, teamNotificationSounds } = useClientSettings((settings) => ({
    notificationMode: settings.notificationMode,
    teamNotificationSounds: settings.teamNotificationSounds,
  }));

  if (connectedTeams.length === 0) {
    return null;
  }

  const mutedStatus = !hasNotificationSound(notificationMode)
    ? gt("Turn on thread notification sound above to hear team alerts automatically.")
    : undefined;

  if (connectedTeams.length === 1) {
    const { team } = connectedTeams[0]!;
    const preset = resolveTeamNotificationSoundPreset({
      teamId: team.id,
      teamNotificationSounds,
    });
    const isCustomized = preset !== DEFAULT_TEAM_NOTIFICATION_SOUND;

    return (
      <SettingsRow
        {...searchableSetting("team-notification-sounds")}
        devicePreference
        description={gt(
          "Sound played for {team} threads (distinct from personal thread alerts). Applies to this device.",
          { team: team.name },
        )}
        status={mutedStatus}
        resetAction={
          isCustomized ? (
            <SettingResetButton
              ariaLabel={gt("Reset {team} notification sound to default", { team: team.name })}
              onClick={() => resetTeamNotificationSoundPreset(team.id)}
            />
          ) : null
        }
        control={
          <TeamNotificationSoundControl
            team={team}
            preset={preset}
            testIdPrefix="notification-team-sound"
          />
        }
      />
    );
  }

  return (
    <SettingsRow
      {...searchableSetting("team-notification-sounds")}
      devicePreference
      description={gt(
        "Choose a distinct alert sound for each connected team (personal threads keep the classic sound). Applies to this device.",
      )}
      status={mutedStatus}
    >
      <div className="mt-2 space-y-2 pb-3" data-testid="notification-team-sounds-list">
        {connectedTeams.map(({ team }) => {
          const preset = resolveTeamNotificationSoundPreset({
            teamId: team.id,
            teamNotificationSounds,
          });
          const isCustomized = preset !== DEFAULT_TEAM_NOTIFICATION_SOUND;
          return (
            <div
              key={team.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border/60 px-3 py-2"
            >
              <div className="flex min-w-0 items-center gap-1.5">
                <p className="truncate text-sm font-medium text-foreground">{team.name}</p>
                {isCustomized ? (
                  <SettingResetButton
                    ariaLabel={gt("Reset {team} notification sound to default", {
                      team: team.name,
                    })}
                    onClick={() => resetTeamNotificationSoundPreset(team.id)}
                  />
                ) : null}
              </div>
              <TeamNotificationSoundControl
                team={team}
                preset={preset}
                testIdPrefix="notification-team-sound"
              />
            </div>
          );
        })}
      </div>
    </SettingsRow>
  );
}
