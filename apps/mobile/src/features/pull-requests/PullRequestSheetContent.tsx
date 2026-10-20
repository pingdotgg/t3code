import { SheetHeader } from "../../components/ui/SheetHeader";
import { useNavigation } from "@react-navigation/native";
import type { ReactNode } from "react";
import { Platform, ScrollView, useWindowDimensions, View } from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { NativeStackScreenOptions } from "../../native/StackHeader";

export function PullRequestSheetContent(props: {
  readonly title: string;
  readonly subtitle: string;
  readonly busy?: boolean;
  readonly children: ReactNode;
  readonly footer?: ReactNode;
  readonly scrollable?: boolean;
}) {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const { height: windowHeight } = useWindowDimensions();
  const android = Platform.OS === "android";
  const fitToContents = android && props.scrollable !== false;
  const footer = props.footer ? (
    <View
      className={
        android && props.scrollable !== false ? "bg-sheet-solid pt-3" : "bg-sheet px-4 pt-3"
      }
      style={{ paddingBottom: Math.max(insets.bottom, 16) }}
    >
      {android ? <View style={{ minHeight: 48 }}>{props.footer}</View> : props.footer}
    </View>
  ) : null;
  const content = (
    <>
      <SheetHeader
        presentation="inline"
        title={props.title}
        subtitle={props.subtitle}
        onCancel={() => navigation.goBack()}
        dismissDisabled={props.busy}
      />
      <ScreenContent fitToContents={fitToContents}>
        {props.scrollable === false ? (
          <View className="flex-1" pointerEvents={props.busy ? "none" : "auto"}>
            {props.children}
          </View>
        ) : (
          <ScrollView
            nestedScrollEnabled
            className="android:shrink android:grow-0 ios:flex-1"
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={{
              paddingHorizontal: 16,
              paddingTop: android ? 16 : 0,
              paddingBottom: 20,
            }}
          >
            <View className="gap-4" pointerEvents={props.busy ? "none" : "auto"}>
              {props.children}
              {/* Android partial-height sheets keep submit actions within the scrollable form. */}
              {android ? footer : null}
            </View>
          </ScrollView>
        )}

        {!android || props.scrollable === false ? footer : null}
      </ScreenContent>
    </>
  );
  return (
    <KeyboardAvoidingView
      automaticOffset
      behavior="padding"
      collapsable={false}
      className={props.scrollable === false ? "flex-1 bg-sheet" : "bg-sheet ios:flex-1"}
      style={fitToContents ? { maxHeight: windowHeight * 0.92 } : undefined}
    >
      <NativeStackScreenOptions
        options={{
          gestureEnabled: !props.busy,
          ...(android ? { sheetCornerRadius: 28 } : {}),
          ...(fitToContents ? { sheetAllowedDetents: "fitToContents" } : {}),
        }}
      />
      {content}
    </KeyboardAvoidingView>
  );
}
