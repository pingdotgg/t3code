import DateTimePicker from "@expo/ui/community/datetime-picker";
import {
  resolveSnoozeForDefault,
  snoozeForTimeError,
} from "@t3tools/client-runtime/state/thread-settled";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { useCallback, useState } from "react";
import { Alert, Platform, Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AndroidScreenHeader } from "../../components/AndroidScreenHeader";
import { AppText as Text } from "../../components/AppText";
import { ConnectionSheetButton } from "../connection/ConnectionSheetButton";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { useThreadShell } from "../../state/entities";
import { useThreadListActions } from "../home/useThreadListActions";

import {
  mergeAndroidPickerValue,
  resolveAndroidMinimumDate,
  resolveAndroidPickerValue,
  type AndroidSnoozePicker,
} from "./SnoozeForRouteScreen.logic";

type SnoozeForRouteParams = {
  readonly environmentId: string;
  readonly threadId: string;
};

function formatDate(value: Date): string {
  return value.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function formatTime(value: Date): string {
  return value.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

export function SnoozeForRouteScreen({ route }: StaticScreenProps<SnoozeForRouteParams>) {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const thread = useThreadShell({
    environmentId: EnvironmentId.make(route.params.environmentId),
    threadId: ThreadId.make(route.params.threadId),
  });
  const { snoozeThread } = useThreadListActions();
  const [value, setValue] = useState(() => resolveSnoozeForDefault(new Date()));
  const [androidPicker, setAndroidPicker] = useState<AndroidSnoozePicker | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleValueChange = useCallback((selected: Date) => {
    setValue(selected);
    setError(null);
  }, []);

  const handleSubmit = useCallback(async () => {
    if (isSubmitting) return;

    const validationError = snoozeForTimeError(value, { now: new Date() });
    if (validationError !== null) {
      setError(validationError);
      return;
    }
    if (thread === null) {
      Alert.alert(
        "Could not snooze thread",
        "This thread is no longer available. Return to the thread list and try again.",
      );
      return;
    }

    setIsSubmitting(true);
    const succeeded = await snoozeThread(thread, value.toISOString());
    if (succeeded) {
      navigation.goBack();
      return;
    }
    setIsSubmitting(false);
  }, [isSubmitting, navigation, snoozeThread, thread, value]);

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      <NativeStackScreenOptions
        options={{
          ...(Platform.OS === "android" ? { headerShown: false } : null),
          title: "Snooze until",
        }}
      />
      {Platform.OS === "android" ? (
        <AndroidScreenHeader
          title="Snooze until"
          subtitle={thread?.title ?? null}
          onBack={() => navigation.goBack()}
        />
      ) : null}

      <ScrollView
        className="flex-1"
        contentInsetAdjustmentBehavior="automatic"
        contentInset={{ bottom: Math.max(insets.bottom, 18) + 18 }}
        contentContainerStyle={{ paddingHorizontal: 20, paddingTop: 16 }}
        showsVerticalScrollIndicator={false}
      >
        <View className="gap-5">
          <View className="gap-4 rounded-[24px] border-continuous bg-card p-4">
            <View className="gap-1">
              <Text className="text-2xs font-t3-bold tracking-[0.8px] uppercase text-foreground-muted">
                Wake this thread
              </Text>
              <Text className="text-sm leading-normal text-foreground-secondary">
                The thread stays out of the inbox until this time, unless it needs you sooner.
              </Text>
            </View>

            {Platform.OS === "ios" ? (
              <DateTimePicker
                display="compact"
                minimumDate={new Date()}
                mode="datetime"
                onValueChange={(_event, selected) => handleValueChange(selected)}
                style={{ alignSelf: "stretch" }}
                value={value}
              />
            ) : (
              <View className="overflow-hidden rounded-[16px] border border-input-border bg-input">
                <Pressable
                  accessibilityLabel={`Date, ${formatDate(value)}`}
                  accessibilityRole="button"
                  className="flex-row items-center justify-between gap-4 px-4 py-3.5"
                  onPress={() => setAndroidPicker("date")}
                >
                  <Text className="text-sm font-t3-medium text-foreground-muted">Date</Text>
                  <Text className="flex-1 text-right text-base text-foreground" numberOfLines={1}>
                    {formatDate(value)}
                  </Text>
                </Pressable>
                <View className="ml-4 h-px bg-border-subtle" />
                <Pressable
                  accessibilityLabel={`Time, ${formatTime(value)}`}
                  accessibilityRole="button"
                  className="flex-row items-center justify-between gap-4 px-4 py-3.5"
                  onPress={() => setAndroidPicker("time")}
                >
                  <Text className="text-sm font-t3-medium text-foreground-muted">Time</Text>
                  <Text className="flex-1 text-right text-base text-foreground" numberOfLines={1}>
                    {formatTime(value)}
                  </Text>
                </Pressable>
              </View>
            )}

            {error !== null ? (
              <Text accessibilityRole="alert" className="text-sm text-danger-foreground">
                {error}
              </Text>
            ) : null}

            <ConnectionSheetButton
              disabled={isSubmitting}
              icon="clock"
              label={isSubmitting ? "Snoozing..." : "Snooze thread"}
              onPress={() => {
                void handleSubmit();
              }}
              tone="primary"
            />
          </View>
        </View>
      </ScrollView>

      {Platform.OS === "android" && androidPicker !== null ? (
        <DateTimePicker
          minimumDate={androidPicker === "date" ? resolveAndroidMinimumDate(new Date()) : undefined}
          mode={androidPicker}
          onDismiss={() => setAndroidPicker(null)}
          onValueChange={(_event, selected) => {
            handleValueChange(mergeAndroidPickerValue(value, selected, androidPicker));
            setAndroidPicker(null);
          }}
          presentation="dialog"
          value={resolveAndroidPickerValue(value, androidPicker)}
        />
      ) : null}
    </View>
  );
}
