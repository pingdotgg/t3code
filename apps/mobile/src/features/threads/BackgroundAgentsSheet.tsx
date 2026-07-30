import type { StaticScreenProps } from "@react-navigation/native";
import { useNavigation } from "@react-navigation/native";
import {
  deriveBackgroundTasks,
  type BackgroundTask,
} from "@t3tools/client-runtime/state/background-tasks";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { useMemo } from "react";
import { ActivityIndicator, Platform, ScrollView, View } from "react-native";
import { Screen, ScreenStack, ScreenStackHeaderConfig } from "react-native-screens";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AndroidSheetHeader } from "../../components/AndroidScreenHeader";
import { AppText as Text } from "../../components/AppText";
import { SymbolView, type AppSymbolName } from "../../components/AppSymbol";
import { nativeHeaderScrollEdgeEffects } from "../../native/StackHeader";
import { relativeTime } from "../../lib/time";
import { useThemeColor } from "../../lib/useThemeColor";
import { useThreadDetail } from "../../state/use-thread-detail";
import { elapsedLabel, useLiveElapsedClock } from "./thread-swarm-rail";

const HEADER_SCROLL_EDGE_EFFECTS = nativeHeaderScrollEdgeEffects(Platform.OS, Platform.Version);

const MONO_FONT = Platform.select({
  ios: "Menlo",
  android: "monospace",
  default: "monospace",
});

const SHEET_TITLE = "Background agents";

type BackgroundAgentsSheetProps = StaticScreenProps<{
  readonly environmentId: string;
  readonly threadId: string;
}>;

function settledGlyph(status: BackgroundTask["status"]): AppSymbolName {
  if (status === "failed") return "exclamationmark.triangle";
  if (status === "stopped") return "xmark";
  return "checkmark";
}

function RunningTaskRow(props: {
  readonly task: BackgroundTask;
  readonly nowMs: number;
  readonly accentColor: string;
}) {
  const duration = elapsedLabel(props.task.startedAt, props.nowMs);

  return (
    <View
      accessible
      accessibilityLabel={`${props.task.name}, running for ${duration}${
        props.task.latestProgress === null ? "" : `. ${props.task.latestProgress}`
      }`}
      className="flex-row items-center gap-3 px-1 py-3"
    >
      <ActivityIndicator size="small" color={props.accentColor} />
      <View className="min-w-0 flex-1 gap-0.5">
        <Text className="text-foreground text-base font-t3-bold" numberOfLines={1}>
          {props.task.name}
        </Text>
        {props.task.latestProgress !== null ? (
          <Text
            className="text-xs leading-snug"
            numberOfLines={1}
            ellipsizeMode="tail"
            style={{ color: props.accentColor, fontFamily: MONO_FONT, opacity: 0.75 }}
          >
            {props.task.latestProgress}
          </Text>
        ) : null}
      </View>
      <Text
        className="text-foreground-muted text-xs tabular-nums"
        style={{ fontFamily: MONO_FONT }}
      >
        {duration}
      </Text>
    </View>
  );
}

function SettledTaskRow(props: { readonly task: BackgroundTask }) {
  const iconSubtleColor = useThemeColor("--color-icon-subtle");
  const settledLabel =
    props.task.settledAt === null ? null : `settled ${relativeTime(props.task.settledAt)} ago`;

  return (
    <View
      accessible
      accessibilityLabel={`${props.task.name}, ${props.task.status}${
        settledLabel === null ? "" : `, ${settledLabel}`
      }`}
      className="flex-row items-center gap-3 px-1 py-3 opacity-[0.55]"
    >
      <View className="bg-subtle h-7 w-7 items-center justify-center rounded-full">
        <SymbolView
          name={settledGlyph(props.task.status)}
          size={13}
          tintColor={iconSubtleColor}
          type="monochrome"
          weight="semibold"
        />
      </View>
      <Text className="text-foreground min-w-0 flex-1 text-base font-t3-medium" numberOfLines={1}>
        {props.task.name}
      </Text>
      {settledLabel !== null ? (
        <Text className="text-foreground-muted text-xs">{settledLabel}</Text>
      ) : null}
    </View>
  );
}

