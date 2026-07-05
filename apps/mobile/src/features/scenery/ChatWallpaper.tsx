import { memo } from "react";
import { useColorScheme, View } from "react-native";

import { SceneryImage } from "./SceneryImage";
import { useSceneryPhoto } from "./use-scenery";

/**
 * Full-bleed chat wallpaper, the mobile port of the mac app's
 * SceneryChatBackground: the thread's scene (CDN pre-blurred) under a
 * window-tone wash so standard foreground/muted text stays legible over any
 * photo, plus a heavier top gradient the transparent glass header samples.
 * Pointer-transparent; render as the first child of the chat container.
 */
export const ChatWallpaper = memo(function ChatWallpaper(props: { readonly threadKey: string }) {
  const photo = useSceneryPhoto(props.threadKey);
  const isDark = useColorScheme() === "dark";
  // Matches --color-scenery-scrim; literal here because CSS-gradient strings
  // can't reference theme variables.
  const edge = isDark ? "rgba(0, 0, 0, 0.55)" : "rgba(255, 255, 255, 0.72)";

  return (
    <View
      pointerEvents="none"
      style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0 }}
    >
      <SceneryImage
        fallbackSeed={props.threadKey}
        photo={photo}
        style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0 }}
        variant="wallpaper"
      />
      <View className="absolute inset-0 bg-scenery-scrim" />
      <View
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          experimental_backgroundImage: `linear-gradient(180deg, ${edge} 0%, transparent 28%, transparent 78%, ${edge} 100%)`,
        }}
      />
    </View>
  );
});
