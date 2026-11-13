import { View } from "react-native";

import { AppText as Text } from "./AppText";
import type { SheetIntroProps } from "./SheetIntro.types";
export type { SheetIntroProps } from "./SheetIntro.types";

export function SheetIntro(props: SheetIntroProps) {
  return (
    <View className="items-center gap-1 pt-2 pb-1">
      {props.eyebrow ? (
        <Text className="text-xs font-t3-bold tracking-[1px] uppercase text-foreground-muted">
          {props.eyebrow}
        </Text>
      ) : null}
      <Text className="text-center text-3xl font-t3-bold">{props.title}</Text>
      <Text className="text-center text-sm font-medium leading-normal text-foreground-secondary">
        {props.description}
      </Text>
    </View>
  );
}
