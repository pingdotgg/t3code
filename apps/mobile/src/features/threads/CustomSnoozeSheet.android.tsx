import { MaterialSegmentedButtons } from "../../components/MaterialSegmentedButtons.android";
import {
  BasicAlertDialog,
  Button,
  Column,
  DateTimePicker,
  Host,
  FilledTonalIconButton,
  Row,
  Shape,
  Surface,
  Text,
  TextButton,
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
  resolveCustomSnooze,
  type CustomSnoozeInput,
} from "@t3tools/client-runtime/state/thread-settled";
import { requireNativeModule } from "expo";
import { useEffect, useState } from "react";
import { AppState, useWindowDimensions } from "react-native";

import { OverlayPortal } from "../../components/OverlayPortal";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import { useScaledTextRole } from "../settings/appearance/useScaledTextRole";
import type { CustomSnoozeSheet as SharedCustomSnoozeSheet } from "./CustomSnoozeSheet.shared";
import {
  applySnoozePickerDate,
  applySnoozePickerTime,
  snoozeDateToPickerDate,
} from "./customSnoozeDate";

type Props = Parameters<typeof SharedCustomSnoozeSheet>[0];

const roundedCorner = Shape.RoundedCorner;

const modes = [
  { value: "date", label: "Date and time" },
  { value: "duration", label: "Duration" },
] as const;
const units = [
  { value: "minutes", label: "Minutes" },
  { value: "hours", label: "Hours" },
  { value: "days", label: "Days" },
] as const;

function systemUses24HourClock() {
  return requireNativeModule<{ is24HourFormat(): boolean }>("T3NativeControls").is24HourFormat();
}

export function CustomSnoozeSheet(props: Props) {
  const { themeAppearance, themeVariables: colors } = useAppearancePreferences();
  const [is24Hour, setIs24Hour] = useState(systemUses24HourClock);
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") setIs24Hour(systemUses24HourClock());
    });
    return () => subscription.remove();
  }, []);
  const titleTypography = useScaledTextRole("title");
  const bodyTypography = useScaledTextRole("footnote");
  const { width: windowWidth } = useWindowDimensions();
  const [mode, setMode] = useState<CustomSnoozeInput["mode"]>("date");
  const [date, setDate] = useState(() => new Date(Date.now() + 3_600_000));
  const [picker, setPicker] = useState<"date" | "time">("date");
  const [amount, setAmount] = useState(2);
  const [unit, setUnit] = useState<"minutes" | "hours" | "days">("hours");
  const [error, setError] = useState<string | null>(null);
  const submit = () => {
    const input: CustomSnoozeInput =
      mode === "date"
        ? { mode, date: localSnoozeDate(date), time: localSnoozeTime(date) }
        : { mode, amount: String(amount), unit };
    const snoozedUntil = resolveCustomSnooze(input, new Date());
    if (!snoozedUntil) {
      setError(
        mode === "date" ? "Choose a date and time in the future." : "Enter a positive duration.",
      );
      return;
    }
    props.onSnooze(snoozedUntil);
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
                <Text style={titleTypography}>Custom snooze</Text>
                <MaterialSegmentedButtons
                  options={modes}
                  selected={mode}
                  onSelect={(value) => {
                    setMode(value);
                    setError(null);
                  }}
                />
                {mode === "date" ? (
                  <MaterialSegmentedButtons
                    options={[
                      {
                        value: "date",
                        label: date.toLocaleDateString([], { month: "short", day: "numeric" }),
                      },
                      {
                        value: "time",
                        label: date.toLocaleTimeString([], {
                          hour: "numeric",
                          minute: "2-digit",
                          hourCycle: is24Hour ? "h23" : "h12",
                        }),
                      },
                    ]}
                    selected={picker}
                    onSelect={setPicker}
                  />
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
                  <MaterialSegmentedButtons options={units} selected={unit} onSelect={setUnit} />
                </Column>
              )}
              <Column
                verticalArrangement={{ spacedBy: 16 }}
                modifiers={[fillMaxWidth(), padding(24, 8, 24, 24)]}
              >
                {error ? (
                  <Text style={bodyTypography} color={colors["--color-danger-foreground"]}>
                    {error}
                  </Text>
                ) : null}
                <Row horizontalArrangement="end" modifiers={[fillMaxWidth()]}>
                  <TextButton
                    onClick={props.onClose}
                    colors={{ contentColor: colors["--color-primary"] }}
                  >
                    <Text style={bodyTypography}>Cancel</Text>
                  </TextButton>
                  <Button
                    onClick={submit}
                    colors={{
                      containerColor: colors["--color-primary"],
                      contentColor: colors["--color-primary-foreground"],
                    }}
                  >
                    <Text style={bodyTypography}>Snooze</Text>
                  </Button>
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
      onDateSelected={props.onChange}
    />
  );
}
