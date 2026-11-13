import { View } from "react-native";
import { KeyboardAvoidingView, KeyboardStickyView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import type { KeyboardSheetBodyProps } from "./KeyboardSheetBody.types";
export type { KeyboardSheetBodyProps } from "./KeyboardSheetBody.types";

const TOOLBAR_CLEARANCE = 72;

/** The toolbar sticks to the keyboard on its own, over the body's bottom edge. */
export function KeyboardSheetBody(props: KeyboardSheetBodyProps) {
  const insets = useSafeAreaInsets();
  return (
    <>
      <KeyboardAvoidingView automaticOffset behavior="padding" className="flex-1">
        <View
          className="flex-1 px-5"
          style={{
            paddingTop: 8,
            paddingBottom: props.toolbar ? TOOLBAR_CLEARANCE : Math.max(insets.bottom, 18),
          }}
        >
          {props.children}
        </View>
      </KeyboardAvoidingView>
      {props.toolbar ? (
        <KeyboardStickyView
          className="absolute inset-x-0 bottom-0"
          offset={{ closed: 0, opened: 0 }}
        >
          <View
            className="flex-row items-center gap-3 border-t border-border bg-sheet px-5 pt-2"
            style={{ paddingBottom: Math.max(insets.bottom, 10) }}
          >
            {props.toolbar}
          </View>
        </KeyboardStickyView>
      ) : null}
    </>
  );
}
