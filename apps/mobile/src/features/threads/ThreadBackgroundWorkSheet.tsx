import { useAtomValue } from "@effect/atom-react";
import { StackActions, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  presentPendingBackgroundWork,
  type PendingBackgroundWorkItem,
} from "@t3tools/client-runtime/state/thread-execution";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Haptics from "expo-haptics";
import { Platform, Pressable, ScrollView, View } from "react-native";
import { ScreenStack } from "react-native-screens";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AndroidSheetHeader } from "../../components/ui/AndroidScreenHeader";
import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { NativeStackScreenOptions, nativeHeaderScrollEdgeEffects } from "../../native/StackHeader";
import { NativeHeader, NativeScreen } from "../../native/ThemedScreenStack";
import { environmentThreadShells } from "../../state/threads";
import { useAdaptiveWorkspaceLayout } from "../layout/AdaptiveWorkspaceLayout";

const HEADER_SCROLL_EDGE_EFFECTS = nativeHeaderScrollEdgeEffects(Platform.OS, Platform.Version);
const KIND_LABELS = {
  subagent: "Subagent",
  command: "Command",
  monitor: "Monitor",
  background_task: "Background task",
} as const;

type BackgroundWorkTarget = { readonly environmentId: EnvironmentId; readonly threadId: ThreadId };

export function ThreadBackgroundWorkSheet({ route }: StaticScreenProps<BackgroundWorkTarget>) {
  const { layout } = useAdaptiveWorkspaceLayout();
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const target = route.params;
  const thread = useAtomValue(
    environmentThreadShells.threadShellAtom(scopeThreadRef(target.environmentId, target.threadId)),
  );
  const presentation = presentPendingBackgroundWork(thread?.pendingBackgroundTasks ?? []);
  const openThread = (threadId: ThreadId) => {
    void Haptics.selectionAsync();
    // A thread replaces the leaf sheet so workspace back navigation still works.
    navigation.dispatch(
      StackActions.replace("Thread", { environmentId: target.environmentId, threadId }),
    );
  };
  const content = (
    <ScrollView
      nestedScrollEnabled
      className="flex-1"
      contentInsetAdjustmentBehavior={Platform.OS === "ios" ? "automatic" : "never"}
      contentContainerClassName="px-5 pb-6"
      contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 16) + 8 }}
    >
      {presentation === null ? (
        <Text className="pt-6 text-center text-sm text-foreground-muted">
          Nothing running in the background.
        </Text>
      ) : (
        presentation.items.map((item) => (
          <BackgroundWorkRow key={item.taskId} item={item} onOpen={openThread} />
        ))
      )}
    </ScrollView>
  );
  if (Platform.OS === "ios") {
    return (
      <View collapsable={false} className="flex-1 bg-sheet">
        <ScreenStack style={{ flex: 1 }}>
          <NativeScreen
            activityState={2}
            enabled
            isNativeStack
            screenId="thread-background-work-sheet-native"
            scrollEdgeEffects={HEADER_SCROLL_EDGE_EFFECTS}
            className="flex-1 bg-sheet"
          >
            {content}
            <NativeHeader
              backgroundColor="rgba(0,0,0,0)"
              tintColorClassName="accent-foreground"
              hideBackButton
              hideShadow={false}
              title="Background work"
              titleColorClassName="accent-foreground"
              titleFontSize={18}
              titleFontWeight="800"
              translucent
            />
          </NativeScreen>
        </ScreenStack>
      </View>
    );
  }
  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      <NativeStackScreenOptions options={{ sheetCornerRadius: 28 }} />
      <AndroidSheetHeader title="Background work" onBack={() => navigation.goBack()} />
      <ScreenContent insetHorizontal={layout.usesSplitView}>{content}</ScreenContent>
    </View>
  );
}

function BackgroundWorkRow(props: {
  readonly item: PendingBackgroundWorkItem;
  readonly onOpen: (threadId: ThreadId) => void;
}) {
  const { item } = props;
  const childThreadId = item.childThreadId;
  const row = (
    <View className="flex-row items-center gap-3 border-b border-border py-3.5">
      <SymbolView
        name={
          item.kind === "subagent" ? "person.2" : item.kind === "monitor" ? "clock" : "terminal"
        }
        size={15}
        tintColorClassName="accent-foreground-muted"
        type="monochrome"
      />
      <View className="min-w-0 flex-1">
        <Text className="font-t3-medium text-sm text-foreground">{item.label}</Text>
        <Text className="text-xs text-foreground-muted">{KIND_LABELS[item.kind]}</Text>
      </View>
      {childThreadId === undefined ? null : (
        <SymbolView name="chevron.right" size={12} tintColorClassName="accent-icon-subtle" />
      )}
    </View>
  );
  return childThreadId === undefined ? (
    <View accessible>{row}</View>
  ) : (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={`Open subagent ${item.label}`}
      onPress={() => props.onOpen(childThreadId)}
      className="active:opacity-70"
    >
      {row}
    </Pressable>
  );
}
