import { View } from "react-native";

import type { RowActionSlotProps } from "./RowActionSlot.types";

export function RowActionSlot(props: RowActionSlotProps) {
  return props.cardEdge ? <View className="mr-2">{props.children}</View> : <>{props.children}</>;
}
