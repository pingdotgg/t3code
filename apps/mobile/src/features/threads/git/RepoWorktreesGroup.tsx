import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ThreadId, ThreadRepoWorktree } from "@t3tools/contracts";
import * as Clipboard from "expo-clipboard";
import { Platform, View } from "react-native";

import * as Dialog from "../../../components/ui/Dialog";
import { AppText as Text } from "../../../components/ui/AppText";
import { environmentThreadDetails, threadEnvironment } from "../../../state/threads";
import { useAtomCommand } from "../../../state/use-atom-command";
import { SheetListRow } from "./gitSheetComponents";

/** Where this thread's work lives when its project holds several repositories. */
export function RepoWorktreesGroup(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const repoWorktrees = useAtomValue(
    environmentThreadDetails.repoWorktreesAtom({
      environmentId: props.environmentId,
      threadId: props.threadId,
    }),
  );
  const detach = useAtomCommand(threadEnvironment.detachRepoWorktree, { reportFailure: true });
  if (repoWorktrees.length === 0) return null;

  const showActions = (entry: ThreadRepoWorktree) =>
    Dialog.alert(`${entry.repository} · ${entry.branch}`, entry.worktreePath, [
      { text: "Copy path", onPress: () => void Clipboard.setStringAsync(entry.worktreePath) },
      {
        text: "Detach from thread",
        style: "destructive",
        onPress: () =>
          void detach({
            environmentId: props.environmentId,
            input: { threadId: props.threadId, worktreePath: entry.worktreePath },
          }),
      },
      { text: "Cancel", style: "cancel" },
    ]);

  return (
    <View className="gap-2">
      <Text className="px-1 text-xs font-t3-bold text-foreground-muted">Repository worktrees</Text>
      <View className="overflow-hidden bg-card android:rounded-[20px] ios:rounded-2xl ios:border ios:border-border ios:px-3 ios:py-1">
        {repoWorktrees.map((entry, index) => (
          <View key={entry.worktreePath}>
            {index > 0 && Platform.OS !== "android" ? (
              <View className="ml-12 h-px bg-border" />
            ) : null}
            <SheetListRow
              icon="folder"
              title={`${entry.repository} · ${entry.branch}`}
              subtitle={entry.worktreePath}
              onPress={() => showActions(entry)}
            />
          </View>
        ))}
      </View>
    </View>
  );
}
