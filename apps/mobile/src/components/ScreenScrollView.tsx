import type { ComponentProps } from "react";
import { Platform } from "react-native";
import { NativeScrollView as ScrollView } from "../native/NativeScrollViewMarker";

/** Keeps forms and settings readable inside a wide pane while its surface fills the screen. */
export function ScreenScrollView(props: ComponentProps<typeof ScrollView>) {
  return (
    <ScrollView
      {...props}
      contentContainerStyle={[
        props.contentContainerStyle,
        Platform.OS === "android" && {
          width: "100%",
          maxWidth: 720,
          alignSelf: "center",
        },
      ]}
    />
  );
}
