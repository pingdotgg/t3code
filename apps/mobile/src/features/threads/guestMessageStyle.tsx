import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";

/** The guest's name above their message, where "Sent by T3 Code" sits for server messages. */
export function GuestMessageName(props: { readonly name: string }) {
  return (
    <Text
      accessibilityLabel={`${props.name} (guest)`}
      className="mb-1 pr-1 font-t3-medium text-2xs text-adaptive-fuchsia-600-300"
      numberOfLines={1}
    >
      {props.name}
    </Text>
  );
}

/**
 * First child of a sent guest bubble. Over the bubble color it gives the web's 14% fuchsia mix,
 * which every theme gets without a per-theme token.
 */
export function GuestBubbleTint() {
  return (
    <View pointerEvents="none" className="absolute inset-0 rounded-[20px] bg-fuchsia-500/14" />
  );
}

/** A pending guest bubble has a dashed edge and no fill. */
export const GUEST_PENDING_BUBBLE_CLASS_NAME =
  "min-w-0 rounded-[20px] border border-dashed border-adaptive-fuchsia-500-a50-300-a40 bg-transparent px-3.5 py-2.5";
