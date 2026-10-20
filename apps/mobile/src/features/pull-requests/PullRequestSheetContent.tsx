import { SheetHeader } from "../../components/ui/SheetHeader";
import { useNavigation } from "@react-navigation/native";
import { useState, type ReactNode } from "react";
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
  readonly compact?: boolean;
}) {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const { height: windowHeight } = useWindowDimensions();
  const android = Platform.OS === "android";
  const fitToContents = android && props.scrollable !== false;
  const compactIos = Platform.OS === "ios" && props.compact === true && props.scrollable !== false;
  const [headerHeight, setHeaderHeight] = useState(84);
  const [bodyHeight, setBodyHeight] = useState(144);
  const [footerHeight, setFooterHeight] = useState(0);
  // On iOS 26 the native fit-to-contents wrapper contains a flex SafeAreaView. Bound the
  // scene with a measured detent instead, so its header and scroll view can lay out normally.
  const compactDetent = Math.min(
    0.92,
    Math.max(
      0.25,
      (headerHeight + bodyHeight + (props.footer ? footerHeight : 0) + 24) / windowHeight,
    ),
  );
  const footer = props.footer ? (
    <View
      onLayout={(event) => setFooterHeight(event.nativeEvent.layout.height)}
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
      <View onLayout={(event) => setHeaderHeight(event.nativeEvent.layout.height)}>
      </View>
      <ScreenContent fitToContents={fitToContents}>
        {props.scrollable === false ? (
          <View className="flex-1" pointerEvents={props.busy ? "none" : "auto"}>
            {props.children}
          </View>
        ) : (
          <ScrollView
            nestedScrollEnabled
            className={fitToContents ? "shrink grow-0" : "ios:flex-1"}
            onContentSizeChange={(_width, height) => setBodyHeight(height)}
            automaticallyAdjustKeyboardInsets={compactIos}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="interactive"
            contentContainerStyle={{
              paddingHorizontal: 16,
              paddingTop: android ? 16 : 0,
              paddingBottom: props.compact ? Math.max(insets.bottom, 12) : 20,
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
      enabled={!compactIos}
      automaticOffset
      behavior="padding"
      collapsable={false}
      className={
        props.scrollable === false
          ? "flex-1 bg-sheet"
          : fitToContents
            ? "bg-sheet"
            : "bg-sheet ios:flex-1"
      }
      style={fitToContents ? { maxHeight: windowHeight * 0.92 } : undefined}
    >
      <NativeStackScreenOptions
        options={{
          gestureEnabled: !props.busy,
          ...(android ? { sheetCornerRadius: 28 } : {}),
          ...(fitToContents ? { sheetAllowedDetents: "fitToContents" } : {}),
          ...(compactIos
            ? {
                sheetAllowedDetents: [compactDetent],
                contentStyle: { flex: 1, bottom: 0 },
              }
            : {}),
        }}
      />
      {content}
    </KeyboardAvoidingView>
  );
}
