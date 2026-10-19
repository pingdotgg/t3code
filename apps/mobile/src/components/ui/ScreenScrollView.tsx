import type { ComponentProps } from "react";
import { Platform } from "react-native";
import { NativeScrollView as ScrollView } from "../../native/NativeScrollViewMarker";

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
