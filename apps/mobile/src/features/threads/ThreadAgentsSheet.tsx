import { useAtomValue } from "@effect/atom-react";
import type { ThreadTurnSubagents } from "@t3tools/client-runtime/state/thread-subagents";
import type { EnvironmentId, OrchestrationV2Subagent, ThreadId } from "@t3tools/contracts";
import { formatDuration } from "@t3tools/shared/orchestrationTiming";
import { StackActions, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import * as DateTime from "effect/DateTime";
import * as Haptics from "expo-haptics";
import { useEffect, useState } from "react";
import { Platform, Pressable, ScrollView, View } from "react-native";
import { Screen, ScreenStack, ScreenStackHeaderConfig } from "react-native-screens";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AndroidSheetHeader } from "../../components/AndroidScreenHeader";
import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { cn } from "../../lib/cn";
import { useUniwindTheme } from "../../lib/useUniwindTheme";
import { environmentThreadDetails } from "../../state/threads";
import { nativeHeaderScrollEdgeEffects } from "../../native/StackHeader";
import { resolveSubagentRowPresentation, type SubagentRowTone } from "./threadAgentsPresentation";

const HEADER_SCROLL_EDGE_EFFECTS = nativeHeaderScrollEdgeEffects(Platform.OS, Platform.Version);

const TONE_DOT_CLASS = {
  working: "bg-adaptive-sky-600-400",
  completed: "bg-adaptive-emerald-600-400",
  failed: "bg-adaptive-rose-600-400",
  stopped: "bg-foreground-muted",
} as const satisfies Record<SubagentRowTone, string>;

type AgentsTarget = { readonly environmentId: EnvironmentId; readonly threadId: ThreadId };

export function useThreadTurnSubagents(target: AgentsTarget): ThreadTurnSubagents | null {
  return useAtomValue(environmentThreadDetails.turnSubagentsAtom(target));
}

export function ThreadAgentsSheet({ route }: StaticScreenProps<AgentsTarget>) {
  const target = route.params;
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const theme = useUniwindTheme();
  const turn = useThreadTurnSubagents(target);
  const subagents = turn?.subagents ?? [];
  const hasLiveAgent = (turn?.liveCount ?? 0) > 0;

  const openChildThread = (childThreadId: ThreadId) => {
    void Haptics.selectionAsync();
    // Replace rather than push: the sheet is a leaf, and the child thread
    // belongs in the workspace stack where Home's back button expects it.
    navigation.dispatch(
      StackActions.replace("Thread", {
        environmentId: target.environmentId,
        threadId: childThreadId,
      }),
    );
  };

  const content = (
    <ScrollView
      className="flex-1"
      // The iOS header is translucent and floats over this view; UIKit has to
      // inset the content or the first row sits underneath the title.
      contentInsetAdjustmentBehavior={Platform.OS === "ios" ? "automatic" : "never"}
      contentContainerClassName="px-5 pb-6"
      contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 16) + 8 }}
    >
      {subagents.length === 0 ? (
        <Text className="pt-6 text-center text-sm text-foreground-muted">
          No agents in this turn.
        </Text>
      ) : (
        subagents.map((subagent) => (
          <AgentRow
            key={subagent.id}
            subagent={subagent}
            tickSeconds={hasLiveAgent}
            onOpen={openChildThread}
          />
        ))
      )}
    </ScrollView>
  );

  if (Platform.OS === "ios") {
    // A plain formSheet screen never renders a stack header, so it comes from
    // a nested native stack inside the sheet (same shape as the git sheet).
    return (
      <View collapsable={false} className="flex-1 bg-sheet">
        <ScreenStack style={{ flex: 1 }}>
          <Screen
            activityState={2}
            enabled
            isNativeStack
            screenId="thread-agents-sheet-native"
            scrollEdgeEffects={HEADER_SCROLL_EDGE_EFFECTS}
            style={{ backgroundColor: theme["--color-sheet"], flex: 1 }}
          >
            {content}
            <ScreenStackHeaderConfig
              backgroundColor="rgba(0,0,0,0)"
              color={theme["--color-foreground"]}
              hideBackButton
              hideShadow={false}
              title="Agents"
              titleColor={theme["--color-foreground"]}
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
      <AndroidSheetHeader title="Agents" onBack={() => navigation.goBack()} />
      {content}
    </View>
  );
}

function AgentRow(props: {
  readonly subagent: OrchestrationV2Subagent;
  readonly tickSeconds: boolean;
  readonly onOpen: (childThreadId: ThreadId) => void;
}) {
  const { subagent } = props;
  const presentation = resolveSubagentRowPresentation(subagent);
  const childThreadId = subagent.childThreadId;
  const elapsed = useSubagentElapsed(subagent, props.tickSeconds);

  const row = (
    <View className="min-h-14 flex-row items-center gap-3 border-b border-border py-3">
      <View className={cn("h-2 w-2 shrink-0 rounded-full", TONE_DOT_CLASS[presentation.tone])} />
      <View className="min-w-0 flex-1 gap-0.5">
        <Text className="font-t3-medium text-sm text-foreground" numberOfLines={1}>
          {presentation.title}
        </Text>
        <Text className="text-xs text-foreground-muted" numberOfLines={1}>
          {presentation.detail ?? presentation.statusLabel}
        </Text>
      </View>
      {elapsed === null ? null : (
        <Text className="shrink-0 text-2xs tabular-nums text-foreground-muted">{elapsed}</Text>
      )}
      {presentation.canOpenThread ? (
        <SymbolView name="chevron.right" size={12} tintColorClassName="accent-icon-subtle" />
      ) : null}
    </View>
  );

  if (childThreadId === null) {
    return (
      <View
        accessible
        accessibilityLabel={`${presentation.title}, ${presentation.statusLabel}`}
        accessibilityHint="Provider-managed agent. Its work appears in the transcript."
      >
        {row}
      </View>
    );
  }

  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={`${presentation.title}, ${presentation.statusLabel}`}
      accessibilityHint="Opens this agent's thread"
      onPress={() => props.onOpen(childThreadId)}
      className="active:opacity-70"
    >
      {row}
    </Pressable>
  );
}

/**
 * Elapsed time for one agent. Only a roster with live work subscribes to the
 * shared second tick, so a settled sheet never repaints.
 */
function useSubagentElapsed(
  subagent: Pick<OrchestrationV2Subagent, "startedAt" | "completedAt">,
  tickSeconds: boolean,
): string | null {
  const [nowMs, setNowMs] = useState(() => Date.now());
  const running = subagent.completedAt === null;
  useEffect(() => {
    if (!tickSeconds || !running) return;
    const intervalId = setInterval(() => setNowMs(Date.now()), 1_000);
    return () => clearInterval(intervalId);
  }, [running, tickSeconds]);
  if (subagent.startedAt === null) return null;
  const startedAtMs = DateTime.toEpochMillis(subagent.startedAt);
  const endMs =
    subagent.completedAt === null ? nowMs : DateTime.toEpochMillis(subagent.completedAt);
  return endMs <= startedAtMs ? null : formatDuration(endMs - startedAtMs);
}