export function BackgroundAgentsSheet(props: BackgroundAgentsSheetProps) {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const environmentId = EnvironmentId.make(props.route.params.environmentId);
  const threadId = ThreadId.make(props.route.params.threadId);

  const foregroundColor = String(useThemeColor("--color-foreground"));
  const sheetColor = String(useThemeColor("--color-sheet"));
  const accentColor = String(useThemeColor("--color-user-bubble"));

  // The sheet reads the thread projection itself rather than taking a
  // snapshot through route params: tasks start and settle while it is open.
  const thread = Option.getOrNull(useThreadDetail({ environmentId, threadId }).data);
  const tasks = useMemo(
    () => deriveBackgroundTasks(thread?.activities ?? [], thread?.session ?? null),
    [thread],
  );

  const nowMs = useLiveElapsedClock(tasks.running.length > 0);
  const runningCaption = `${tasks.running.length} running`;

  const content = (
    <ScrollView
      className="flex-1 bg-screen"
      contentInsetAdjustmentBehavior={Platform.OS === "ios" ? "automatic" : "never"}
      showsVerticalScrollIndicator={false}
      contentInset={{ bottom: Math.max(insets.bottom, 18) + 18 }}
      contentContainerStyle={{ paddingHorizontal: 20, paddingTop: 8, gap: 14 }}
    >
      <Text className="text-foreground-muted text-2xs font-t3-bold tracking-[0.9px] uppercase">
        {runningCaption}
      </Text>

      {tasks.running.length === 0 && tasks.settled.length === 0 ? (
        <View className="rounded-[22px] border border-border bg-card px-4 py-5">
          <Text className="text-foreground-muted text-sm leading-snug">
            No background agents on this thread.
          </Text>
        </View>
      ) : null}

      {tasks.running.length > 0 ? (
        <View className="overflow-hidden rounded-[22px] border border-border bg-card px-4 py-1">
          {tasks.running.map((task, index) => (
            <View key={task.taskId}>
              {index > 0 ? <View className="h-px bg-border" /> : null}
              <RunningTaskRow task={task} nowMs={nowMs} accentColor={accentColor} />
            </View>
          ))}
        </View>
      ) : null}

      {tasks.settled.length > 0 ? (
        <View className="gap-2">
          <Text className="text-foreground-muted text-2xs font-t3-bold tracking-[0.9px] uppercase">
            Finished
          </Text>
          <View className="overflow-hidden rounded-[22px] border border-border bg-card px-4 py-1">
            {tasks.settled.map((task, index) => (
              <View key={task.taskId}>
                {index > 0 ? <View className="h-px bg-border" /> : null}
                <SettledTaskRow task={task} />
              </View>
            ))}
          </View>
        </View>
      ) : null}
    </ScrollView>
  );

  if (Platform.OS === "ios") {
    // A screen presented as formSheet never renders a stack header, so — like
    // the git sheets — the header comes from a nested native stack INSIDE it.
    return (
      <View collapsable={false} className="flex-1 bg-sheet">
        <ScreenStack style={{ flex: 1 }}>
          <Screen
            activityState={2}
            enabled
            isNativeStack
            screenId="thread-background-agents-sheet-native"
            scrollEdgeEffects={HEADER_SCROLL_EDGE_EFFECTS}
            style={{ backgroundColor: sheetColor, flex: 1 }}
          >
            {content}
            <ScreenStackHeaderConfig
              backgroundColor="rgba(0,0,0,0)"
              color={foregroundColor}
              hideBackButton
              hideShadow={false}
              navigationItemStyle="editor"
              title={SHEET_TITLE}
              titleColor={foregroundColor}
              titleFontSize={18}
              titleFontWeight="800"
              translucent
            />
          </Screen>
        </ScreenStack>
      </View>
    );
  }

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      <AndroidSheetHeader
        title={SHEET_TITLE}
        subtitle={runningCaption}
        onBack={() => navigation.goBack()}
      />
      {content}
    </View>
  );
}
