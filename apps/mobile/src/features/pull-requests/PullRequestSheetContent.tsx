import { useNavigation } from "@react-navigation/native";
import type { ReactNode } from "react";
import { Platform, ScrollView, useWindowDimensions, View } from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AppText as Text } from "../../components/AppText";
import { AndroidSheetHeader } from "../../components/AndroidScreenHeader";
import { IconButton } from "../../components/IconButton";
import { MaterialScreenContent } from "../../components/MaterialScreenContent";
import { ControlPill } from "../../components/ControlPill";
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
      {android ? (
        <AndroidSheetHeader
          title={props.title}
          subtitle={props.subtitle}
          hideBottomBorder
          leading={
            <IconButton
              icon="arrow.left"
              accessibilityLabel="Close"
              disabled={props.busy}
              tintColorClassName="accent-header-foreground"
              onPress={() => navigation.goBack()}
            />
          }
        />
      ) : (
        <View className="flex-row items-center gap-2 px-4 pt-5 pb-5">
          <ControlPill
            icon="xmark"
            accessibilityLabel="Close"
            disabled={props.busy}
            onPress={() => navigation.goBack()}
          />
          <View className="min-w-0 flex-1 items-center gap-1">
            <Text className="text-center text-base font-t3-bold">{props.title}</Text>
            <Text numberOfLines={1} className="text-center text-xs text-foreground-muted">
              {props.subtitle}
            </Text>
          </View>
          <View className="w-11" />
        </View>
      )}
      <MaterialScreenContent fitToContents={fitToContents}>
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
      </MaterialScreenContent>
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
