import { View } from "react-native";
import { Progress } from "./Progress";

/** Thin, noninteractive progress at the top of its owning screen. */
export function LoadingStrip(props: { readonly progress?: number }) {
  return (
    <View
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      className="absolute inset-x-0 top-0 z-10 h-1 overflow-hidden"
    >
      <Progress value={props.progress} />
    </View>
  );
}
