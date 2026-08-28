import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { useNavigation } from "@react-navigation/native";
import {
  MAX_SIDEBAR_AUTO_SETTLE_AFTER_DAYS,
  MIN_SIDEBAR_AUTO_SETTLE_AFTER_DAYS,
  type SidebarAutoSettleMode,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/unstable/reactivity";
import { Platform, Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AndroidScreenHeader } from "../../components/AndroidScreenHeader";
import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { useUniwindTheme } from "../../lib/useUniwindTheme";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { resolveMobileAutoSettlePreferences } from "../../persistence/mobile-preferences";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import { SettingsSection } from "./components/SettingsSection";

const AUTO_SETTLE_OPTIONS: ReadonlyArray<{
  readonly mode: SidebarAutoSettleMode;
  readonly label: string;
  readonly description: string;
}> = [
  {
    mode: "never",
    label: "Never",
    description: "Threads settle only when you choose Settle.",
  },
  {
    mode: "change-request",
    label: "When a pull request merges or closes",
    description: "A missing or uncertain pull-request timestamp keeps the thread active.",
  },
  {
    mode: "inactivity",
    label: "After inactivity",
    description: "Running, blocked, and open-pull-request threads stay active.",
  },
];

export function mobileAutoSettleModeLabel(mode: SidebarAutoSettleMode): string {
  if (mode === "change-request") return "PR merged or closed";
  if (mode === "inactivity") return "After inactivity";
  return "Never";
}

export function SettingsAutoSettleRouteScreen() {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const checkmarkColor = useUniwindTheme()["--color-icon"];
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const preferencesReady = AsyncResult.isSuccess(preferencesResult) && !preferencesResult.waiting;
  const resolved = resolveMobileAutoSettlePreferences(
    AsyncResult.isSuccess(preferencesResult) ? preferencesResult.value : {},
  );

  const setDays = (days: number) => {
    if (!preferencesReady) return;
    savePreferences({
      autoSettleAfterDays: Math.min(
        MAX_SIDEBAR_AUTO_SETTLE_AFTER_DAYS,
        Math.max(MIN_SIDEBAR_AUTO_SETTLE_AFTER_DAYS, days),
      ),
    });
  };

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      {Platform.OS === "android" ? (
        <>
          <NativeStackScreenOptions options={{ headerShown: false }} />
          <AndroidScreenHeader title="Thread Settling" onBack={() => navigation.goBack()} />
        </>
      ) : null}
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-4 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        <SettingsSection title="Automatic settling">
          {AUTO_SETTLE_OPTIONS.map((option, index) => (
            <Pressable
              key={option.mode}
              accessibilityRole="radio"
              accessibilityState={{
                checked: resolved.autoSettleMode === option.mode,
                disabled: !preferencesReady,
              }}
              disabled={!preferencesReady}
              onPress={() => savePreferences({ autoSettleMode: option.mode })}
              className={
                index === 0
                  ? "flex-row items-center gap-4 p-4"
                  : "flex-row items-center gap-4 border-t border-border-subtle p-4"
              }
            >
              <View className="min-w-0 flex-1 gap-1">
                <Text className="text-lg text-foreground">{option.label}</Text>
                <Text className="text-sm leading-normal text-foreground-muted">
                  {option.description}
                </Text>
              </View>
              {resolved.autoSettleMode === option.mode ? (
                <SymbolView
                  name="checkmark"
                  size={18}
                  tintColor={checkmarkColor}
                  type="monochrome"
                  weight="semibold"
                />
              ) : null}
            </Pressable>
          ))}
        </SettingsSection>

        {resolved.autoSettleMode === "inactivity" ? (
          <SettingsSection title="Inactivity window">
            <View className="flex-row items-center gap-4 p-4">
              <View className="min-w-0 flex-1 gap-1">
                <Text className="text-lg text-foreground">Days without activity</Text>
                <Text className="text-sm text-foreground-muted">Between 1 and 90 days</Text>
              </View>
              <Pressable
                accessibilityLabel="Decrease inactivity days"
                accessibilityRole="button"
                disabled={
                  !preferencesReady ||
                  resolved.autoSettleAfterDays <= MIN_SIDEBAR_AUTO_SETTLE_AFTER_DAYS
                }
                onPress={() => setDays(resolved.autoSettleAfterDays - 1)}
                className="size-10 items-center justify-center rounded-full bg-fill-secondary disabled:opacity-40"
              >
                <SymbolView
                  name="minus"
                  size={16}
                  tintColor={checkmarkColor}
                  type="monochrome"
                  weight="semibold"
                />
              </Pressable>
              <Text className="w-8 text-center text-lg text-foreground">
                {resolved.autoSettleAfterDays}
              </Text>
              <Pressable
                accessibilityLabel="Increase inactivity days"
                accessibilityRole="button"
                disabled={
                  !preferencesReady ||
                  resolved.autoSettleAfterDays >= MAX_SIDEBAR_AUTO_SETTLE_AFTER_DAYS
                }
                onPress={() => setDays(resolved.autoSettleAfterDays + 1)}
                className="size-10 items-center justify-center rounded-full bg-fill-secondary disabled:opacity-40"
              >
                <SymbolView
                  name="plus"
                  size={16}
                  tintColor={checkmarkColor}
                  type="monochrome"
                  weight="semibold"
                />
              </Pressable>
            </View>
          </SettingsSection>
        ) : null}
      </ScrollView>
    </View>
  );
}
