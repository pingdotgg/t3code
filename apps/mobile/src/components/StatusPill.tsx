import { View } from "react-native";

import { AppText as Text } from "./AppText";
import { cx } from "../lib/classNames";

export interface StatusTone {
  readonly label: string;
  readonly pillClassName: string;
  readonly textClassName: string;
}

export function StatusPill(props: StatusTone) {
  return (
    <View className={cx("rounded-full px-3 py-1.5", props.pillClassName)}>
      <Text className={cx("font-t3-bold text-xs", props.textClassName)}>{props.label}</Text>
    </View>
  );
}
