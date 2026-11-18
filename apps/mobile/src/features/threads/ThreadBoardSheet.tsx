import { useAtomValue } from "@effect/atom-react";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { Platform, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/ui/AppText";
import { RelativeTime } from "../../components/RelativeTime";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { SheetHeader } from "../../components/ui/SheetHeader";
import { cn } from "../../lib/cn";
import { resolveMarkdownLinkPresentation } from "../../lib/markdownLinks";
import { SelectableMarkdownText } from "../../native/SelectableMarkdownText";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useEnvironmentQuery } from "../../state/query";
import { steadyNavigationThreadShellsAtom, threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { useSelectedThreadWorktree } from "../../state/use-selected-thread-worktree";
import { useMarkdownPreviewStyles } from "../files/FileMarkdownPreview";
import {
  fileRoutePathSegments,
  resolveFileLinkPath,
  resolveWorkspaceRelativeFilePath,
} from "../files/filePath";
import { statusDotClass } from "./ThreadGroupStrip";
import { presentBoardTopic } from "./threadBoardPresentation";
import { resolveThreadListV2Status } from "./threadListV2";

type BoardTarget = { readonly environmentId: EnvironmentId; readonly threadId: ThreadId };

export function ThreadBoardSheet({ route }: StaticScreenProps<BoardTarget>) {
  const target = route.params;
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const styles = useMarkdownPreviewStyles();
  const shells = useAtomValue(steadyNavigationThreadShellsAtom);
  const { selectedThreadCwd } = useSelectedThreadWorktree();
  const query = useEnvironmentQuery(
    orchestrationEnvironment.threadBoard({
      environmentId: target.environmentId,
      input: { threadId: target.threadId },
    }),
  );
  const visitBoard = useAtomCommand(threadEnvironment.visitBoard, { reportFailure: false });
  // The first settled load's board; marking it viewed moves the server's watermark, not this one.
  const [opened, setOpened] = useState<{
    readonly viewedAt: string | null;
    readonly leadThreadId: ThreadId | null;
  } | null>(null);
  const board = query.successResult?.value ?? null;
  if (board !== null && opened === null) {
    setOpened({ viewedAt: board.viewedAt, leadThreadId: board.leadThreadId });
  }

  const markViewed = useEffectEvent((leadThreadId: ThreadId) => {
    void visitBoard({
      environmentId: target.environmentId,
      input: { threadId: leadThreadId, viewedAt: new Date().toISOString() },
    });
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- records the visit with the server once, when the board first shows
  useEffect(() => {
    if (opened?.leadThreadId != null) markViewed(opened.leadThreadId);
  }, [opened]);

  const shellOf = (threadId: ThreadId) =>
    shells.find((shell) => shell.environmentId === target.environmentId && shell.id === threadId);
  const leadThreadId =
    board?.leadThreadId ?? shellOf(target.threadId)?.groupParentThreadId ?? target.threadId;
  const boardUpdatedAt = shellOf(leadThreadId)?.boardUpdatedAt ?? null;
  const refreshBoard = query.refresh;
  // Taken at mount, before the read, so a post that lands during the read still refreshes.
  const lastRefreshedFor = useRef(boardUpdatedAt);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- refetches the server read when an agent posts, which only the shell reports
  useEffect(() => {
    if (lastRefreshedFor.current === boardUpdatedAt) return;
    lastRefreshedFor.current = boardUpdatedAt;
    refreshBoard();
  }, [boardUpdatedAt, refreshBoard]);

  const openLink = (href: string) => {
    const link = resolveMarkdownLinkPresentation(href);
    if (link.kind !== "file") return;
    const path = resolveFileLinkPath(selectedThreadCwd, link.path);
    if (path === null) return;
    navigation.navigate("ThreadFile", {
      environmentId: String(target.environmentId),
      threadId: String(target.threadId),
      path: fileRoutePathSegments(
        resolveWorkspaceRelativeFilePath(selectedThreadCwd, path) ?? path,
      ),
      ...(link.line ? { line: String(link.line) } : {}),
    });
  };

  const viewedAt = opened?.viewedAt ?? null;
  const topics = board?.topics ?? [];

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      <SheetHeader title="Board" onClose={() => navigation.goBack()} />
      <ScreenContent>
        <ScrollView
          nestedScrollEnabled
          className="flex-1"
          contentInsetAdjustmentBehavior="automatic"
          contentContainerClassName="px-5"
          contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 16) + 8 }}
        >
          {query.error !== null ? (
            <Text selectable className="pt-6 text-center text-sm text-danger-foreground">
              {query.error}
            </Text>
          ) : board === null ? null : topics.length === 0 ? (
            <Text className="pt-6 text-center text-sm text-foreground-muted">
              No topics yet. Agents in this group post their current state here.
            </Text>
          ) : (
            topics.map((topic) => {
              const presentation = presentBoardTopic(topic, viewedAt);
              const editor = shells.find(
                (shell) =>
                  shell.environmentId === target.environmentId &&
                  shell.id === topic.lastEditorThreadId,
              );
              return (
                <View key={topic.id} className="gap-2 border-b border-border py-4">
                  <View className="flex-row items-center gap-2">
                    <Text className="min-w-0 shrink text-base font-semibold text-foreground">
                      {topic.title}
                    </Text>
                    {presentation.updated ? (
                      <View className="rounded-full bg-subtle px-2 py-0.5">
                        <Text className="text-xs text-foreground">Updated</Text>
                      </View>
                    ) : null}
                  </View>
                  <SelectableMarkdownText
                    markdown={topic.text}
                    textStyle={styles.nativeTextStyle}
                    // Android's renderer aligns relative to each paragraph's direction.
                    textAlign={Platform.OS === "android" ? undefined : "left"}
                    onLinkPress={openLink}
                  />
                  <View className="flex-row flex-wrap items-center gap-x-2 gap-y-1">
                    <Text className="text-xs text-foreground-muted">
                      <RelativeTime timestamp={topic.updatedAt} />
                    </Text>
                    {editor === undefined ? null : (
                      <View className="min-w-0 shrink flex-row items-center gap-1.5">
                        <View
                          className={cn(
                            "h-1.5 w-1.5 shrink-0 rounded-full",
                            statusDotClass(resolveThreadListV2Status(editor)),
                          )}
                        />
                        <Text className="shrink text-xs text-foreground-muted" numberOfLines={1}>
                          {editor.title}
                        </Text>
                      </View>
                    )}
                    {presentation.editedLabel === null ? null : (
                      <Text className="text-xs text-foreground-muted">
                        {presentation.editedLabel}
                      </Text>
                    )}
                    {presentation.authorLeft ? (
                      <Text className="text-xs text-foreground-muted">Author left the group</Text>
                    ) : null}
                  </View>
                </View>
              );
            })
          )}
        </ScrollView>
      </ScreenContent>
    </View>
  );
}
