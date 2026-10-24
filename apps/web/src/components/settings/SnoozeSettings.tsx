import { useState } from "react";
import * as Schema from "effect/Schema";
import {
  DEFAULT_SNOOZE_PRESETS,
  MAX_SNOOZE_HOURS,
  SNOOZE_ABSOLUTE_DAYS,
  SnoozeDay,
  type SnoozePresetSetting,
  SnoozeTime,
} from "@t3tools/contracts/settings";
import { Input } from "../ui/input";
import {
  NumberField,
  NumberFieldDecrement,
  NumberFieldGroup,
  NumberFieldIncrement,
  NumberFieldInput,
} from "../ui/number-field";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";
import { SettingResetButton } from "./settingsLayout";
import { FoldedSettingsSection } from "./FoldedSettingsSection";

const isSnoozeTime = Schema.is(SnoozeTime);
const isSnoozeDay = Schema.is(SnoozeDay);

function SnoozeTimeInput({
  label,
  value,
  onCommit,
}: {
  label: string;
  value: string;
  onCommit: (time: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  const [draftSource, setDraftSource] = useState(value);
  if (draftSource !== value) {
    setDraftSource(value);
    setDraft(value);
  }

  return (
    <Input
      size="sm"
      type="time"
      aria-label={label}
      value={draft}
      onChange={(event) => {
        const time = event.target.value;
        setDraft(time);
        if (isSnoozeTime(time)) onCommit(time);
      }}
      onBlur={() => setDraft(value)}
    />
  );
}

function SnoozeSlotEditor({
  slot,
  index,
  onChange,
}: {
  slot: SnoozePresetSetting;
  index: number;
  onChange: (slot: SnoozePresetSetting) => void;
}) {
  const label = `Snooze slot ${index + 1}`;
  return (
    <div
      role="group"
      aria-label={label}
      className="flex min-w-0 flex-wrap items-center justify-between gap-3 px-3 py-2.5 sm:px-4"
    >
      <div className="w-28 shrink-0">
        <Select
          value={slot.mode}
          onValueChange={(mode) => {
            if (mode === slot.mode) return;
            if (mode === "relative") onChange({ mode, hours: 1 });
            if (mode === "absolute") onChange({ mode, day: "tomorrow", time: "09:00" });
          }}
        >
          <SelectTrigger variant="ghost" size="sm" className="w-full" aria-label={`${label} mode`}>
            <SelectValue>{slot.mode === "relative" ? "Relative" : "Absolute"}</SelectValue>
          </SelectTrigger>
          <SelectPopup alignItemWithTrigger={false}>
            <SelectItem value="relative">Relative</SelectItem>
            <SelectItem value="absolute">Absolute</SelectItem>
          </SelectPopup>
        </Select>
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-3">
        {slot.mode === "relative" ? (
          <div className="flex shrink-0 items-center gap-2">
            <div className="w-32">
              <NumberField
                size="sm"
                value={slot.hours}
                min={1}
                max={MAX_SNOOZE_HOURS}
                step={1}
                onValueChange={(value) => {
                  if (
                    value !== null &&
                    Number.isInteger(value) &&
                    value >= 1 &&
                    value <= MAX_SNOOZE_HOURS
                  ) {
                    onChange({ ...slot, hours: value });
                  }
                }}
              >
                <NumberFieldGroup>
                  <NumberFieldDecrement aria-label={`Decrease ${label.toLowerCase()} hours`} />
                  <NumberFieldInput aria-label={`${label} hours`} />
                  <NumberFieldIncrement aria-label={`Increase ${label.toLowerCase()} hours`} />
                </NumberFieldGroup>
              </NumberField>
            </div>
            <span className="text-xs text-muted-foreground">hours</span>
          </div>
        ) : (
          <>
            <div className="w-36">
              <Select
                value={slot.day}
                onValueChange={(day) => {
                  if (isSnoozeDay(day)) onChange({ ...slot, day });
                }}
              >
                <SelectTrigger size="sm" aria-label={`${label} day`}>
                  <SelectValue>
                    {(day: string) => day.charAt(0).toUpperCase() + day.slice(1)}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  {SNOOZE_ABSOLUTE_DAYS.map((day) => (
                    <SelectItem key={day} value={day}>
                      {day.charAt(0).toUpperCase() + day.slice(1)}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </div>
            <span className="text-xs text-muted-foreground">at</span>
            <div className="w-32">
              <SnoozeTimeInput
                label={`${label} time`}
                value={slot.time}
                onCommit={(time) => onChange({ ...slot, time })}
              />
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export function SnoozeSettings() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const preferences = settings.snoozePreferences ?? DEFAULT_SNOOZE_PRESETS;

  return (
    <FoldedSettingsSection
      id="snooze-presets"
      title="Snooze"
      headerPlacement="outside"
      control={
        settings.snoozePreferences !== null ? (
          <SettingResetButton
            label="snooze presets"
            onClick={() => updateSettings({ snoozePreferences: null })}
          />
        ) : null
      }
    >
      {[0, 1, 2, 3, 4].map((index) => (
        <SnoozeSlotEditor
          key={index}
          slot={preferences[index]!}
          index={index}
          onChange={(next) =>
            updateSettings({
              snoozePreferences: preferences.map((current, currentIndex) =>
                currentIndex === index ? next : current,
              ),
            })
          }
        />
      ))}
      <p className="px-3 py-2.5 text-xs text-muted-foreground sm:px-4">
        Presets stay in this order and use your local time zone.
      </p>
    </FoldedSettingsSection>
  );
}
