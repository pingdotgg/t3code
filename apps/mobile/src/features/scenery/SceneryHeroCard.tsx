import { memo } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { SceneryAttribution } from "./SceneryAttribution";
import { SceneryImage } from "./SceneryImage";
import type { SceneryPhoto } from "./unsplash";

/**
 * Daily-featured Dolomites hero for empty states: full-width photo card with
 * the scene name and the required Unsplash attribution over a bottom scrim.
 * Renders the gradient wash alone while the pool is empty (no key/offline).
 */
export const SceneryHeroCard = memo(function SceneryHeroCard(props: {
  readonly photo: SceneryPhoto | null;
  readonly fallbackSeed?: string;
}) {
  return (
    <View className="overflow-hidden rounded-[22px]" style={{ height: 210 }}>
      <SceneryImage
        fallbackSeed={props.fallbackSeed ?? "daily-hero"}
        photo={props.photo}
        style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0 }}
        variant="hero"
      />
      <View
        pointerEvents="none"
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          bottom: 0,
          height: 110,
          experimental_backgroundImage:
            "linear-gradient(180deg, transparent 0%, rgba(0, 0, 0, 0.45) 100%)",
        }}
      />
      <View className="absolute bottom-0 left-0 right-0 gap-1.5 p-4">
        {props.photo ? (
          <>
            <Text className="text-xl font-t3-bold text-white" numberOfLines={1}>
              {props.photo.name}
            </Text>
            <SceneryAttribution photo={props.photo} />
          </>
        ) : null}
      </View>
    </View>
  );
});
