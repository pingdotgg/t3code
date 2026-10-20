import { SheetHeader } from "../../../components/ui/SheetHeader";
import { Button } from "../../../components/ui/Button";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import {
  resolveVcsTerminology,
  resolveVcsUnsupportedReason,
  supportsVcsActions,
} from "@t3tools/shared/vcs";
import { useState } from "react";
import { Platform, Pressable, ScrollView, useWindowDimensions, View } from "react-native";
import { formatDiffCount } from "@t3tools/client-runtime/diff-count";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { SymbolView } from "../../../components/ui/AppSymbol";
import { NativeStackScreenOptions } from "../../../native/StackHeader";
import { AppText as Text, AppTextInput as TextInput } from "../../../components/ui/AppText";
import { cn } from "../../../lib/cn";
import { useEnvironmentQuery } from "../../../state/query";
import { useThreadSelection } from "../../../state/use-thread-selection";
import { useSelectedThreadGitActions } from "../../../state/use-selected-thread-git-actions";
import { useSelectedThreadGitState } from "../../../state/use-selected-thread-git-state";
import { useSelectedThreadWorktree } from "../../../state/use-selected-thread-worktree";
import { vcsEnvironment } from "../../../state/vcs";

type GitCommitSheetProps = StaticScreenProps<{
  readonly environmentId: string;
  readonly threadId: string;
}>;

