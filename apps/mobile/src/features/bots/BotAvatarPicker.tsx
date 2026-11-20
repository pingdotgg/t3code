import { T } from "gt-react-native";
import { BOT_AVATAR_COLOR_HEX } from "@t3tools/client-runtime/bot-avatar";
import {
  BOT_AVATAR_COLORS,
  BOT_AVATAR_SHAPES,
  type BotAvatarColor,
  type BotAvatarShape,
} from "@t3tools/contracts";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { cn } from "../../lib/cn";
import { BotAvatar } from "./BotAvatar";

/** Shape and color choices drawn in the chosen color, so each option previews the result. */
export function BotAvatarPicker(props: {
  readonly shape: BotAvatarShape;
  readonly color: BotAvatarColor;
  readonly disabled?: boolean;
  readonly onChange: (avatar: { shape: BotAvatarShape; color: BotAvatarColor }) => void;
}) {
  return (
    <View className="gap-4 p-4">
      <Text className="text-sm font-t3-medium text-foreground-muted">
        <T>Shape</T>
      </Text>
      <View className="flex-row flex-wrap gap-2">
        {BOT_AVATAR_SHAPES.map((shape) => (
          <Pressable
            key={shape}
            accessibilityRole="button"
            accessibilityLabel={shape}
            accessibilityState={{ selected: shape === props.shape, disabled: props.disabled }}
            disabled={props.disabled}
            onPress={() => props.onChange({ shape, color: props.color })}
            className={cn(
              "rounded-xl border-2 p-0.5 active:opacity-70",
              shape === props.shape ? "border-primary" : "border-transparent",
            )}
          >
            <BotAvatar
              avatar={{ shape, color: props.color }}
              size={40}
              pose={shape === props.shape ? "front" : "side"}
            />
          </Pressable>
        ))}
      </View>
      <Text className="text-sm font-t3-medium text-foreground-muted">
        <T>Color</T>
      </Text>
      <View className="flex-row flex-wrap gap-2">
        {BOT_AVATAR_COLORS.map((color) => (
          <Pressable
            key={color}
            accessibilityRole="button"
            accessibilityLabel={color}
            accessibilityState={{ selected: color === props.color, disabled: props.disabled }}
            disabled={props.disabled}
            onPress={() => props.onChange({ shape: props.shape, color })}
            className={cn(
              "rounded-full border-2 p-0.5 active:opacity-70",
              color === props.color ? "border-primary" : "border-transparent",
            )}
          >
            <View
              className="size-8 rounded-full border border-border-subtle"
              style={{ backgroundColor: BOT_AVATAR_COLOR_HEX[color] }}
            />
          </Pressable>
        ))}
      </View>
    </View>
  );
}
