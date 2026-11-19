import type {
  NotificationJingleId,
  NotificationSoundEvent,
  NotificationSoundSettings as SoundSettings,
} from "@t3tools/contracts";
import { PlayIcon } from "lucide-react";
import type { CSSProperties } from "react";

import { updateClientSettings, useClientSettings } from "../../hooks/useSettings";
import { NOTIFICATION_JINGLES, jingleSpec } from "../../notificationJingles";
import {
  hasNotificationSound,
  isDoNotDisturbActive,
  previewNotificationJingle,
} from "../../threadNotifications";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { SettingsRow } from "./settingsLayout";
import { useSearchableSetting } from "./settingsSearch";

const EVENT_LABELS: Record<NotificationSoundEvent, { title: string; description: string }> = {
  completion: { title: "Session finished", description: "An agent finished its turn." },
  input: { title: "Input needed", description: "An agent asked you a question." },
  approval: { title: "Permission requested", description: "An agent needs your approval." },
  "long-operation": {
    title: "Long operation finished",
    description: "A run that took longer than the threshold below finished.",
  },
  error: { title: "Important error", description: "A session failed or hit a usage limit." },
};

const DND_DURATIONS = [
  { value: "forever", label: "Until I turn it off" },
  { value: "60", label: "For 1 hour" },
  { value: "240", label: "For 4 hours" },
  { value: "tomorrow", label: "Until tomorrow 8:00" },
] as const;

function dndUntil(value: (typeof DND_DURATIONS)[number]["value"], now = new Date()): string | null {
  if (value === "forever") return null;
  if (value === "tomorrow") {
    const next = new Date(now);
    next.setDate(next.getDate() + 1);
    next.setHours(8, 0, 0, 0);
    return next.toISOString();
  }
  return new Date(now.getTime() + Number(value) * 60_000).toISOString();
}

function patchSounds(current: SoundSettings, patch: Partial<SoundSettings>) {
  void updateClientSettings({ notificationSounds: { ...current, ...patch } });
}