export function GitCommitSheet(_props: GitCommitSheetProps) {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const { height: windowHeight } = useWindowDimensions();
  const { selectedThread } = useThreadSelection();
  const { selectedThreadCwd } = useSelectedThreadWorktree();
  const gitState = useSelectedThreadGitState();
  const gitActions = useSelectedThreadGitActions();
  const { canWriteSourceControl, canChangeThreadBranch } = gitActions;

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
  const vcsTerminology = resolveVcsTerminology(gitStatus.data);
  const vcsUnsupportedReason = resolveVcsUnsupportedReason(gitStatus.data);
  const vcsActionsSupported = supportsVcsActions(gitStatus.data);
  const allFiles = gitStatus.data?.workingTree?.files ?? [];

  const [dialogCommitMessage, setDialogCommitMessage] = useState("");
  const [excludedFiles, setExcludedFiles] = useState<ReadonlySet<string>>(new Set());

  const selectedFiles = allFiles.filter((file) => !excludedFiles.has(file.path));
  const allSelected = excludedFiles.size === 0;
  const noneSelected = selectedFiles.length === 0;
  const selectedInsertions = selectedFiles.reduce((sum, file) => sum + file.insertions, 0);
  const selectedDeletions = selectedFiles.reduce((sum, file) => sum + file.deletions, 0);

  const runCommitAction = async (featureBranch: boolean) => {
    if (!vcsActionsSupported || !canWriteSourceControl || (featureBranch && !canChangeThreadBranch))
      return;
    const commitMessage = dialogCommitMessage.trim();
    navigation.goBack();
    await gitActions.onRunSelectedThreadGitAction({
      action: "commit",
      featureBranch,
      ...(commitMessage ? { commitMessage } : {}),
      ...(!allSelected ? { filePaths: selectedFiles.map((file) => file.path) } : {}),
    });
  };

  return (
    <View
      collapsable={false}
      className="bg-sheet ios:flex-1"
      style={Platform.OS === "android" ? { maxHeight: windowHeight * 0.92 } : undefined}
    >
      {Platform.OS === "android" ? (
        <NativeStackScreenOptions
          options={{ sheetCornerRadius: 28, sheetAllowedDetents: "fitToContents" }}
        />
      ) : null}
      <SheetHeader
        presentation={Platform.OS === "android" ? "inline" : "native"}
        title="Commit changes"
        subtitle={gitStatus.data?.refName ?? vcsTerminology.noRefDisplay}
        onCancel={() => navigation.goBack()}
        accessibilityLabel="Cancel commit"
      />
      <ScrollView
        nestedScrollEnabled
        contentInsetAdjustmentBehavior="automatic"
        className="android:shrink android:grow-0 ios:flex-1"
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        automaticallyAdjustKeyboardInsets
        contentContainerClassName="px-5 pt-4 pb-6 gap-5"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        {vcsUnsupportedReason ? (
          <Text accessibilityRole="alert" className="text-warning-foreground">
            {vcsUnsupportedReason}
          </Text>
        ) : null}
        {vcsTerminology.hooksNotice ? (
          <Text className="text-xs leading-normal text-foreground-muted">
            {vcsTerminology.hooksNotice}
          </Text>
        ) : null}
        {isDefaultRef ? (
          <Text className="text-sm text-warning-foreground">
            {`You’re on the default ${vcsTerminology.refNoun}. You can create a new ${vcsTerminology.refNoun} when committing.`}
          </Text>
        ) : null}
        <View className="gap-2">
          <Text className="text-sm font-t3-medium text-foreground">Commit message</Text>
          <TextInput
            multiline
            accessibilityLabel="Commit message"
            value={dialogCommitMessage}
            onChangeText={setDialogCommitMessage}
            placeholder="Describe your changes…"
            textAlignVertical="top"
            className="min-h-24 rounded-xl bg-subtle px-4 py-3 text-base"
          />
          <Text className="text-xs text-foreground-muted">
            Leave empty to generate a message automatically.
          </Text>
        </View>
        <View>
          <View className="flex-row items-center justify-between gap-2 pb-2">
            <View className="flex-1 gap-1">
              <Text className="text-base font-t3-bold text-foreground">Changed files</Text>
              <Text className="text-xs text-foreground-muted">
                {selectedFiles.length} of {allFiles.length} selected · +
                {formatDiffCount(selectedInsertions)} −{formatDiffCount(selectedDeletions)}
              </Text>
            </View>
            {allFiles.length > 0 ? (
              <Button
                label={allSelected ? "Deselect all" : "Select all"}
                tone="text"
                onPress={() =>
                  setExcludedFiles(
                    allSelected ? new Set(allFiles.map((file) => file.path)) : new Set(),
                  )
                }
              />
            ) : null}
          </View>
          {allFiles.length === 0 ? (
            <Text className="py-4 text-sm text-foreground-muted">No changed files to commit.</Text>
          ) : (
            allFiles.map((file) => {
              const included = !excludedFiles.has(file.path);
              const slash = file.path.lastIndexOf("/");
              const name = file.path.slice(slash + 1);
              const directory = slash >= 0 ? file.path.slice(0, slash) : null;
              return (
                <Pressable
                  key={file.path}
                  className="min-h-16 flex-row items-center gap-3 border-t border-border-subtle py-3"
                  accessibilityRole="checkbox"
                  accessibilityLabel={file.path}
                  accessibilityState={{ checked: included }}
                  onPress={() =>
                    setExcludedFiles((current) => {
                      const next = new Set(current);
                      if (next.has(file.path)) next.delete(file.path);
                      else next.add(file.path);
                      return next;
                    })
                  }
                >
                  <View
                    className={cn(
                      "size-5 items-center justify-center rounded-full",
                      included ? "bg-primary" : "border border-input-border",
                    )}
                  >
                    {included ? (
                      <SymbolView
                        name="checkmark"
                        size={13}
                        tintColorClassName="accent-primary-foreground"
                      />
                    ) : null}
                  </View>
                  <View className="flex-1 gap-1">
                    <Text
                      numberOfLines={1}
                      ellipsizeMode="middle"
                      className="text-sm font-t3-medium text-foreground"
                    >
                      {name}
                    </Text>
                    {directory ? (
                      <Text
                        numberOfLines={1}
                        ellipsizeMode="middle"
                        className="text-xs text-foreground-muted"
                      >
                        {directory}
                      </Text>
                    ) : null}
                  </View>
                  <View className="flex-row gap-2">
                    <Text className="text-xs text-adaptive-emerald-700-300">
                      +{formatDiffCount(file.insertions)}
                    </Text>
                    <Text className="text-xs text-adaptive-rose-700-300">
                      −{formatDiffCount(file.deletions)}
                    </Text>
                  </View>
                </Pressable>
              );
            })
          )}
        </View>
        <View className="gap-2">
          <Button
            label="Commit changes"
            icon="checkmark"
            tone="primary"
            fullWidth
            disabled={!vcsActionsSupported || !canWriteSourceControl || noneSelected || busy}
            onPress={() => void runCommitAction(false)}
          />
          <Button
            label={
              vcsTerminology.systemName === "Git"
                ? "Commit on a new branch"
                : vcsTerminology.changeOnNewRefLabel
            }
            icon="arrow.branch"
            tone="text"
            fullWidth
            disabled={
              !vcsActionsSupported ||
              !canWriteSourceControl ||
              !canChangeThreadBranch ||
              noneSelected ||
              busy
            }
            onPress={() => void runCommitAction(true)}
          />
        </View>
      </ScrollView>
    </View>
  );
}
