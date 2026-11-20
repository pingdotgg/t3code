import { T, useGT } from "gt-react-native";
import type { BotSummary } from "@t3tools/client-runtime/state/bots";
import { LegendList } from "@legendapp/list/react-native";
import { useNavigation } from "@react-navigation/native";
import { memo, use, useCallback, useState } from "react";
import { Platform, ScrollView, View, type ScrollViewProps } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { RowPressable } from "../../components/ui/RowPressable";
import { cn } from "../../lib/cn";
import { scopedThreadKey } from "../../lib/scopedEntities";
import { relativeTime } from "../../lib/time";
import { NativeScrollViewMarker } from "../../native/NativeScrollViewMarker";
import { NativePrimaryColumnContext } from "../../native/v5-workspace-context";
import { useBotList } from "../../state/bots";
import {
  THREAD_LIST_V2_SIDEBAR_ROW_STYLE,
  selectedThreadRowColors,
} from "../threads/thread-list-v2-row-appearance";
import { useWorkspaceTabs } from "../layout/workspace/WorkspaceTabsContext";
import { useSelectWorkspaceDetail } from "../layout/workspace/useSelectWorkspaceDetail";
import { BotAvatar } from "./BotAvatar";
import { startBotDraft } from "./bot-draft";

const AVATAR_SIZE = 44;

function BotsScrollView(props: ScrollViewProps) {
  return (
    <NativeScrollViewMarker style={{ flex: 1 }}>
      <ScrollView {...props} />
    </NativeScrollViewMarker>
  );
}

const BotListRow = memo(function BotListRow(props: {
  readonly bot: BotSummary;
  readonly selected: boolean;
  readonly sidebar: boolean;
  readonly onSelect: (bot: BotSummary) => void;
}) {
  const gt = useGT();
  const { bot, selected, sidebar } = props;
  const foreground = selected
    ? selectedThreadRowColors.foregroundClassName
    : sidebar
      ? "text-drawer-foreground"
      : "text-foreground";
  const muted = selected
    ? selectedThreadRowColors.mutedForegroundClassName
    : sidebar
      ? "text-drawer-foreground-muted"
      : "text-foreground-muted";
  const content = (
    <View className="flex-row items-center gap-3">
      <BotAvatar
        avatar={bot.avatar}
        size={AVATAR_SIZE}
        source={{ environmentId: bot.environmentId, threadId: bot.threadId }}
      />
      <View className="min-w-0 flex-1 gap-0.5">
        <View className="flex-row items-center gap-2">
          <Text className={cn("flex-1 text-base font-t3-bold", foreground)} numberOfLines={1}>
            {bot.name}
          </Text>
          <Text className={cn("text-xs", muted)}>{relativeTime(bot.activityAt)}</Text>
        </View>
        <View className="flex-row items-center gap-2">
          <Text className={cn("flex-1 text-sm", muted)} numberOfLines={1}>
            {bot.working ? gt("Working...") : (bot.preview ?? gt("No messages yet"))}
          </Text>
          {bot.unread ? (
            <View
              accessibilityLabel={gt("Unread")}
              className="size-2.5 rounded-full bg-primary"
              accessible
            />
          ) : null}
        </View>
      </View>
    </View>
  );
  return (
    <RowPressable
      accessibilityLabel={bot.unread ? gt("{name}, unread reply", { name: bot.name }) : bot.name}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      className={sidebar ? (selected ? "bg-thread-selected" : "bg-drawer") : "bg-screen"}
      interactionClassName={sidebar ? "bg-thread-hover" : "bg-row-hover"}
      interactionOpacity={selected ? 0 : 1}
      onPress={() => props.onSelect(bot)}
      style={sidebar ? THREAD_LIST_V2_SIDEBAR_ROW_STYLE : undefined}
    >
      {sidebar ? (
        content
      ) : (
        <View>
          <View className="px-5 py-2.5">{content}</View>
          <View className="h-px bg-border-subtle" style={{ marginLeft: 20 + AVATAR_SIZE + 12 }} />
        </View>
      )}
    </RowPressable>
  );
});

function BotsEmpty(props: { readonly onNewBot: () => void }) {
  const gt = useGT();
  return (
    <View className="items-center gap-4 px-8 py-16">
      <Text className="text-center text-base text-foreground-muted">
        <T>No bots yet.</T>
      </Text>
      {/* Button sizes to its label with self-start, so this wrapper centers it. */}
      <View>
        <Button label={gt("New bot")} icon="plus" tone="primary" onPress={props.onNewBot} />
      </View>
    </View>
  );
}

export function useOpenNewBot() {
  const navigation = useNavigation();
  return useCallback(() => {
    startBotDraft();
    navigation.navigate("BotNew");
  }, [navigation]);
}

export function BotsScreen(props: { readonly sidebar?: boolean } = {}) {
  const bots = useBotList();
  const primaryColumn = use(NativePrimaryColumnContext);
  const workspace = useWorkspaceTabs();
  const insets = useSafeAreaInsets();
  const selectDetail = useSelectWorkspaceDetail();
  const openNewBot = useOpenNewBot();
  const [initialOffset] = useState(() => workspace?.getScrollOffset("bots") ?? 0);
  const sidebar = props.sidebar === true || primaryColumn !== null;
  const selectedThreadKey = primaryColumn?.selectedThreadKey ?? null;
  const selectBot = useCallback(
    (bot: BotSummary) =>
      selectDetail({
        name: "Thread",
        params: { environmentId: String(bot.environmentId), threadId: String(bot.threadId) },
      }),
    [selectDetail],
  );
  const renderBot = useCallback(
    ({ item }: { readonly item: BotSummary }) => (
      <BotListRow
        bot={item}
        selected={scopedThreadKey(item.environmentId, item.threadId) === selectedThreadKey}
        sidebar={sidebar}
        onSelect={selectBot}
      />
    ),
    [selectedThreadKey, sidebar, selectBot],
  );
  const iosTopInset = Platform.OS === "ios" ? insets.top : 0;

  return (
    <View className={sidebar ? "flex-1 bg-drawer" : "flex-1 bg-screen"}>
      <LegendList
        data={bots}
        extraData={selectedThreadKey}
        keyExtractor={(bot) => bot.key}
        estimatedItemSize={68}
        recycleItems
        renderScrollComponent={Platform.OS === "ios" ? BotsScrollView : undefined}
        alwaysBounceVertical
        showsVerticalScrollIndicator={Platform.OS !== "android"}
        contentInsetAdjustmentBehavior="never"
        contentInset={Platform.OS === "ios" ? { top: iosTopInset } : undefined}
        initialScrollOffset={initialOffset > 0 ? initialOffset - iosTopInset : undefined}
        contentContainerStyle={{
          paddingHorizontal: sidebar ? 8 : 0,
          paddingBottom: Math.max(insets.bottom, workspace?.bottomClearance ?? 0),
        }}
        onScroll={(event) => {
          workspace?.recordScrollOffset(
            "bots",
            Math.max(0, event.nativeEvent.contentOffset.y + iosTopInset),
          );
        }}
        renderItem={renderBot}
        ListEmptyComponent={<BotsEmpty onNewBot={openNewBot} />}
      />
    </View>
  );
}
