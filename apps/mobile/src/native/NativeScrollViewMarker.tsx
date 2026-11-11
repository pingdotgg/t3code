import { requireNativeView, requireOptionalNativeModule } from "expo";
import { createContext, use, type ComponentProps } from "react";
import { Platform, ScrollView, type ViewProps } from "react-native";
// oxlint-disable-next-line eslint/no-restricted-imports -- The wrapper every screen must use.
import { ScrollViewMarker } from "react-native-screens";
import { nativeHeaderScrollEdgeEffects } from "./scrollEdgeEffects";

type ScrollEdgeEffects = ComponentProps<typeof ScrollViewMarker>["scrollEdgeEffects"];

const DEFAULT_SCROLL_EDGE_EFFECTS = nativeHeaderScrollEdgeEffects(Platform.OS, Platform.Version);

export const NativeScrollEdgeEffectsContext = createContext<ScrollEdgeEffects>(undefined);

function resolveScrollEdgeBleed() {
  try {
    const module = requireOptionalNativeModule<{
      readonly ViewPrototypes?: { readonly T3NativeControls_ScrollEdgeBleed?: unknown };
    }>("T3NativeControls");
    if (!module?.ViewPrototypes?.T3NativeControls_ScrollEdgeBleed) return null;
    return requireNativeView<ViewProps>("T3NativeControls", "ScrollEdgeBleed");
  } catch {
    return null;
  }
}
// Widens the scroll view under the side safe areas its column pads away (the Duo's vertical bar),
// so the header's scroll-edge blur, which UIKit draws inside the scroll view, reaches the bar
// while the content stays in the safe area. Every header scroll view comes through here.
const ScrollEdgeBleed = Platform.OS === "ios" ? resolveScrollEdgeBleed() : null;

/** Registers a screen's scroll view with its header. The only way to do so: see the lint rule. */
export function NativeScrollViewMarker(props: ComponentProps<typeof ScrollViewMarker>) {
  const effects = use(NativeScrollEdgeEffectsContext);
  const marker = (
    <ScrollViewMarker
      {...props}
      {...(ScrollEdgeBleed ? { style: { flex: 1 } } : {})}
      scrollEdgeEffects={props.scrollEdgeEffects ?? effects ?? DEFAULT_SCROLL_EDGE_EFFECTS}
    />
  );
  return ScrollEdgeBleed ? <ScrollEdgeBleed style={props.style}>{marker}</ScrollEdgeBleed> : marker;
}

export function NativeScrollView(props: ComponentProps<typeof ScrollView>) {
  const scrollView = <ScrollView {...props} />;
  return Platform.OS === "ios" ? (
    <NativeScrollViewMarker style={{ flex: 1 }}>{scrollView}</NativeScrollViewMarker>
  ) : (
    scrollView
  );
}
