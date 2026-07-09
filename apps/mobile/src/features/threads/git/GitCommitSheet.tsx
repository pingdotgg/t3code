import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { useCallback, useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text, AppTextInput as TextInput } from "../../../components/AppText";
import { cn } from "../../../lib/cn";
import { useEnvironmentQuery } from "../../../state/query";
import { useThreadSelection } from "../../../state/use-thread-selection";
import { useSelectedThreadGitActions } from "../../../state/use-selected-thread-git-actions";
import { useSelectedThreadGitState } from "../../../state/use-selected-thread-git-state";
import { useSelectedThreadWorktree } from "../../../state/use-selected-thread-worktree";
import { vcsEnvironment } from "../../../state/vcs";
import { SheetActionButton } from "./gitSheetComponents";

type GitCommitSheetProps = StaticScreenProps<{
  readonly environmentId: string;
  readonly threadId: string;
}>;

export function GitCommitSheet(_props: GitCommitSheetProps) {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const { selectedThread } = useThreadSelection();
  const { selectedThreadCwd } = useSelectedThreadWorktree();
  const gitState = useSelectedThreadGitState();
  const gitActions = useSelectedThreadGitActions();

  const gitStatus = useEnvironmentQuery(
    selectedThread !== null && selectedThreadCwd !== null
      ? vcsEnvironment.status({
          environmentId: selectedThread.environmentId,
          input: { cwd: selectedThreadCwd },
        })
      : null,
  );

  const busy = gitState.gitOperationLabel !== null;
  const isDefaultRef = gitStatus.data?.isDefaultRef ?? false;
  const allFiles = gitStatus.data?.workingTree?.files ?? [];

  const [dialogCommitMessage, setDialogCommitMessage] = useState("");
  const [excludedFiles, setExcludedFiles] = useState<ReadonlySet<string>>(new Set());
  const [isEditingFiles, setIsEditingFiles] = useState(false);

  const selectedFiles = allFiles.filter((file) => !excludedFiles.has(file.path));
  const allSelected = excludedFiles.size === 0;
  const noneSelected = selectedFiles.length === 0;
  const selectedInsertions = selectedFiles.reduce((sum, file) => sum + file.insertions, 0);
  const selectedDeletions = selectedFiles.reduce((sum, file) => sum + file.deletions, 0);
  const selectedFilePreview = selectedFiles.slice(0, 3);

  const runCommitAction = useCallback(
    async (featureBranch: boolean) => {
      const commitMessage = dialogCommitMessage.trim();
      navigation.goBack();
      await gitActions.onRunSelectedThreadGitAction({
        action: "commit",
        featureBranch,
        ...(commitMessage ? { commitMessage } : {}),
        ...(!allSelected ? { filePaths: selectedFiles.map((file) => file.path) } : {}),
      });
    },
    [allSelected, dialogCommitMessage, gitActions, navigation, selectedFiles],
  );

  return (
    <ScrollView
      keyboardShouldPersistTaps="handled"
      showsVerticalScrollIndicator={false}
      contentInset={{ bottom: Math.max(insets.bottom, 18) + 18 }}
      contentContainerStyle={{
        paddingHorizontal: 20,
        paddingTop: 8,
        gap: 16,
      }}
    >
      <View className="gap-3 rounded-[22px] border border-border bg-card px-4 py-4">
        <View className="flex-row items-center justify-between gap-3">
          <Text className="text-foreground-muted text-sm font-medium">Branch</Text>
          <Text className="text-foreground text-base font-t3-bold">
            {gitStatus.data?.refName ?? "(detached HEAD)"}
          </Text>
        </View>
        {isDefaultRef ? (
          <Text className="text-xs leading-normal text-amber-700 dark:text-amber-400">
            Warning: this is the default branch.
          </Text>
        ) : null}
      </View>

      <View className="gap-3 rounded-[22px] border border-border bg-card px-4 py-4">
        <View className="flex-row items-center justify-between gap-3">
          <View className="gap-1">
            <Text className="text-foreground text-base font-t3-bold">Files</Text>
            <Text className="text-foreground-muted text-xs leading-normal">
              {selectedFiles.length} selected · +{selectedInsertions} / -{selectedDeletions}
            </Text>
          </View>
          <View className="flex-row items-center gap-2">
            {!allSelected && isEditingFiles ? (
              <Pressable
                className="bg-subtle rounded-full px-3 py-2"
                onPress={() => setExcludedFiles(new Set())}
              >
                <Text className="text-foreground text-2xs font-t3-bold uppercase">Reset</Text>
              </Pressable>
            ) : null}
            <Pressable
              className="bg-subtle rounded-full px-3 py-2"
              onPress={() => setIsEditingFiles((current) => !current)}
            >
              <Text className="text-foreground text-2xs font-t3-bold uppercase">
                {isEditingFiles ? "Done" : "Edit"}
              </Text>
            </Pressable>
          </View>
        </View>

        {allFiles.length === 0 ? (
          <Text className="text-foreground-secondary text-sm leading-normal">
            No changed files are available to commit.
          </Text>
        ) : !isEditingFiles ? (
          <View className="gap-2">
            {selectedFilePreview.map((file) => (
              <View key={file.path} className="flex-row items-center justify-between gap-3">
                <Text className="text-foreground flex-1 text-sm font-medium" numberOfLines={1}>
                  {file.path}
                </Text>
                <Text className="text-xs font-t3-bold text-emerald-500">+{file.insertions}</Text>
                <Text className="text-xs font-t3-bold text-rose-500">-{file.deletions}</Text>
              </View>
            ))}
            {selectedFiles.length > selectedFilePreview.length ? (
              <Text className="text-foreground-muted text-xs leading-snug">
                +{selectedFiles.length - selectedFilePreview.length} more files
              </Text>
            ) : null}
          </View>
        ) : (
          <View className="gap-2">
            {allFiles.map((file) => {
              const included = !excludedFiles.has(file.path);
              return (
                <Pressable
                  key={file.path}
                  className={cn(
                    "rounded-[18px] border px-4 py-3",
                    included ? "border-border" : "border-border-subtle",
                  )}
                  onPress={() => {
                    setExcludedFiles((current) => {
                      const next = new Set(current);
                      if (next.has(file.path)) {
                        next.delete(file.path);
                      } else {
                        next.add(file.path);
                      }
                      return next;
                    });
                  }}
                >
                  <View
                    className={`absolute inset-0 rounded-[18px] ${included ? "bg-card" : "bg-subtle"}`}
                  />
                  <View className="flex-row items-start justify-between gap-3">
                    <View className="flex-1 gap-1">
                      <Text
                        selectable
                        className={`text-sm font-t3-bold ${included ? "text-foreground" : "text-foreground-muted"}`}
                      >
                        {file.path}
                      </Text>
                      {!included ? (
                        <Text className="text-foreground-muted text-2xs leading-normal">
                          Excluded from this commit
                        </Text>
                      ) : null}
                    </View>
                    <View className="items-end gap-1">
                      <Text className="text-xs font-t3-bold text-emerald-500">
                        +{file.insertions}
                      </Text>
                      <Text className="text-xs font-t3-bold text-rose-500">-{file.deletions}</Text>
                    </View>
                  </View>
                </Pressable>
              );
            })}
          </View>
        )}
      </View>

      <View className="gap-2">
        <Text className="text-foreground text-sm font-t3-bold">Commit message</Text>
        <TextInput
          multiline
          value={dialogCommitMessage}
          onChangeText={setDialogCommitMessage}
          placeholder="Leave empty to auto-generate"
          textAlignVertical="top"
          className="min-h-[128px] rounded-[20px] px-4 py-3.5"
        />
      </View>

      <View className="flex-row gap-3">
        <View className="flex-1">
          <SheetActionButton
            icon="arrow.branch"
            label="Commit on new branch"
            disabled={noneSelected || busy}
            onPress={() => void runCommitAction(true)}
          />
        </View>
        <View className="flex-1">
          <SheetActionButton
            icon="checkmark.circle"
            label="Commit"
            tone="primary"
            disabled={noneSelected || busy}
            onPress={() => void runCommitAction(false)}
          />
        </View>
      </View>
    </ScrollView>
  );
}
