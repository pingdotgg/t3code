import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Haptics from "expo-haptics";
import { msg, T, useGT, useMessages } from "gt-react-native";
import { useState } from "react";
import { Platform, Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppBar } from "../../components/ui/AppBar";
import { AppText as Text } from "../../components/ui/AppText";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { SheetHeader } from "../../components/ui/SheetHeader";
import { scopedThreadKey } from "../../lib/scopedEntities";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { useEnvironmentQuery } from "../../state/query";
import { threadHandoffEnvironment } from "../../state/threadHandoff";
import { useAtomCommand } from "../../state/use-atom-command";
import { useQueuedThreadKeys } from "../../state/use-thread-outbox";

const TITLE = msg("Continue on another machine");

type HandoffTarget = { readonly environmentId: EnvironmentId; readonly threadId: ThreadId };

/**
 * The linked machines a thread can move to. Picking one starts the move and closes the sheet;
 * the thread's own notice shows how it goes.
 */
export function ThreadHandoffSheet({ route }: StaticScreenProps<HandoffTarget>) {
  const { environmentId, threadId } = route.params;
  const gt = useGT();
  const m = useMessages();
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const targets = useEnvironmentQuery(
    threadHandoffEnvironment.options({ environmentId, input: { threadId } }),
  );
  const start = useAtomCommand(threadHandoffEnvironment.start, { reportFailure: false });
  const [starting, setStarting] = useState<EnvironmentId | null>(null);
  const [error, setError] = useState<string | null>(null);
  // A message in the outbox exists only on this device, and a moved thread refuses it.
  const outboxWaiting = useQueuedThreadKeys().has(scopedThreadKey(environmentId, threadId));
  const close = () => navigation.goBack();

  const choose = async (target: EnvironmentId) => {
    void Haptics.selectionAsync();
    setStarting(target);
    setError(null);
    const result = await start({ environmentId, input: { threadId, environmentId: target } });
    setStarting(null);
    if (result._tag === "Success") {
      close();
      return;
    }
    if (isAtomCommandInterrupted(result)) return;
    const failure = squashAtomCommandFailure(result);
    setError(failure instanceof Error ? failure.message : gt("Could not move the thread."));
  };

  const options = targets.data?.options ?? [];
  const content = (
    <ScrollView
      className="flex-1"
      contentInsetAdjustmentBehavior={Platform.OS === "ios" ? "automatic" : "never"}
      contentContainerClassName="px-5 pt-4"
      contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 16) + 8 }}
    >
      <Text className="pb-2 text-sm leading-normal text-foreground-secondary">
        <T>
          The thread moves with its conversation and its code, including commits you have not pushed
          and uncommitted changes. This copy becomes read-only.
        </T>
      </Text>
      {outboxWaiting ? (
        <Text accessibilityRole="alert" className="pt-2 text-sm text-danger-foreground">
          <T>A message is still waiting to send from this device. Send or discard it first.</T>
        </Text>
      ) : null}
      {targets.data === null ? (
        <Text className="pt-4 text-sm text-foreground-muted">
          {targets.error ?? gt("Asking linked machines…")}
        </Text>
      ) : options.length === 0 ? (
        <Text className="pt-4 text-sm text-foreground-muted">
          <T>This machine has no linked machines. Link one in Settings on desktop or web.</T>
        </Text>
      ) : (
        options.map((option) => {
          const disabled = option.reason !== null || starting !== null || outboxWaiting;
          return (
            <Pressable
              key={option.environmentId}
              accessibilityRole="button"
              accessibilityState={{ disabled, busy: starting === option.environmentId }}
              disabled={disabled}
              onPress={() => void choose(option.environmentId)}
              className="border-b border-border py-3.5 active:opacity-70 disabled:opacity-50"
            >
              <Text className="text-base font-t3-bold text-foreground">
                {starting === option.environmentId
                  ? gt("Moving to {machine}…", { machine: option.label })
                  : option.label}
              </Text>
              {option.reason === null ? null : (
                <Text className="text-xs text-foreground-muted">{option.reason}</Text>
              )}
            </Pressable>
          );
        })
      )}
      {error === null ? null : (
        <Text accessibilityRole="alert" className="pt-3 text-sm text-danger-foreground">
          {error}
        </Text>
      )}
    </ScrollView>
  );

  if (Platform.OS === "ios") {
    return (
      <View collapsable={false} className="flex-1 bg-sheet">
        <SheetHeader presentation="native" title={m(TITLE)} onClose={close} />
        {content}
      </View>
    );
  }

  return (
    <View collapsable={false} className="flex-1 bg-header">
      <NativeStackScreenOptions options={{ sheetCornerRadius: 28 }} />
      <AppBar sheet title={m(TITLE)} hideBottomBorder onBack={close} />
      <ScreenContent>{content}</ScreenContent>
    </View>
  );
}
