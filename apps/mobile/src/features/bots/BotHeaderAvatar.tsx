import { StackActions, useNavigation } from "@react-navigation/native";
import type { ScopedThreadRef } from "@t3tools/contracts";

import { Pressable, View } from "react-native";

import { SymbolView } from "../../components/ui/AppSymbol";
import { GlassSurface } from "../../components/ui/GlassSurface";
import { AppText as Text } from "../../components/ui/AppText";
import { useQuietThreadShell } from "../../state/entities";
import { BotAvatar } from "./BotAvatar";
import { resolveBotStatus, useBotBoard } from "./useBotBoard";

/** A Bot's avatar in a thread's bar, showing what the Bot and its workers are doing. */
export function BotHeaderAvatar(props: {
  readonly botRef: ScopedThreadRef;
  readonly size?: number;
}) {
  const bot = useQuietThreadShell(props.botRef);
  const board = useBotBoard(props.botRef);
  if (bot?.botConfig == null) return null;
  const status = resolveBotStatus(bot, board);
  return (
    <BotAvatar
      threadId={bot.id}
      choice={bot.botConfig.avatar}
      state={status.state}
      mood={status.mood}
      size={props.size ?? 28}
    />
  );
}

/** A Bot chat's title, as in Messages: its avatar over its name, opening its details. */
export function BotHeaderTitle(props: {
  readonly botRef: ScopedThreadRef;
  readonly accessibilityLabel: string;
  readonly onPress: () => void;
}) {
  // Read here, not passed in: iOS keeps the first title element it was given.
  const name = useQuietThreadShell(props.botRef)?.title ?? "";
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.accessibilityLabel}
      hitSlop={4}
      onPress={props.onPress}
      className="max-w-56 items-center active:opacity-70"
    >
      <BotHeaderAvatar botRef={props.botRef} size={40} />
      {/* Glass, as the bar has no background: the name stays legible over the messages. */}
      <GlassSurface chrome="none" className="-mt-2" style={{ borderRadius: 999 }}>
        <View className="flex-row items-center gap-0.5 px-2.5 py-1">
          <Text className="shrink text-xs font-semibold text-header-foreground" numberOfLines={1}>
            {name}
          </Text>
          <SymbolView
            name="chevron.right"
            size={8}
            tintColorClassName="accent-header-foreground"
            type="monochrome"
          />
        </View>
      </GlassSurface>
    </Pressable>
  );
}

/** Drills into a Bot's thread, or one of its workers'; goes back when that is the page below. */
export function useOpenBotThread() {
  const navigation = useNavigation();
  return (target: ScopedThreadRef) => {
    const state = navigation.getState();
    const below = state === undefined ? undefined : state.routes[state.index - 1];
    const params = below?.params;
    if (
      below?.name === "Thread" &&
      params !== undefined &&
      "environmentId" in params &&
      params.environmentId === target.environmentId &&
      "threadId" in params &&
      params.threadId === target.threadId
    ) {
      navigation.goBack();
      return;
    }
    navigation.dispatch(
      StackActions.push("Thread", {
        environmentId: target.environmentId,
        threadId: target.threadId,
      }),
    );
  };
}
