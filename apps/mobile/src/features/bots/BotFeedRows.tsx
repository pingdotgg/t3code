import { T, Var } from "gt-react-native";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { cn } from "../../lib/cn";
import { BotAvatar } from "./BotAvatar";
import type { BotIdentity } from "./useBotSenders";

/** A Bot's avatar and name, above its replies and above the messages it sends other threads. */
export function BotNameLine(props: { readonly bot: BotIdentity; readonly alignEnd?: boolean }) {
  return (
    <View className={cn("mb-1 flex-row items-center gap-1.5", props.alignEnd ? "pr-1" : "pl-1")}>
      <BotAvatar threadId={props.bot.threadId} choice={props.bot.avatar} state="idle" size={20} />
      <Text numberOfLines={1} className="shrink font-t3-medium text-xs text-foreground-secondary">
        {props.bot.name}
      </Text>
    </View>
  );
}

export function BotTypingRow(props: { readonly bot: BotIdentity; readonly detail?: string }) {
  return (
    <View className="mb-2 min-h-8 flex-row items-center gap-1.5 px-1">
      <BotAvatar
        threadId={props.bot.threadId}
        choice={props.bot.avatar}
        state="thinking"
        size={20}
      />
      <Text numberOfLines={1} className="shrink text-sm text-foreground-muted">
        {props.detail === undefined ? (
          <T>
            <Var>{props.bot.name}</Var> is typing…
          </T>
        ) : (
          props.detail
        )}
      </Text>
    </View>
  );
}
