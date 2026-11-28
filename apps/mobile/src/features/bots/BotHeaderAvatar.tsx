import { StackActions, useNavigation } from "@react-navigation/native";
import type { ScopedThreadRef } from "@t3tools/contracts";

import { useQuietThreadShell } from "../../state/entities";
import { BotAvatar } from "./BotAvatar";
import { resolveBotStatus, useBotBoard } from "./useBotBoard";

/** A Bot's avatar in a thread's bar, showing what the Bot and its workers are doing. */
export function BotHeaderAvatar(props: { readonly botRef: ScopedThreadRef }) {
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
      size={28}
    />
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
