import type { ReactNode } from "react";
import { ScrollView, View } from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { fitSheetBottomInset, type FitSheetProps } from "./FitSheet.types";
import { ScreenContent } from "./ScreenContent";
export type { FitSheetProps } from "./FitSheet.types";

export function FitSheet({
  header,
  footer,
  avoidsKeyboard,
  children,
  contentContainerClassName = "gap-4 px-5 pt-2",
  contentContainerStyle,
  ...scrollProps
}: FitSheetProps) {
  const insets = useSafeAreaInsets();
  return (
    <SheetContainer avoidsKeyboard={avoidsKeyboard}>
      {header}
      <ScreenContent>
        <ScrollView
          {...scrollProps}
          nestedScrollEnabled
          contentContainerClassName={contentContainerClassName}
          contentInsetAdjustmentBehavior="automatic"
          className="flex-1"
          contentContainerStyle={[
            footer ? undefined : { paddingBottom: fitSheetBottomInset(insets.bottom) },
            contentContainerStyle,
          ]}
        >
          {children}
        </ScrollView>
        {footer ? (
          <View
            className="bg-sheet px-4 pt-3"
            style={{ paddingBottom: Math.max(insets.bottom, 16) }}
          >
            {footer}
          </View>
        ) : null}
      </ScreenContent>
    </SheetContainer>
  );
}

function SheetContainer(props: {
  readonly avoidsKeyboard?: boolean;
  readonly children: ReactNode;
}) {
  return props.avoidsKeyboard ? (
    <KeyboardAvoidingView
      automaticOffset
      behavior="padding"
      collapsable={false}
      className="flex-1 bg-sheet"
    >
      {props.children}
    </KeyboardAvoidingView>
  ) : (
    <View collapsable={false} className="flex-1 bg-sheet">
      {props.children}
    </View>
  );
}
