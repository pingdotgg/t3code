import { useAtomValue } from "@effect/atom-react";
import { StackActions, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  presentPendingBackgroundWork,
  type PendingBackgroundWorkItem,
} from "@t3tools/client-runtime/state/thread-execution";
import type { EnvironmentId, ThreadId, ThreadPullRequestLink } from "@t3tools/contracts";
import { findPullRequestForWatchTask } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import * as Haptics from "expo-haptics";
import { Platform, Pressable, ScrollView, View } from "react-native";
import { ScreenStack } from "react-native-screens";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AndroidSheetHeader } from "../../components/ui/AndroidScreenHeader";
import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import * as Dialog from "../../components/ui/Dialog";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { cn } from "../../lib/cn";
import { tryOpenExternalUrl } from "../../lib/openExternalUrl";
import { NativeStackScreenOptions, nativeHeaderScrollEdgeEffects } from "../../native/StackHeader";
import { NativeHeader, NativeScreen } from "../../native/ThemedScreenStack";
import { environmentThreadShells } from "../../state/threads";
import { useAdaptiveWorkspaceLayout } from "../layout/AdaptiveWorkspaceLayout";
import { pullRequestChecksStatus, pullRequestStatus } from "../pull-requests/pullRequestStatus";

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
        presentation.items.map((item) => {
          const link =
            item.kind === "monitor"
              ? findPullRequestForWatchTask(item.taskId, thread?.pullRequests)
              : undefined;
          return link ? (
            <PullRequestMonitorRow key={item.taskId} link={link} />
          ) : (
            <BackgroundWorkRow key={item.taskId} item={item} onOpen={openThread} />
          );
        })
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

const CHECKS_LABELS = {
  passing: "checks passing",
  pending: "checks pending",
  failing: "checks failing",
} as const;

function PullRequestMonitorRow(props: { readonly link: ThreadPullRequestLink }) {
  const { link } = props;
  // The snapshot arrives from the host after the link, so the row must stay tappable without it.
  const snapshot = link.snapshot;
  const status = snapshot ? pullRequestStatus(snapshot) : null;
  const checksState = snapshot?.state === "open" ? snapshot.checksState : undefined;
  const checks = checksState ? pullRequestChecksStatus(checksState) : null;
  const checksLabel = checksState ? CHECKS_LABELS[checksState] : undefined;
  const title = snapshot?.title ?? `Pull request #${link.number}`;
  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={`Watching pull request ${link.number}, ${title}${status ? `, ${status.label}` : ""}${checksLabel ? `, ${checksLabel}` : ""}`}
      accessibilityHint="Opens this pull request externally"
      onPress={() => {
        void tryOpenExternalUrl(link.url, "pull-request").then((opened) => {
          if (!opened) Dialog.alert("Unable to open PR", "The pull request could not be opened.");
        });
      }}
      className="active:opacity-70"
    >
      <View className="flex-row items-center gap-3 border-b border-border py-3.5">
        <SymbolView
          name={{ ios: "bolt", android: "bolt" }}
          size={15}
          tintColorClassName="accent-foreground-muted"
          type="monochrome"
        />
        <View className="min-w-0 flex-1 gap-0.5">
          <Text className="font-t3-medium text-sm text-foreground" numberOfLines={2}>
            {title}
          </Text>
          <View className="flex-row flex-wrap items-center gap-x-1.5 gap-y-0.5">
            <Text className={cn("font-t3-medium text-xs", status?.text ?? "text-foreground-muted")}>
              #{link.number}
            </Text>
            <Text className="text-xs text-foreground-muted">
              {status ? `Watching · ${status.label}` : "Watching"}
            </Text>
            {checks ? (
              <View className="flex-row items-center gap-1">
                <SymbolView name={checks.icon} size={12} tintColorClassName={checks.tint} />
                <Text className="text-xs text-foreground-muted">{checksLabel}</Text>
              </View>
            ) : null}
          </View>
        </View>
        <SymbolView name="arrow.up.right" size={12} tintColorClassName="accent-icon-subtle" />
      </View>
    </Pressable>
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
