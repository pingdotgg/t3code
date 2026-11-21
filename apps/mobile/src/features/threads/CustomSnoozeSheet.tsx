import { SheetHeader } from "../../components/ui/SheetHeader";
import { CUSTOM_TIME_SHEET_COPY, type CustomTimeSheetPurpose } from "./customSnoozeDate";
import {
  DatePicker,
  Host,
  HStack,
  Picker,
  Popover,
  RNHostView,
  Spacer,
  Text,
  VStack,
} from "@expo/ui/swift-ui";
import {
  accessibilityHidden,
  clipped,
  font,
  datePickerStyle,
  foregroundStyle,
  frame,
  labelsHidden,
  padding,
  pickerStyle,
  tag,
} from "@expo/ui/swift-ui/modifiers";
import {
  localSnoozeDate,
  localSnoozeTime,
  resolveCustomSnooze,
  type CustomSnoozeInput,
} from "@t3tools/client-runtime/state/thread-settled";
import { msg, useGT, useMessages } from "gt-react-native";
import { useState, type ReactNode } from "react";
import { StandaloneStack } from "../layout/nested-stacks";
import { ScrollView, useWindowDimensions, View } from "react-native";

import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";

const durationAmounts = Array.from({ length: 99 }, (_, index) => index + 1);
const modes = [
  { value: "date", label: msg("Date and time") },
  { value: "duration", label: msg("Duration") },
] as const;
const units = [
  { value: "minutes", label: msg("Minutes") },
  { value: "hours", label: msg("Hours") },
  { value: "days", label: msg("Days") },
] as const;

