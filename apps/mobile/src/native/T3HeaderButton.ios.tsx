import { requireNativeView } from "expo";
import type { NativeSyntheticEvent, StyleProp, ViewProps, ViewStyle } from "react-native";

interface NativeHeaderButtonProps extends ViewProps {
  readonly label: string;
  readonly systemImage:
    | "gearshape"
    | "line.3.horizontal.decrease.circle"
    | "line.3.horizontal.decrease.circle.fill"
    | "square.and.pencil";
  readonly onTriggered: (event: NativeSyntheticEvent<Record<string, never>>) => void;
}

const NativeHeaderButton = requireNativeView<NativeHeaderButtonProps>("T3NativeControls");

export function T3HeaderButton(props: {
  readonly accessibilityLabel: string;
  readonly icon: NativeHeaderButtonProps["systemImage"];
  readonly onPress: () => void;
  readonly style?: StyleProp<ViewStyle>;
}) {
  return (
    <NativeHeaderButton
      label={props.accessibilityLabel}
      onTriggered={props.onPress}
      style={[{ width: 44, height: 44 }, props.style]}
      systemImage={props.icon}
    />
  );
}
