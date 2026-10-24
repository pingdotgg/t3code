import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { DateTimePicker } from "@expo/ui/community/datetime-picker";
import {
  DEFAULT_SNOOZE_PRESETS,
  MAX_SNOOZE_HOURS,
  SNOOZE_ABSOLUTE_DAYS,
  type SnoozePresetSetting,
} from "@t3tools/contracts/settings";
import { AsyncResult } from "effect/reactivity";
import { useState } from "react";
import { Platform, Pressable, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { NumberField } from "../../components/ui/NumberField";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import { SettingsSection } from "./components/SettingsSection";
import { Menu } from "../../components/ui/Menu";
import { Button } from "../../components/ui/Button";
import { SymbolView } from "../../components/ui/AppSymbol";

function SnoozeTimeRow(props: {
  readonly label: string;
  readonly accessibilityLabel: string;
  readonly value: string;
  readonly disabled: boolean;
  readonly onValueChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [hours, minutes] = props.value.split(":").map(Number);
  const date = new Date(2000, 0, 1, hours, minutes);
  return (
    <View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={props.accessibilityLabel}
        accessibilityState={{ disabled: props.disabled }}
        disabled={props.disabled}
        onPress={() => setOpen((value) => !value)}
        className="min-h-10 flex-row items-center gap-2"
      >
        <Text textRole="footnote" className="text-foreground-muted">
          {props.label}
        </Text>
        <Text className="text-base text-foreground-muted">
          {date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
        </Text>
      </Pressable>
      {open && !props.disabled ? (
        <DateTimePicker
          value={date}
          mode="time"
          display={Platform.OS === "ios" ? "spinner" : "default"}
          onDismiss={() => setOpen(false)}
          onValueChange={(_, selected) => {
            props.onValueChange(
              `${String(selected.getHours()).padStart(2, "0")}:${String(selected.getMinutes()).padStart(2, "0")}`,
            );
            if (Platform.OS === "android") setOpen(false);
          }}
        />
      ) : null}
    </View>
  );
}

function SnoozeSlotEditor(props: {
  readonly slot: SnoozePresetSetting;
  readonly index: number;
  readonly disabled: boolean;
  readonly onChange: (slot: SnoozePresetSetting) => void;
}) {
  const { slot, disabled, onChange } = props;
  const label = `Snooze slot ${props.index + 1}`;
  return (
    <View
      className="flex-row items-center justify-between gap-3 border-t border-border-subtle px-4 py-2"
      pointerEvents={disabled ? "none" : "auto"}
      accessibilityState={{ disabled }}
    >
      <Menu
        actions={[
          { id: "relative", title: "Relative", state: slot.mode === "relative" ? "on" : "off" },
          { id: "absolute", title: "Absolute", state: slot.mode === "absolute" ? "on" : "off" },
        ]}
        onPressAction={({ nativeEvent }) => {
          const mode = nativeEvent.event;
          if (disabled || mode === slot.mode) return;
          if (mode === "relative") onChange({ mode, hours: 1 });
          if (mode === "absolute") onChange({ mode, day: "tomorrow", time: "09:00" });
        }}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${label} mode`}
          disabled={disabled}
          className="min-h-11 flex-row items-center gap-2"
        >
          <Text textRole="body" className="text-foreground">
            {slot.mode === "relative" ? "Relative" : "Absolute"}
          </Text>
          <SymbolView name="chevron.down" size={10} tintColorClassName="accent-chevron" />
        </Pressable>
      </Menu>
      <View className="gap-1">
        {slot.mode === "relative" ? (
          <View className="flex-row items-center justify-end gap-2">
            <NumberField
              label={`${label} hours`}
              min={1}
              max={MAX_SNOOZE_HOURS}
              value={slot.hours}
              disabled={disabled}
              onValueChange={(hours) => onChange({ ...slot, hours })}
            />
            <Text textRole="footnote" className="w-10 text-foreground-muted">
              hours
            </Text>
          </View>
        ) : (
          <>
            <Menu
              actions={SNOOZE_ABSOLUTE_DAYS.map((day) => ({
                id: day,
                title: day.charAt(0).toUpperCase() + day.slice(1),
                state: day === slot.day ? "on" : "off",
              }))}
              onPressAction={({ nativeEvent }) => {
                const day = SNOOZE_ABSOLUTE_DAYS.find(
                  (candidate) => candidate === nativeEvent.event,
                );
                if (!disabled && day) onChange({ ...slot, day });
              }}
            >
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`${label} day: ${slot.day}`}
                disabled={disabled}
                className="min-h-10 flex-row items-center justify-end gap-2"
              >
                <Text textRole="body" className="text-foreground">
                  {slot.day.charAt(0).toUpperCase() + slot.day.slice(1)}
                </Text>
                <SymbolView name="chevron.down" size={10} tintColorClassName="accent-chevron" />
              </Pressable>
            </Menu>
            <SnoozeTimeRow
              label="at"
              accessibilityLabel={`${label} time`}
              value={slot.time}
              disabled={disabled}
              onValueChange={(time) => onChange({ ...slot, time })}
            />
          </>
        )}
      </View>
    </View>
  );
}

export function SnoozeSettingsSection() {
  const [open, setOpen] = useState(false);
  const result = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const ready = AsyncResult.isSuccess(result) && !result.waiting;
  const customPreferences = AsyncResult.isSuccess(result)
    ? (result.value.snoozePreferences ?? null)
    : null;
  const preferences = customPreferences ?? DEFAULT_SNOOZE_PRESETS;
  const updateSlot = (index: number, slot: SnoozePresetSetting) =>
    savePreferences({
      transform: (current) => ({
        snoozePreferences: (current.snoozePreferences ?? DEFAULT_SNOOZE_PRESETS).map(
          (value, currentIndex) => (currentIndex === index ? slot : value),
        ),
      }),
    });

  return (
    <SettingsSection title="Snooze">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Snooze presets"
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen((value) => !value)}
        className="min-h-14 flex-row items-center justify-between gap-4 px-4 py-3"
      >
        <Text className="text-lg text-foreground android:text-base">Snooze presets</Text>
        <Text className="text-base text-foreground-muted">{open ? "Hide" : "Edit"}</Text>
      </Pressable>
      {open ? (
        <View className="gap-3">
          <View>
            {[0, 1, 2, 3, 4].map((index) => (
              <SnoozeSlotEditor
                key={index}
                slot={preferences[index]!}
                index={index}
                disabled={!ready}
                onChange={(value) => updateSlot(index, value)}
              />
            ))}
            {customPreferences !== null ? (
              <View className="px-4 py-3">
                <Button
                  label="Restore defaults"
                  tone="secondary"
                  disabled={!ready}
                  onPress={() => savePreferences({ snoozePreferences: null })}
                />
              </View>
            ) : null}
          </View>
          <Text textRole="footnote" className="px-4 pb-3 text-foreground-muted">
            Presets stay in this order and use your local time zone.
          </Text>
        </View>
      ) : null}
    </SettingsSection>
  );
}
