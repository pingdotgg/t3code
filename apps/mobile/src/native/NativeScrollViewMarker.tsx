import { createContext, use, type ComponentProps } from "react";
import { Platform, ScrollView } from "react-native";
import { ScrollViewMarker } from "react-native-screens";
import { nativeHeaderScrollEdgeEffects } from "./scrollEdgeEffects";

type ScrollEdgeEffects = ComponentProps<typeof ScrollViewMarker>["scrollEdgeEffects"];

const DEFAULT_SCROLL_EDGE_EFFECTS = nativeHeaderScrollEdgeEffects(Platform.OS, Platform.Version);

export const NativeScrollEdgeEffectsContext = createContext<ScrollEdgeEffects>(undefined);

export function NativeScrollViewMarker(props: ComponentProps<typeof ScrollViewMarker>) {
  const effects = use(NativeScrollEdgeEffectsContext);
  return (
    <ScrollViewMarker
      {...props}
      scrollEdgeEffects={props.scrollEdgeEffects ?? effects ?? DEFAULT_SCROLL_EDGE_EFFECTS}
    />
  );
}

export function NativeScrollView(props: ComponentProps<typeof ScrollView>) {
  const scrollView = <ScrollView {...props} />;
  return Platform.OS === "ios" ? (
    <NativeScrollViewMarker style={{ flex: 1 }}>{scrollView}</NativeScrollViewMarker>
  ) : (
    scrollView
  );
}