export function CustomSnoozeSheet(props: {
  readonly onClose: () => void;
  readonly onSnooze: (snoozedUntil: string) => void;
  readonly purpose?: CustomTimeSheetPurpose;
}) {
  const gt = useGT();
  const m = useMessages();
  const { width, height } = useWindowDimensions();
  const copy = CUSTOM_TIME_SHEET_COPY[props.purpose ?? "snooze"];
  const [mode, setMode] = useState<CustomSnoozeInput["mode"]>("date");
  const [date, setDate] = useState(() => new Date(Date.now() + 3_600_000));
  const [amount, setAmount] = useState(2);
  const [unit, setUnit] = useState<"minutes" | "hours" | "days">("hours");
  const [error, setError] = useState<string | null>(null);
  const { themeVariables: colors, themeAppearance } = useAppearancePreferences();
  const popoverWidth = Math.min(360, width - 32);
  const popoverHeight = Math.min(error ? 364 : 324, height - 96);
  const updateDate = (value: Date) => {
    setDate(value);
    setError(null);
  };

  const submit = () => {
    const input: CustomSnoozeInput =
      mode === "date"
        ? { mode, date: localSnoozeDate(date), time: localSnoozeTime(date) }
        : { mode, amount: String(amount), unit };
    const snoozedUntil = resolveCustomSnooze(input, new Date());
    if (!snoozedUntil) {
      setError(
        mode === "date"
          ? gt("Choose a date and time in the future.")
          : gt("Enter a positive duration."),
      );
      return;
    }
    props.onSnooze(snoozedUntil);
    props.onClose();
  };

  return (
    <Host
      style={{ position: "absolute", top: 0, right: 0, bottom: 0, left: 0 }}
      colorScheme={themeAppearance}
      seedColor={colors["--color-primary"]}
    >
      <Popover
        isPresented
        onIsPresentedChange={(presented) => {
          if (!presented) props.onClose();
        }}
      >
        <Popover.Trigger>
          <Spacer
            modifiers={[frame({ maxWidth: Infinity, maxHeight: Infinity }), accessibilityHidden()]}
          />
        </Popover.Trigger>
        <Popover.Content>
          <SnoozePopoverNavigation
            copy={copy}
            width={popoverWidth}
            height={popoverHeight}
            onClose={props.onClose}
            onSubmit={submit}
          >
            <Host
              matchContents={{ vertical: true }}
              colorScheme={themeAppearance}
              style={{ width: popoverWidth }}
            >
              <VStack
                spacing={16}
                modifiers={[padding({ all: 16 }), foregroundStyle(colors["--color-foreground"])]}
              >
                <Picker
                  label={m(copy.modeLabel)}
                  selection={mode}
                  onSelectionChange={(value: CustomSnoozeInput["mode"]) => {
                    setMode(value);
                    setError(null);
                  }}
                  modifiers={[pickerStyle("segmented")]}
                >
                  {modes.map((option) => (
                    <Text key={option.value} modifiers={[tag(option.value)]}>
                      {m(option.label)}
                    </Text>
                  ))}
                </Picker>
                {mode === "date" ? (
                  <DatePicker
                    title={m(copy.untilLabel)}
                    selection={date}
                    displayedComponents={["date", "hourAndMinute"]}
                    onDateChange={updateDate}
                    modifiers={[
                      datePickerStyle("wheel"),
                      labelsHidden(),
                      frame({ maxWidth: Infinity, minHeight: 180, maxHeight: 180 }),
                    ]}
                  />
                ) : (
                  <HStack spacing={0}>
                    <Picker
                      label={gt("Duration amount")}
                      selection={amount}
                      onSelectionChange={(value: number) => {
                        setAmount(value);
                        setError(null);
                      }}
                      modifiers={[
                        pickerStyle("wheel"),
                        labelsHidden(),
                        frame({ minWidth: 0, maxWidth: Infinity, minHeight: 180, maxHeight: 180 }),
                        clipped(),
                      ]}
                    >
                      {durationAmounts.map((value) => (
                        <Text
                          key={value}
                          modifiers={[tag(value), foregroundStyle(colors["--color-foreground"])]}
                        >
                          {String(value)}
                        </Text>
                      ))}
                    </Picker>
                    <Picker
                      label={gt("Duration unit")}
                      selection={unit}
                      onSelectionChange={(value: typeof unit) => {
                        setUnit(value);
                        setError(null);
                      }}
                      modifiers={[
                        pickerStyle("wheel"),
                        labelsHidden(),
                        frame({ minWidth: 0, maxWidth: Infinity, minHeight: 180, maxHeight: 180 }),
                        clipped(),
                      ]}
                    >
                      {units.map((option) => (
                        <Text
                          key={option.value}
                          modifiers={[
                            tag(option.value),
                            foregroundStyle(colors["--color-foreground"]),
                          ]}
                        >
                          {m(option.label)}
                        </Text>
                      ))}
                    </Picker>
                  </HStack>
                )}
                {error ? (
                  <Text
                    modifiers={[
                      font({ textStyle: "footnote" }),
                      foregroundStyle(colors["--color-danger-foreground"]),
                    ]}
                  >
                    {error}
                  </Text>
                ) : null}
              </VStack>
            </Host>
          </SnoozePopoverNavigation>
        </Popover.Content>
      </Popover>
    </Host>
  );
}

function SnoozePopoverNavigation(props: {
  readonly copy: (typeof CUSTOM_TIME_SHEET_COPY)[CustomTimeSheetPurpose];
  readonly width: number;
  readonly height: number;
  readonly onClose: () => void;
  readonly onSubmit: () => void;
  readonly children: ReactNode;
}) {
  const m = useMessages();
  return (
    <VStack modifiers={[frame({ width: props.width, height: props.height })]}>
      <RNHostView>
        <View style={{ width: props.width, height: props.height }}>
          <StandaloneStack>
            <SheetHeader
              title={m(props.copy.title)}
              onCancel={props.onClose}
              accessibilityLabel={m(props.copy.cancelLabel)}
              confirm={{ label: m(props.copy.submit), onPress: props.onSubmit }}
            />
            <ScrollView
              contentInsetAdjustmentBehavior="automatic"
              showsVerticalScrollIndicator={false}
            >
              {props.children}
            </ScrollView>
          </StandaloneStack>
        </View>
      </RNHostView>
    </VStack>
  );
}
