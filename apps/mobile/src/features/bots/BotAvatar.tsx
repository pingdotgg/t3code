import {
  type AvatarMood,
  type AvatarState,
  botAvatarFor,
  botAvatarStillSvg,
} from "@t3tools/client-runtime/state/bot-avatar";
import type { BotAvatarChoice } from "@t3tools/contracts";
import { memo } from "react";
import { View } from "react-native";
import { SvgXml } from "react-native-svg";

/** A Bot's avatar as a still pose for its state, drawn from the same SVG the web shows. */
export const BotAvatar = memo(function BotAvatar(props: {
  readonly threadId: string;
  /** The avatar the Bot chose; absent picks one from its thread id. */
  readonly choice?: BotAvatarChoice | null | undefined;
  readonly state: AvatarState;
  readonly mood?: AvatarMood;
  readonly size: number;
}) {
  const avatar = botAvatarFor(props.threadId, props.choice);
  const xml = botAvatarStillSvg(avatar, props.state, props.mood ?? "neutral");
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{ width: props.size, height: props.size }}
    >
      <SvgXml xml={xml} width={props.size} height={props.size} />
    </View>
  );
});
