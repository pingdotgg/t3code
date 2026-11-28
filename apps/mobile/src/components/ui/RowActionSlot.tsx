import { View } from "react-native";

import type { RowActionSlotProps } from "./RowActionSlot.types";

/** A 44pt trailing slot, the compact IconButton's touch target, kept even when the action is absent. */
export function RowActionSlot(props: RowActionSlotProps) {
  return <View className="size-[44px] items-center justify-center">{props.children}</View>;
}
