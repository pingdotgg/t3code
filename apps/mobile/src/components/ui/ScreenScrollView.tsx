import { createContext, use, type ComponentProps } from "react";
import { Platform } from "react-native";
import { NativeScrollView as ScrollView } from "../../native/NativeScrollViewMarker";

export const ScreenScrollViewBottomInset = createContext(0);

export function ScreenScrollView(props: ComponentProps<typeof ScrollView>) {
  const bottomInset = use(ScreenScrollViewBottomInset);
  return (
    <ScrollView
      {...props}
      contentInset={
        Platform.OS === "ios" && bottomInset > 0
          ? { ...props.contentInset, bottom: (props.contentInset?.bottom ?? 0) + bottomInset }
          : props.contentInset
      }
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
