import { SegmentedControl } from "../../components/ui/SegmentedControl";
import {
  BasicAlertDialog,
  Column,
  DateTimePicker,
  Host,
  FilledTonalIconButton,
  OutlinedTextField,
  Row,
  RNHostView,
  Shape,
  Surface,
  Text,
  TextButton,
  useNativeState,
} from "@expo/ui/jetpack-compose";
import {
  padding,
  size,
  width,
  fillMaxWidth,
  testID,
  verticalScroll,
} from "@expo/ui/jetpack-compose/modifiers";
import {
  localSnoozeDate,
  localSnoozeTime,
  type CustomSnoozeInput,
} from "@lathe/client-runtime/state/thread-settled";
import { SNOOZE_REMINDER_MAX_CHARS } from "@lathe/contracts";
import { requireNativeModule } from "expo";
import { msg, useGT, useMessages } from "gt-react-native";
import { useEffect, useState } from "react";
import { AppState, useWindowDimensions } from "react-native";

import { OverlayPortal } from "../../components/ui/OverlayPortal";
import { useFormattingLocale } from "../../i18n/I18nProvider";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import { useScaledTextRole } from "../settings/appearance/useScaledTextRole";
import type { CustomSnoozeSheetProps } from "./CustomSnoozeSheet";
import {
  applySnoozePickerDate,
  applySnoozePickerTime,
  initialCustomSnoozeDate,
  resolveSheetSnoozedUntil,
  snoozeDateToPickerDate,
  snoozePickerLabels,
} from "./customSnoozeDate";

const roundedCorner = Shape.RoundedCorner;

const modes = [
  { value: "date", label: msg("Date and time") },
  { value: "duration", label: msg("Duration") },
] as const;
const units = [
  { value: "minutes", label: msg("Minutes") },
  { value: "hours", label: msg("Hours") },
  { value: "days", label: msg("Days") },
] as const;

function systemUses24HourClock() {
  return requireNativeModule<{ is24HourFormat(): boolean }>("T3NativeControls").is24HourFormat();
}

