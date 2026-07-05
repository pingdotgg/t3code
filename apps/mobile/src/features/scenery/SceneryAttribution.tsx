import { memo } from "react";
import { Pressable } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { tryOpenExternalUrl } from "../../lib/openExternalUrl";
import type { SceneryPhoto } from "./unsplash";
import { UNSPLASH_UTM } from "./unsplash";

const UNSPLASH_URL = `https://unsplash.com/${UNSPLASH_UTM}`;

/**
 * "Photo by NAME on Unsplash" pill — required by the Unsplash guidelines
 * wherever a photo shows prominently (heroes, wallpapers; not tiny thumbs).
 * Links carry the mandated UTM params.
 */
export const SceneryAttribution = memo(function SceneryAttribution(props: {
  readonly photo: SceneryPhoto;
}) {
  const photographerUrl = props.photo.photographerProfileURL
    ? `${props.photo.photographerProfileURL}${UNSPLASH_UTM}`
    : UNSPLASH_URL;
  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={`Photo by ${props.photo.photographerName} on Unsplash`}
      className="self-start rounded-full bg-attribution-pill px-2.5 py-1 active:opacity-70"
      hitSlop={6}
      onPress={() => void tryOpenExternalUrl(photographerUrl, "attribution")}
    >
      <Text className="text-3xs font-t3-medium text-white/90" numberOfLines={1}>
        Photo by {props.photo.photographerName} on Unsplash
      </Text>
    </Pressable>
  );
});