export function NotificationSoundSettings() {
  const searchableSetting = useSearchableSetting();
  const sound = useClientSettings((settings) => settings.notificationSounds);
  const mode = useClientSettings((settings) => settings.notificationMode);
  const soundsOn = hasNotificationSound(mode);
  const dndActive = isDoNotDisturbActive(sound);
  const sliderStyle = {
    "--settings-slider-progress": `${sound.volume * 100}%`,
    "--settings-slider-fill-offset": `${0.5 - sound.volume}rem`,
  } as CSSProperties;

  return (
    <>
      <SettingsRow
        {...searchableSetting("notification-sound-volume")}
        description={
          soundsOn
            ? "How loud notification jingles play. Jingles are synthesized on this device."
            : 'Choose "Sound only" or "Notifications with sound" above to hear jingles.'
        }
        control={
          <div className="flex w-full items-center gap-3 sm:w-56">
            <output
              className="min-w-12 rounded-md bg-muted px-2 py-1 text-center font-mono text-xs font-medium tabular-nums"
              htmlFor="notification-sound-volume"
            >
              {Math.round(sound.volume * 100)}%
            </output>
            <input
              aria-label="Notification volume"
              className="settings-slider min-w-0 flex-1"
              id="notification-sound-volume"
              min={0}
              max={100}
              step={5}
              style={sliderStyle}
              type="range"
              value={Math.round(sound.volume * 100)}
              onChange={(event) =>
                patchSounds(sound, { volume: Number(event.currentTarget.value) / 100 })
              }
            />
            <Switch
              aria-label="Mute notification sounds"
              checked={!sound.muted}
              onCheckedChange={(checked) => patchSounds(sound, { muted: !checked })}
            />
          </div>
        }
      />
      <SettingsRow
        {...searchableSetting("notification-do-not-disturb")}
        description={
          dndActive
            ? sound.doNotDisturbUntil
              ? `On until ${new Date(sound.doNotDisturbUntil).toLocaleString()}. Sounds and desktop notifications are silenced.`
              : "On. Sounds and desktop notifications are silenced."
            : "Silence sounds and desktop notifications. Badges still update."
        }
        control={
          <div className="flex items-center gap-2">
            {dndActive ? (
              <Button
                size="sm"
                variant="outline"
                onClick={() => patchSounds(sound, { doNotDisturb: false, doNotDisturbUntil: null })}
              >
                Turn off
              </Button>
            ) : (
              <Select
                value=""
                onValueChange={(value) => {
                  const duration = DND_DURATIONS.find((entry) => entry.value === value);
                  if (duration) {
                    patchSounds(sound, {
                      doNotDisturb: true,
                      doNotDisturbUntil: dndUntil(duration.value),
                    });
                  }
                }}
              >
                <SelectTrigger size="sm" className="w-48" aria-label="Turn on Do Not Disturb">
                  <SelectValue>Turn on…</SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  {DND_DURATIONS.map((entry) => (
                    <SelectItem key={entry.value} hideIndicator value={entry.value}>
                      {entry.label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            )}
          </div>
        }
      />
      {(Object.keys(EVENT_LABELS) as NotificationSoundEvent[]).map((event) => (
        <SoundEventRow key={event} event={event} sound={sound} />
      ))}
      <SettingsRow
        {...searchableSetting("notification-long-operation")}
        description="Runs at least this long play the long-operation sound instead of the finished one."
        control={
          <Select
            value={String(sound.longOperationMinutes)}
            onValueChange={(value) => patchSounds(sound, { longOperationMinutes: Number(value) })}
          >
            <SelectTrigger size="sm" className="w-32" aria-label="Long operation threshold">
              <SelectValue>{sound.longOperationMinutes} min</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {[1, 2, 5, 10, 15, 30, 60].map((minutes) => (
                <SelectItem key={minutes} hideIndicator value={String(minutes)}>
                  {minutes} min
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
    </>
  );
}

function SoundEventRow(props: {
  readonly event: NotificationSoundEvent;
  readonly sound: SoundSettings;
}) {
  const { event, sound } = props;
  const setting = sound.events[event];
  const update = (patch: Partial<typeof setting>) =>
    patchSounds(sound, { events: { ...sound.events, [event]: { ...setting, ...patch } } });
  return (
    <SettingsRow
      id={`notification-sound-${event}`}
      title={EVENT_LABELS[event].title}
      description={EVENT_LABELS[event].description}
      control={
        <div className="flex items-center gap-2">
          <Select
            value={setting.jingle}
            disabled={!setting.enabled}
            onValueChange={(value) => {
              const jingle = NOTIFICATION_JINGLES.find((entry) => entry.id === value);
              if (jingle) {
                update({ jingle: jingle.id });
                previewNotificationJingle(jingle.id, sound.volume);
              }
            }}
          >
            <SelectTrigger
              size="sm"
              className="w-44"
              aria-label={`${EVENT_LABELS[event].title} sound`}
            >
              <SelectValue>{jingleSpec(setting.jingle).label}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {NOTIFICATION_JINGLES.map((jingle) => (
                <SelectItem key={jingle.id} hideIndicator value={jingle.id}>
                  <span className="flex flex-col">
                    <span>{jingle.label}</span>
                    <span className="text-muted-foreground text-xs">{jingle.description}</span>
                  </span>
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={`Preview ${jingleSpec(setting.jingle).label}`}
            onClick={() =>
              previewNotificationJingle(setting.jingle as NotificationJingleId, sound.volume)
            }
          >
            <PlayIcon />
          </Button>
          <Switch
            aria-label={`Play a sound for ${EVENT_LABELS[event].title}`}
            checked={setting.enabled}
            onCheckedChange={(checked) => update({ enabled: checked })}
          />
        </div>
      }
    />
  );
}
