import { Image } from "expo-image";
import { memo, useCallback } from "react";
import type { StyleProp, ViewStyle } from "react-native";
import { View } from "react-native";
import { useReducedMotion } from "react-native-reanimated";

import { washGradientStyle } from "./alpine-theme";
import type { SceneryVariant } from "./scenery-store";
import { appSceneryStore } from "./scenery-store";
import type { SceneryPhoto } from "./unsplash";

/**
 * Photo-or-gradient scenery fill: the deterministic duotone wash renders
 * immediately, then the photo cross-fades in on top once decoded. With no
 * photo (empty pool, no key) the wash simply stays — the degraded state is
 * on-brand, not a gray box.
 */
export const SceneryImage = memo(function SceneryImage(props: {
  readonly photo: SceneryPhoto | null;
  readonly variant: SceneryVariant;
  /** Wash seed when no photo is available (thread key, any stable id). */
  readonly fallbackSeed: string;
  readonly style?: StyleProp<ViewStyle>;
  readonly pointerEvents?: "none" | "box-none" | "auto" | "box-only";
}) {
  const reduceMotion = useReducedMotion();
  const photoId = props.photo?.id ?? null;

  const handleLoad = useCallback(() => {
    if (photoId !== null) {
      appSceneryStore.registerDownloadIfNeeded(photoId);
    }
  }, [photoId]);

  return (
    <View
      pointerEvents={props.pointerEvents}
      style={[
        { overflow: "hidden" },
        washGradientStyle(photoId ?? props.fallbackSeed),
        props.style,
      ]}
    >
      {props.photo ? (
        <Image
          accessible={false}
          cachePolicy="disk"
          contentFit="cover"
          onLoad={handleLoad}
          recyclingKey={props.photo.id}
          source={{ uri: appSceneryStore.variantURL(props.photo, props.variant) }}
          style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0 }}
          transition={{ duration: reduceMotion ? 150 : 450, effect: "cross-dissolve" }}
        />
      ) : null}
    </View>
  );
});
