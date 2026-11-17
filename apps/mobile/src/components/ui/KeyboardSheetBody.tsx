import { View } from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import type { KeyboardSheetBodyProps } from "./KeyboardSheetBody.types";
import { useBarOverlap } from "./useBarInset";
export type { KeyboardSheetBodyProps } from "./KeyboardSheetBody.types";

/** A sheet's body that stays above the keyboard, with its toolbar between the two. */
export function KeyboardSheetBody(props: KeyboardSheetBodyProps) {
  const insets = useSafeAreaInsets();
  // The sheet's glass bar floats over its content, and only scroll views inset for it on their own.
  const barOverlap = useBarOverlap();
  return (
    <KeyboardAvoidingView automaticOffset behavior="padding" className="flex-1">
      <View
        className="flex-1 px-5"
        style={{
          paddingTop: barOverlap + 8,
          paddingBottom: props.toolbar ? 0 : Math.max(insets.bottom, 18),
        }}
      >
        {props.children}
      </View>
      {props.toolbar ? (
        <View className="flex-row items-center gap-3 bg-sheet px-5 py-2">{props.toolbar}</View>
      ) : null}
    </KeyboardAvoidingView>
  );
}