export function CustomSnoozeSheet(props: CustomSnoozeSheetProps) {
  const gt = useGT();
  const m = useMessages();
  const locale = useFormattingLocale();
  const { themeAppearance, themeVariables: colors } = useAppearancePreferences();
  const [is24Hour, setIs24Hour] = useState(systemUses24HourClock);
  // oxlint-disable-next-line lathe/no-unreasoned-state-sync -- subscribes to AppState to re-read the native 24-hour clock setting when the app resumes
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") setIs24Hour(systemUses24HourClock());
    });
    return () => subscription.remove();
  }, []);
  const titleTypography = useScaledTextRole("title");
  const bodyTypography = useScaledTextRole("footnote");
  const inputTypography = useScaledTextRole("body");
  const { width: windowWidth } = useWindowDimensions();
  const [mode, setMode] = useState<CustomSnoozeInput["mode"]>("date");
  const [date, setDate] = useState(() =>
    initialCustomSnoozeDate(props.initialSnoozedUntil, new Date()),
  );
  const reminderText = useNativeState(props.reminder?.initialValue ?? "");
  const [picker, setPicker] = useState<"date" | "time">("date");
  const [amount, setAmount] = useState(2);
  const [unit, setUnit] = useState<"minutes" | "hours" | "days">("hours");
  const [error, setError] = useState<string | null>(null);
  const pickerLabels = snoozePickerLabels(date, locale, is24Hour);
  const submit = () => {
    const input: CustomSnoozeInput =
      mode === "date"
        ? { mode, date: localSnoozeDate(date), time: localSnoozeTime(date) }
        : { mode, amount: String(amount), unit };
    const snoozedUntil = resolveSheetSnoozedUntil(input, props.initialSnoozedUntil, new Date());
    if (!snoozedUntil) {
      setError(
        mode === "date"
          ? gt("Choose a date and time in the future.")
          : gt("Enter a positive duration."),
      );
      return;
    }
    props.onSnooze(snoozedUntil, props.reminder ? reminderText.get() : undefined);
    props.onClose();
  };
  const pickerColors = {
    containerColor: colors["--color-card-alt"],
    titleContentColor: colors["--color-foreground-secondary"],
    headlineContentColor: colors["--color-foreground"],
    weekdayContentColor: colors["--color-foreground-secondary"],
    subheadContentColor: colors["--color-foreground"],
    navigationContentColor: colors["--color-foreground"],
    yearContentColor: colors["--color-foreground"],
    dayContentColor: colors["--color-foreground"],
    currentYearContentColor: colors["--color-primary"],
    selectedYearContainerColor: colors["--color-primary"],
    selectedYearContentColor: colors["--color-primary-foreground"],
    selectedDayContainerColor: colors["--color-primary"],
    selectedDayContentColor: colors["--color-primary-foreground"],
    todayContentColor: colors["--color-primary"],
    todayDateBorderColor: colors["--color-primary"],
    dividerColor: colors["--color-border"],
    clockDialColor: colors["--color-secondary"],
    clockDialSelectedContentColor: colors["--color-primary-foreground"],
    clockDialUnselectedContentColor: colors["--color-secondary-foreground"],
    selectorColor: colors["--color-primary"],
    periodSelectorSelectedContainerColor: colors["--color-secondary"],
    periodSelectorSelectedContentColor: colors["--color-secondary-foreground"],
    periodSelectorUnselectedContentColor: colors["--color-foreground"],
    timeSelectorSelectedContainerColor: colors["--color-secondary"],
    timeSelectorSelectedContentColor: colors["--color-secondary-foreground"],
    timeSelectorUnselectedContainerColor: colors["--color-card"],
    timeSelectorUnselectedContentColor: colors["--color-foreground"],
  };
  return (
    // Recycled thread rows can detach a zero-sized native dialog host.
    <OverlayPortal>
      <Host colorScheme={themeAppearance} style={{ height: 0, width: 0 }}>
        <BasicAlertDialog
          onDismissRequest={props.onClose}
          properties={{ usePlatformDefaultWidth: false }}
          modifiers={[width(Math.min(360, windowWidth - 32))]}
        >
          <Surface
            color={colors["--color-card-alt"]}
            contentColor={colors["--color-foreground"]}
            shape={roundedCorner({
              cornerRadii: { topStart: 28, topEnd: 28, bottomStart: 28, bottomEnd: 28 },
            })}
          >
            <Column modifiers={[fillMaxWidth(), verticalScroll()]}>
              <Column
                verticalArrangement={{ spacedBy: 16 }}
                modifiers={[fillMaxWidth(), padding(24, 24, 24, 16)]}
              >
                <Text style={titleTypography}>{gt("Custom snooze")}</Text>
                <RNHostView matchContents={{ vertical: true }} modifiers={[fillMaxWidth()]}>
                  <SegmentedControl
                    variant="card"
                    options={modes.map((option) => ({ ...option, label: m(option.label) }))}
                    selected={mode}
                    onSelect={(value) => {
                      setMode(value);
                      setError(null);
                    }}
                  />
                </RNHostView>
                {mode === "date" ? (
                  <RNHostView matchContents={{ vertical: true }} modifiers={[fillMaxWidth()]}>
                    <SegmentedControl
                      variant="card"
                      options={[
                        { value: "date", label: pickerLabels.date },
                        { value: "time", label: pickerLabels.time },
                      ]}
                      selected={picker}
                      onSelect={setPicker}
                    />
                  </RNHostView>
                ) : null}
              </Column>
              {mode === "date" ? (
                <Column horizontalAlignment="center" modifiers={[fillMaxWidth()]}>
                  <SnoozeDateTimePicker
                    key={picker}
                    date={date}
                    picker={picker}
                    is24Hour={is24Hour}
                    colors={pickerColors}
                    onChange={(selected) => {
                      setDate((current) =>
                        picker === "date"
                          ? applySnoozePickerDate(current, selected)
                          : applySnoozePickerTime(current, selected),
                      );
                      setError(null);
                    }}
                  />
                </Column>
              ) : (
                <Column
                  verticalArrangement={{ spacedBy: 16 }}
                  modifiers={[fillMaxWidth(), padding(24, 8, 24, 16)]}
                >
                  <Row
                    horizontalArrangement="spaceEvenly"
                    verticalAlignment="center"
                    modifiers={[fillMaxWidth()]}
                  >
                    <FilledTonalIconButton
                      enabled={amount > 1}
                      onClick={() => setAmount((current) => Math.max(1, current - 1))}
                      colors={{
                        containerColor: colors["--color-secondary"],
                        contentColor: colors["--color-secondary-foreground"],
                      }}
                      modifiers={[size(48, 48), testID("snooze-decrease-duration")]}
                    >
                      <Text style={titleTypography}>−</Text>
                    </FilledTonalIconButton>
                    <Text style={titleTypography} modifiers={[testID("snooze-duration")]}>
                      {String(amount)}
                    </Text>
                    <FilledTonalIconButton
                      enabled={amount < 99}
                      onClick={() => setAmount((current) => Math.min(99, current + 1))}
                      colors={{
                        containerColor: colors["--color-secondary"],
                        contentColor: colors["--color-secondary-foreground"],
                      }}
                      modifiers={[size(48, 48), testID("snooze-increase-duration")]}
                    >
                      <Text style={titleTypography}>+</Text>
                    </FilledTonalIconButton>
                  </Row>
                  <RNHostView matchContents={{ vertical: true }} modifiers={[fillMaxWidth()]}>
                    <SegmentedControl
                      variant="card"
                      options={units.map((option) => ({ ...option, label: m(option.label) }))}
                      selected={unit}
                      onSelect={setUnit}
                    />
                  </RNHostView>
                </Column>
              )}
              <Column
                verticalArrangement={{ spacedBy: 16 }}
                modifiers={[fillMaxWidth(), padding(24, 8, 24, 24)]}
              >
                {props.reminder ? (
                  <OutlinedTextField
                    autoFocus={props.reminder.autoFocus}
                    value={reminderText}
                    maxLength={SNOOZE_REMINDER_MAX_CHARS}
                    minLines={1}
                    maxLines={3}
                    textStyle={inputTypography}
                    colors={{
                      focusedTextColor: colors["--color-foreground"],
                      unfocusedTextColor: colors["--color-foreground"],
                      focusedIndicatorColor: colors["--color-focus"],
                      unfocusedIndicatorColor: colors["--color-border"],
                      cursorColor: colors["--color-focus"],
                    }}
                    modifiers={[fillMaxWidth()]}
                  >
                    <OutlinedTextField.Label>
                      <Text style={bodyTypography}>{gt("Reminder")}</Text>
                    </OutlinedTextField.Label>
                    <OutlinedTextField.Placeholder>
                      <Text style={bodyTypography}>
                        {gt("Shown in the chat when the thread wakes")}
                      </Text>
                    </OutlinedTextField.Placeholder>
                  </OutlinedTextField>
                ) : null}
                {error ? (
                  <Text style={bodyTypography} color={colors["--color-danger-foreground"]}>
                    {error}
                  </Text>
                ) : null}
                <Row horizontalArrangement="end" modifiers={[fillMaxWidth()]}>
                  <TextButton
                    onClick={props.onClose}
                    colors={{ contentColor: colors["--color-foreground"] }}
                  >
                    <Text style={bodyTypography}>{gt("Cancel")}</Text>
                  </TextButton>
                  <TextButton
                    onClick={submit}
                    colors={{ contentColor: colors["--color-foreground"] }}
                  >
                    <Text style={bodyTypography}>
                      {gt("Snooze", { $context: "verb, confirm button" })}
                    </Text>
                  </TextButton>
                </Row>
              </Column>
            </Column>
          </Surface>
        </BasicAlertDialog>
      </Host>
    </OverlayPortal>
  );
}

function SnoozeDateTimePicker(props: {
  readonly date: Date;
  readonly picker: "date" | "time";
  readonly is24Hour: boolean;
  readonly colors: React.ComponentProps<typeof DateTimePicker>["elementColors"];
  readonly onChange: (date: Date) => void;
}) {
  // Changing initialDate resets Compose's picker state, including its active clock dial.
  const [initialDate] = useState(() =>
    props.picker === "date" ? snoozeDateToPickerDate(props.date) : props.date.toISOString(),
  );
  return (
    <DateTimePicker
      initialDate={initialDate}
      displayedComponents={props.picker === "date" ? "date" : "hourAndMinute"}
      is24Hour={props.is24Hour}
      showVariantToggle={false}
      elementColors={props.colors}
      // Null marks incomplete input; keep the last valid date.
      onDateSelected={(date) => {
        if (date) props.onChange(date);
      }}
    />
  );
}
