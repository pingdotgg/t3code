import { SheetHeader } from "../../components/ui/SheetHeader";
import { useInterfaceDirection } from "../../i18n/direction";
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
}) {
  const gt = useGT();
  const m = useMessages();
  const { width, height } = useWindowDimensions();
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

  const direction = useInterfaceDirection();
  const layoutDirection = direction === "rtl" ? "rightToLeft" : "leftToRight";
  return (
    <Host
      layoutDirection={layoutDirection}
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
            width={popoverWidth}
            height={popoverHeight}
            onClose={props.onClose}
            onSubmit={submit}
          >
            <Host
              layoutDirection={layoutDirection}
              matchContents={{ vertical: true }}
              colorScheme={themeAppearance}
              style={{ width: popoverWidth }}
            >
              <VStack
                spacing={16}
                modifiers={[padding({ all: 16 }), foregroundStyle(colors["--color-foreground"])]}
              >
                <Picker
                  label={gt("Snooze mode")}
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
                    title={gt("Snooze until")}
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
  readonly width: number;
  readonly height: number;
  readonly onClose: () => void;
  readonly onSubmit: () => void;
  readonly children: ReactNode;
}) {
  const gt = useGT();
  return (
    <VStack modifiers={[frame({ width: props.width, height: props.height })]}>
      <RNHostView>
        <View style={{ width: props.width, height: props.height }}>
          <StandaloneStack>
            <SheetHeader
              title={gt("Custom snooze")}
              onCancel={props.onClose}
              accessibilityLabel={gt("Cancel custom snooze")}
              confirm={{
                label: gt("Snooze", { $context: "verb, confirm button" }),
                onPress: props.onSubmit,
              }}
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
