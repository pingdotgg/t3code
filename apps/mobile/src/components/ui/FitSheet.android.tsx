import type { ReactNode } from "react";
import { ScrollView, useWindowDimensions, View } from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { fitSheetBottomInset, type FitSheetProps } from "./FitSheet.types";
import { ScreenContent } from "./ScreenContent";
export type { FitSheetProps } from "./FitSheet.types";

/** The route sizes the sheet to this content, so the column shrinks to fit and stops short of the top. */
export function FitSheet({
  header,
  footer,
  avoidsKeyboard,
  children,
  contentContainerClassName = "gap-2 p-2",
  contentContainerStyle,
  ...scrollProps
}: FitSheetProps) {
  const insets = useSafeAreaInsets();
  return (
    // Material sheet drags follow the first nested-scrolling native view, and a header's
    // Compose button is one, so the content renders first in a reversed column.
    <SheetContainer avoidsKeyboard={avoidsKeyboard}>
      <ScreenContent fitToContents>
        <ScrollView
          {...scrollProps}
          nestedScrollEnabled
          contentContainerClassName={contentContainerClassName}
          className="shrink grow-0"
          contentContainerStyle={[
            footer ? undefined : { paddingBottom: fitSheetBottomInset(insets.bottom) },
            contentContainerStyle,
          ]}
        >
          {children}
          {/* Partial-height sheets keep submit actions inside the scrolling form. */}
          {footer ? (
            <View
              className="mt-4 bg-sheet-solid pt-3"
              style={{ paddingBottom: Math.max(insets.bottom, 16) }}
            >
              <View style={{ minHeight: 48 }}>{footer}</View>
            </View>
          ) : null}
        </ScrollView>
      </ScreenContent>
      {header}
    </SheetContainer>
  );
}

function SheetContainer(props: {
  readonly avoidsKeyboard?: boolean;
  readonly children: ReactNode;
}) {
  const { height } = useWindowDimensions();
  const style = { maxHeight: height * 0.92 };
  return props.avoidsKeyboard ? (
    <KeyboardAvoidingView
      automaticOffset
      behavior="padding"
      collapsable={false}
      className="flex-col-reverse bg-sheet"
      style={style}
    >
      {props.children}
    </KeyboardAvoidingView>
  ) : (
    <View collapsable={false} className="flex-col-reverse bg-sheet" style={style}>
      {props.children}
    </View>
  );
}
