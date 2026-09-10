import { BlurView } from "expo-blur";
import { useContext, type RefObject } from "react";
import { Platform, StyleSheet, View, type ColorValue } from "react-native";

import { useAppearancePreferences } from "../features/settings/appearance/AppearancePreferencesProvider";
import { GlassBlurTargetContext } from "../lib/glassBlurTarget";
import { themeColorWithAlpha } from "../lib/mobileTheme";

/** Frosted backdrop for containers that clip their children to their shape. */
export function GlassBackdrop(props: {
  readonly fallbackColor?: ColorValue;
  readonly blurTarget?: RefObject<View | null>;
}) {
  const { themeAppearance } = useAppearancePreferences();
  const inheritedBlurTarget = useContext(GlassBlurTargetContext);
  const target = props.blurTarget ?? inheritedBlurTarget;
  const supportsBlur =
    Platform.OS === "ios" ||
    (Platform.OS === "android" && Platform.Version >= 31 && target !== undefined);
  const colorStyle =
    props.fallbackColor === undefined
      ? undefined
      : { backgroundColor: themeColorWithAlpha(String(props.fallbackColor), 1) };

  return (
    <>
      {/* Android samples a separate target. An opaque backing prevents any
          transparent pixels in that sample from exposing the unblurred feed.
          iOS samples its actual backdrop, so a backing there would hide it. */}
      {Platform.OS === "android" ? (
        <View pointerEvents="none" className="absolute inset-0 bg-card" style={colorStyle} />
      ) : null}
      {supportsBlur ? (
        <BlurView
          pointerEvents="none"
          blurTarget={target}
          blurMethod="dimezisBlurViewSdk31Plus"
          intensity={80}
          tint={themeAppearance === "dark" ? "dark" : "default"}
          style={StyleSheet.absoluteFill}
        />
      ) : null}
      <View
        pointerEvents="none"
        className="absolute inset-0 bg-card"
        style={[
          colorStyle,
          { opacity: supportsBlur ? (themeAppearance === "dark" ? 0.25 : 0.55) : 1 },
        ]}
      />
    </>
  );
}
