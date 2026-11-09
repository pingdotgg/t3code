import type { GitStackedAction } from "@t3tools/contracts";
import { StackActions, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { Platform, ScrollView, useWindowDimensions, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { ListChoiceRow } from "../../../components/ui/ListChoiceRow";
import { ListSection } from "../../../components/ui/ListSection";
import { ScreenContent } from "../../../components/ui/ScreenContent";
import { SheetHeader } from "../../../components/ui/SheetHeader";
import { useEnvironmentQuery } from "../../../state/query";
import { useSelectedThreadGitActions } from "../../../state/use-selected-thread-git-actions";
import { useSelectedThreadWorktree } from "../../../state/use-selected-thread-worktree";
import { useThreadSelection } from "../../../state/use-thread-selection";
import { vcsEnvironment } from "../../../state/vcs";

type GitRemoteSheetProps = StaticScreenProps<{
  readonly environmentId: string;
  readonly threadId: string;
  /** Set when a git action is waiting on the choice; it runs once a remote is picked. */
  readonly action?: GitStackedAction;
  readonly commitMessage?: string;
  readonly featureBranch?: string;
  readonly filePaths?: string;
}>;

export function GitRemoteSheet(props: GitRemoteSheetProps) {
  const { environmentId, threadId, action, commitMessage, featureBranch, filePaths } =
    props.route.params;
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const { height: windowHeight } = useWindowDimensions();
  const { selectedThread } = useThreadSelection();
  const { selectedThreadCwd } = useSelectedThreadWorktree();
  const gitActions = useSelectedThreadGitActions();
  const gitStatus = useEnvironmentQuery(
    selectedThread !== null && selectedThreadCwd !== null
      ? vcsEnvironment.status({
          environmentId: selectedThread.environmentId,
          input: { cwd: selectedThreadCwd },
        })
      : null,
  );
  const remotes = gitStatus.data?.remotes ?? [];
  const pushRemote = gitStatus.data?.pushRemote;

  const selectRemote = async (remoteName: string) => {
    if (action) {
      navigation.dispatch(StackActions.replace("Thread", { environmentId, threadId }));
      await gitActions.onRunSelectedThreadGitAction({
        action,
        pushRemote: remoteName,
        ...(commitMessage ? { commitMessage } : {}),
        ...(featureBranch === "true" ? { featureBranch: true } : {}),
        ...(filePaths ? { filePaths: JSON.parse(filePaths) as string[] } : {}),
      });
      return;
    }
    const result = await gitActions.onSetSelectedThreadPushRemote(remoteName);
    if (result !== null) navigation.goBack();
  };

  return (
    <View
      collapsable={false}
      className="bg-sheet ios:flex-1 android:flex-col-reverse"
      style={Platform.OS === "android" ? { maxHeight: windowHeight * 0.92 } : undefined}
    >
      <ScreenContent fitToContents>
        <ScrollView
          nestedScrollEnabled
          className="android:shrink android:grow-0 ios:flex-1"
          contentInsetAdjustmentBehavior="automatic"
          showsVerticalScrollIndicator={false}
          contentInset={{ bottom: Math.max(insets.bottom, 18) + 18 }}
          contentContainerClassName="android:gap-2 android:p-2 ios:gap-4 ios:px-5 ios:pt-2"
        >
          <ListSection
            {...(action
              ? {
                  footer:
                    "This repository has several remotes and none is named origin. The branch will track the one you choose.",
                }
              : {})}
          >
            {remotes.map((remoteName) => (
              <ListChoiceRow
                key={remoteName}
                label={remoteName}
                selected={remoteName === pushRemote}
                disabled={!gitActions.canWriteSourceControl}
                onPress={() => void selectRemote(remoteName)}
              />
            ))}
          </ListSection>
        </ScrollView>
      </ScreenContent>
      <SheetHeader
        title={action ? "Push to which remote?" : "Push remote"}
        onClose={() => navigation.goBack()}
      />
    </View>
  );
}
