import { useNavigation } from "@react-navigation/native";
import type { ReactNode } from "react";
import { ScrollView, View } from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AppText as Text } from "../../components/AppText";
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
  return (
    <KeyboardAvoidingView automaticOffset behavior="padding" className="flex-1 bg-sheet">
      <NativeStackScreenOptions options={{ gestureEnabled: !props.busy }} />
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
      {props.scrollable === false ? (
        <View className="flex-1" pointerEvents={props.busy ? "none" : "auto"}>
          {props.children}
        </View>
      ) : (
        <ScrollView
          className="flex-1"
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 20 }}
        >
          <View className="gap-4" pointerEvents={props.busy ? "none" : "auto"}>
            {props.children}
          </View>
        </ScrollView>
      )}
      {props.footer ? (
        <View className="bg-sheet px-4 pt-3" style={{ paddingBottom: Math.max(insets.bottom, 16) }}>
          {props.footer}
        </View>
      ) : null}
    </KeyboardAvoidingView>
  );
}
