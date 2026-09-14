import { DateTimePicker } from "@expo/ui/community/datetime-picker";
import {
  localSnoozeDate,
  localSnoozeTime,
  resolveCustomSnooze,
  type CustomSnoozeInput,
} from "@t3tools/client-runtime/state/thread-settled";
import { useState } from "react";
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AppText } from "../../components/AppText";

export function CustomSnoozeSheet(props: {
  readonly onClose: () => void;
  readonly onSnooze: (snoozedUntil: string) => void;
}) {
  const insets = useSafeAreaInsets();
  const [mode, setMode] = useState<CustomSnoozeInput["mode"]>("date");
  const [date, setDate] = useState(() => new Date(Date.now() + 3_600_000));
  const [picker, setPicker] = useState<"date" | "time" | null>(null);
  const [amount, setAmount] = useState("2");
  const [unit, setUnit] = useState<"minutes" | "hours" | "days">("hours");
  const [error, setError] = useState<string | null>(null);
  return (
    <Modal
      visible
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={props.onClose}
    >
      <KeyboardAvoidingView
        className="flex-1 bg-screen"
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <ScrollView
          keyboardShouldPersistTaps="handled"
          contentInsetAdjustmentBehavior="automatic"
          contentContainerStyle={{ padding: 24, paddingBottom: insets.bottom + 24, gap: 20 }}
        >
          <AppText accessibilityRole="header" className="text-xl font-t3-semibold">
            Custom snooze
          </AppText>
          <AppText className="text-base text-foreground-secondary">
            Choose when snoozed threads return to your inbox.
          </AppText>
          <View accessibilityRole="tablist" className="flex-row gap-2">
            {(["date", "duration"] as const).map((value) => (
              <Pressable
                key={value}
                accessibilityRole="tab"
                accessibilityState={{ selected: mode === value }}
                className={
                  mode === value
                    ? "min-h-12 flex-1 items-center justify-center rounded-xl bg-subtle px-3"
                    : "min-h-12 flex-1 items-center justify-center rounded-xl px-3"
                }
                onPress={() => {
                  setMode(value);
                  setPicker(null);
                  setError(null);
                }}
              >
                <AppText>{value === "date" ? "Date and time" : "Duration"}</AppText>
              </Pressable>
            ))}
          </View>
          {mode === "date" ? (
            <View className="gap-3">
              {(["date", "time"] as const).map((value) => (
                <Pressable
                  key={value}
                  accessibilityRole="button"
                  accessibilityLabel={value === "date" ? "Choose date" : "Choose time"}
                  className="min-h-12 flex-row items-center justify-between rounded-xl bg-subtle px-3"
                  onPress={() => setPicker(value)}
                >
                  <AppText>{value === "date" ? "Date" : "Time"}</AppText>
                  <AppText>
                    {value === "date"
                      ? date.toLocaleDateString()
                      : date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
                  </AppText>
                </Pressable>
              ))}
              {picker && (
                <DateTimePicker
                  value={date}
                  mode={picker}
                  display={Platform.OS === "ios" ? "spinner" : "default"}
                  onDismiss={() => setPicker(null)}
                  onValueChange={(_, selected) => {
                    const next = new Date(date);
                    if (picker === "date")
                      next.setFullYear(
                        selected.getFullYear(),
                        selected.getMonth(),
                        selected.getDate(),
                      );
                    else next.setHours(selected.getHours(), selected.getMinutes(), 0, 0);
                    setDate(next);
                    setError(null);
                    if (Platform.OS === "android") setPicker(null);
                  }}
                />
              )}
              <AppText className="text-base text-foreground-secondary">
                Your time zone: {new Intl.DateTimeFormat().resolvedOptions().timeZone}.
              </AppText>
            </View>
          ) : (
            <View className="gap-3">
              <AppText>Snooze for</AppText>
              <TextInput
                accessibilityLabel="Duration"
                className="min-h-12 rounded-xl bg-subtle px-3 text-base text-foreground"
                keyboardType="decimal-pad"
                value={amount}
                onChangeText={(value) => {
                  setAmount(value);
                  setError(null);
                }}
              />
              <View className="flex-row gap-2">
                {(["minutes", "hours", "days"] as const).map((value) => (
                  <Pressable
                    key={value}
                    accessibilityRole="radio"
                    accessibilityState={{ checked: unit === value }}
                    className={
                      unit === value
                        ? "min-h-12 flex-1 items-center justify-center rounded-xl bg-subtle"
                        : "min-h-12 flex-1 items-center justify-center rounded-xl"
                    }
                    onPress={() => {
                      setUnit(value);
                      setError(null);
                    }}
                  >
                    <AppText>
                      {value === "minutes" ? "Minutes" : value === "hours" ? "Hours" : "Days"}
                    </AppText>
                  </Pressable>
                ))}
              </View>
              <AppText className="text-base text-foreground-secondary">
                Starts when you press Snooze. One day is 24 hours.
              </AppText>
            </View>
          )}
          {error && (
            <AppText accessibilityRole="alert" className="text-danger-foreground">
              {error}
            </AppText>
          )}
          <View className="flex-row justify-end gap-3">
            <Pressable
              accessibilityRole="button"
              className="min-h-12 justify-center px-3"
              onPress={props.onClose}
            >
              <AppText>Cancel</AppText>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              className="min-h-12 justify-center rounded-xl bg-primary px-3"
              onPress={() => {
                const input: CustomSnoozeInput =
                  mode === "date"
                    ? { mode, date: localSnoozeDate(date), time: localSnoozeTime(date) }
                    : { mode, amount: amount.replace(",", "."), unit };
                const snoozedUntil = resolveCustomSnooze(input, new Date());
                if (!snoozedUntil) {
                  setError(
                    mode === "date"
                      ? "Choose a date and time in the future."
                      : "Enter a positive duration.",
                  );
                  return;
                }
                props.onSnooze(snoozedUntil);
                props.onClose();
              }}
            >
              <AppText className="text-primary-foreground">Snooze</AppText>
            </Pressable>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </Modal>
  );
}
