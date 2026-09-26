import { Pressable, type StyleProp, type ViewStyle } from "react-native";

import { cn } from "../lib/cn";
import { AppText } from "./AppText";
import { SymbolView } from "./AppSymbol";

/** Shared compose action for the floating button and empty workspace. */
export function MaterialNewThreadButton(props: {
  readonly onPress: () => void;
  readonly extended?: boolean;
  readonly expanded?: boolean;
  readonly className?: string;
  readonly style?: StyleProp<ViewStyle>;
}) {
  return (
    <Pressable
      accessibilityLabel="New thread"
      accessibilityRole="button"
      onPress={props.onPress}
      className={cn(
        "items-center justify-center bg-primary shadow-lg active:opacity-70",
        props.extended
          ? "h-[56px] flex-row gap-[8px] rounded-[16px] px-[16px]"
          : "size-[80px] rounded-[20px]",
        props.className,
      )}
      style={props.style}
    >
      <SymbolView
        name="square.and.pencil"
        size={props.extended ? 24 : 28}
        tintColorClassName="accent-primary-foreground"
        type="monochrome"
      />
      {props.extended && props.expanded !== false ? (
        <AppText className="text-[16px] font-t3-medium text-primary-foreground">New thread</AppText>
      ) : null}
    </Pressable>
  );
}
