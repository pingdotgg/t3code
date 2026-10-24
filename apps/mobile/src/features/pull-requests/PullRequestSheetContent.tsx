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
  /** Sizes the sheet to its content on iOS as well, for short forms. */
  readonly compact?: boolean;
}) {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const { height: windowHeight } = useWindowDimensions();
  const android = Platform.OS === "android";
  const compactIos = Platform.OS === "ios" && props.compact === true;
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
      className={android ? "bg-sheet-solid pt-3" : "bg-sheet px-4 pt-3"}
      style={{ paddingBottom: Math.max(insets.bottom, 16) }}
    >
      {android ? <View style={{ minHeight: 48 }}>{props.footer}</View> : props.footer}
    </View>
  ) : null;
  return (
    <KeyboardAvoidingView
      enabled={!compactIos}
      automaticOffset
      behavior="padding"
      collapsable={false}
      className="bg-sheet ios:flex-1"
      style={android ? { maxHeight: windowHeight * 0.92 } : undefined}
    >
      <NativeStackScreenOptions
        options={{
          gestureEnabled: !props.busy,
          ...(android ? { sheetCornerRadius: 28, sheetAllowedDetents: "fitToContents" } : {}),
          ...(compactIos
            ? {
                sheetAllowedDetents: [compactDetent],
                contentStyle: { flex: 1, bottom: 0 },
              }
            : {}),
        }}
      />
      <View onLayout={(event) => setHeaderHeight(event.nativeEvent.layout.height)}>
        <SheetHeader
          presentation={android || compactIos ? "inline" : "native"}
          title={props.title}
          subtitle={props.subtitle}
          onCancel={() => navigation.goBack()}
          dismissDisabled={props.busy}
        />
      </View>
      <ScreenContent fitToContents={android}>
        <ScrollView
          nestedScrollEnabled
          className="android:shrink android:grow-0 ios:flex-1"
          contentInsetAdjustmentBehavior={compactIos ? "never" : "automatic"}
          onContentSizeChange={(_width, height) => setBodyHeight(height)}
          automaticallyAdjustKeyboardInsets={compactIos}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="interactive"
          contentContainerStyle={{
            paddingHorizontal: 16,
            paddingTop: compactIos ? 0 : 16,
            paddingBottom: props.compact ? Math.max(insets.bottom, 12) : 20,
          }}
        >
          <View className="gap-4" pointerEvents={props.busy ? "none" : "auto"}>
            {props.children}
            {/* Android partial-height sheets keep submit actions within the scrollable form. */}
            {android ? footer : null}
          </View>
        </ScrollView>
        {android ? null : footer}
      </ScreenContent>
    </KeyboardAvoidingView>
  );
}
