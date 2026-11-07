import { Pressable, type StyleProp, type ViewStyle } from "react-native";

import { cn } from "../lib/cn";
import { AppText } from "./ui/AppText";
import { SymbolView, type AppSymbolName } from "./ui/AppSymbol";

export function NewThreadButton(props: {
  readonly onPress: () => void;
  readonly label?: string;
  readonly icon?: AppSymbolName;
  readonly extended?: boolean;
  readonly expanded?: boolean;
  readonly className?: string;
  readonly style?: StyleProp<ViewStyle>;
}) {
  const label = props.label ?? "New thread";
  const icon = props.icon ?? "square.and.pencil";
  return (
    <Pressable
      accessibilityLabel={label}
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
        name={icon}
        size={props.extended ? 24 : 28}
        tintColorClassName="accent-primary-foreground"
        type="monochrome"
      />
      {props.extended && props.expanded !== false ? (
        <AppText className="text-[16px] font-t3-medium text-primary-foreground">{label}</AppText>
      ) : null}
    </Pressable>
  );
}
