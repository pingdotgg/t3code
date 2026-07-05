import { memo } from "react";
import { useColorScheme, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { SceneryAttribution } from "./SceneryAttribution";
import { SceneryImage } from "./SceneryImage";
import { useSceneryPhoto } from "./use-scenery";

/**
 * Full-bleed chat wallpaper, the mobile port of the mac app's
 * SceneryChatBackground: the thread's scene (CDN pre-blurred) under a
 * window-tone wash so standard foreground/muted text stays legible over any
 * photo, plus a heavier top gradient the transparent glass header samples.
 * The layer is pointer-transparent except for the required Unsplash
 * attribution pill; render as the first child of the chat container.
 */
export const ChatWallpaper = memo(function ChatWallpaper(props: { readonly threadKey: string }) {
  const photo = useSceneryPhoto(props.threadKey);
  const isDark = useColorScheme() === "dark";
  const insets = useSafeAreaInsets();
  // Matches --color-scenery-scrim; literal here because CSS-gradient strings
  // can't reference theme variables.
  const edge = isDark ? "rgba(0, 0, 0, 0.55)" : "rgba(255, 255, 255, 0.72)";

  return (
    <View
      pointerEvents="box-none"
      style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0 }}
    >
      <SceneryImage
        fallbackSeed={props.threadKey}
        photo={photo}
        pointerEvents="none"
        style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0 }}
        variant="wallpaper"
      />
      <View className="absolute inset-0 bg-scenery-scrim" pointerEvents="none" />
      <View
        pointerEvents="none"
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          experimental_backgroundImage: `linear-gradient(180deg, ${edge} 0%, transparent 28%, transparent 78%, ${edge} 100%)`,
        }}
      />
      {photo ? (
        // Unsplash guideline: attribution must accompany displayed photos —
        // the wallpaper counts, not just the hero card. Sits under the glass
        // header, right-aligned, above the scrim.
        <View
          pointerEvents="box-none"
          style={{
            position: "absolute",
            top: insets.top + 52,
            right: 12,
            alignItems: "flex-end",
          }}
        >
          <SceneryAttribution photo={photo} />
        </View>
      ) : null}
    </View>
  );
});
