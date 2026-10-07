import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import * as Haptics from "expo-haptics";
import { useState } from "react";
import { Platform, Pressable, ScrollView, View } from "react-native";
import { Screen, ScreenStack, ScreenStackHeaderConfig } from "react-native-screens";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AndroidSheetHeader } from "../../components/AndroidScreenHeader";
import { AppText as Text } from "../../components/AppText";
import { useUniwindTheme } from "../../lib/useUniwindTheme";
import { nativeHeaderScrollEdgeEffects } from "../../native/StackHeader";
import { useEnvironmentQuery } from "../../state/query";
import { threadHandoffEnvironment } from "../../state/threadHandoff";
import { useAtomCommand } from "../../state/use-atom-command";

const HEADER_SCROLL_EDGE_EFFECTS = nativeHeaderScrollEdgeEffects(Platform.OS, Platform.Version);

type HandoffTarget = { readonly environmentId: EnvironmentId; readonly threadId: ThreadId };

/**
 * "Continue on…": the linked environments this thread can move to. Picking
 * one starts the move and closes the sheet; the thread's card shows how it goes.
 */
export function ThreadHandoffSheet({ route }: StaticScreenProps<HandoffTarget>) {
  const target = route.params;
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const theme = useUniwindTheme();
  const options = useEnvironmentQuery(
    threadHandoffEnvironment.options({
      environmentId: target.environmentId,
      input: { threadId: target.threadId },
    }),
  );
  const start = useAtomCommand(threadHandoffEnvironment.start, {
    label: "move thread",
    reportFailure: false,
  });
  const [starting, setStarting] = useState<EnvironmentId | null>(null);
  const [error, setError] = useState<string | null>(null);

  const choose = async (environmentId: EnvironmentId) => {
    void Haptics.selectionAsync();
    setStarting(environmentId);
    setError(null);
    const result = await start({
      environmentId: target.environmentId,
      input: { threadId: target.threadId, environmentId },
    });
    setStarting(null);
    if (result._tag === "Failure") {
      setError(String(squashAtomCommandFailure(result)));
      return;
    }
    navigation.goBack();
  };

  const targets = options.data?.options ?? [];
  const content = (
    <ScrollView
      className="flex-1"
      contentInsetAdjustmentBehavior={Platform.OS === "ios" ? "automatic" : "never"}
      contentContainerClassName="px-5 pb-6"
      contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 16) + 8 }}
    >
      <Text className="pb-2 pt-3 text-sm text-foreground-muted">
        Moves the conversation, unpushed commits, and uncommitted changes. This thread becomes
        read-only here.
      </Text>
      {options.error ? (
        <Text className="pt-4 text-sm text-danger-foreground">{options.error}</Text>
      ) : options.data === null ? (
        <Text className="pt-4 text-sm text-foreground-muted">Asking linked environments…</Text>
      ) : targets.length === 0 ? (
        <Text className="pt-4 text-sm text-foreground-muted">
          No linked environments. Link one from a desktop or with `t3 environment link`.
        </Text>
      ) : (
        targets.map((option) => (
          <Pressable
            key={option.environmentId}
            accessibilityRole="button"
            accessibilityState={{ disabled: option.reason !== null || starting !== null }}
            disabled={option.reason !== null || starting !== null}
            onPress={() => void choose(option.environmentId)}
            className="border-b border-border py-3.5 active:opacity-70 disabled:opacity-50"
          >
            <Text className="text-base font-t3-bold text-foreground">
              {starting === option.environmentId ? `Moving to ${option.label}…` : option.label}
            </Text>
            {option.reason !== null ? (
              <Text className="text-xs text-foreground-muted">{option.reason}</Text>
            ) : null}
          </Pressable>
        ))
      )}
      {error !== null ? (
        <Text accessibilityRole="alert" className="pt-3 text-sm text-danger-foreground">
          {error}
        </Text>
      ) : null}
    </ScrollView>
  );

  if (Platform.OS === "ios") {
    // A plain formSheet screen never renders a stack header, so it comes from
    // a nested native stack inside the sheet (same shape as the agents sheet).
    return (
      <View collapsable={false} className="flex-1 bg-sheet">
        <ScreenStack style={{ flex: 1 }}>
          <Screen
            activityState={2}
            enabled
            isNativeStack
            screenId="thread-handoff-sheet-native"
            scrollEdgeEffects={HEADER_SCROLL_EDGE_EFFECTS}
            style={{ backgroundColor: theme["--color-sheet"], flex: 1 }}
          >
            {content}
            <ScreenStackHeaderConfig
              backgroundColor="rgba(0,0,0,0)"
              color={theme["--color-foreground"]}
              hideBackButton
              hideShadow={false}
              title="Continue on…"
              titleColor={theme["--color-foreground"]}
              titleFontSize={18}
              titleFontWeight="800"
              translucent
            />
          </Screen>
        </ScreenStack>
      </View>
    );
  }

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      <AndroidSheetHeader title="Continue on…" onBack={() => navigation.goBack()} />
      {content}
    </View>
  );
}
