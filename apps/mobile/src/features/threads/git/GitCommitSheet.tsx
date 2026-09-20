import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { resolveVcsTerminology } from "@t3tools/shared/vcs";
import { useCallback, useState } from "react";
import { Platform, Pressable, ScrollView, useWindowDimensions, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AndroidSheetHeader } from "../../../components/AndroidScreenHeader";
import { SymbolView } from "../../../components/AppSymbol";
import { MaterialScreenContent } from "../../../components/MaterialScreenContent";
import { NativeStackScreenOptions } from "../../../native/StackHeader";
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
  const { height: windowHeight } = useWindowDimensions();
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
  const vcsTerminology = resolveVcsTerminology(gitStatus.data);
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
    <View
      collapsable={false}
      className={Platform.OS === "android" ? "bg-sheet" : "flex-1 bg-sheet"}
      style={Platform.OS === "android" ? { maxHeight: windowHeight * 0.92 } : undefined}
    >
      {Platform.OS === "android" ? (
        <NativeStackScreenOptions
          options={{
            sheetCornerRadius: 28,
            sheetAllowedDetents: "fitToContents",
          }}
        />
      ) : null}
      {Platform.OS === "android" ? (
        <AndroidSheetHeader
          title="Commit changes"
          onBack={() => navigation.goBack()}
          hideBottomBorder
        />
      ) : null}
      <MaterialScreenContent fitToContents>
        <ScrollView
          className={Platform.OS === "android" ? "shrink grow-0" : "flex-1"}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
          contentInset={{ bottom: Math.max(insets.bottom, 18) + 18 }}
          contentContainerClassName={Platform.OS === "android" ? "gap-2 p-2" : "gap-4 px-5 pt-2"}
          contentContainerStyle={
            Platform.OS === "android"
              ? { paddingBottom: Math.max(insets.bottom, 18) + 18 }
              : undefined
          }
        >
          <View
            className={cn(
              "gap-3 bg-card p-4",
              Platform.OS === "android" ? "rounded-[20px]" : "rounded-[22px] border border-border",
            )}
          >
            <View
              className={
                Platform.OS === "android" ? "gap-1" : "flex-row items-center justify-between gap-3"
              }
            >
              <Text className="text-foreground-muted text-sm font-medium">
                {vcsTerminology.refNounTitle}
              </Text>
              <Text
                className={cn(
                  "text-foreground text-base",
                  Platform.OS === "android" ? "font-t3-medium" : "font-t3-bold",
                )}
              >
                {gitStatus.data?.refName ?? `(no ${vcsTerminology.refNoun})`}
              </Text>
            </View>
            {gitStatus.data?.vcs?.kind === "jj" ? (
              <Text className="text-xs leading-normal text-foreground-muted">
                Jujutsu does not run Git hooks.
              </Text>
            ) : null}
            {isDefaultRef ? (
              <Text className="text-xs leading-normal text-warning-foreground">
                {`Warning: this is the default ${vcsTerminology.refNoun}.`}
              </Text>
            ) : null}
          </View>

          <View
            className={cn(
              "gap-3 bg-card p-4",
              Platform.OS === "android" ? "rounded-[20px]" : "rounded-[22px] border border-border",
            )}
          >
            <View className="flex-row items-center justify-between gap-3">
              <View className="gap-1">
                <Text
                  className={cn(
                    "text-foreground text-base",
                    Platform.OS === "android" ? "font-t3-medium" : "font-t3-bold",
                  )}
                >
                  Files
                </Text>
                <Text className="text-foreground-muted text-xs leading-normal">
                  {selectedFiles.length} selected · +{selectedInsertions} / -{selectedDeletions}
                </Text>
              </View>
              <View className="flex-row items-center gap-2">
                {!allSelected && isEditingFiles ? (
                  <Pressable
                    className={
                      Platform.OS === "android"
                        ? "min-h-12 justify-center rounded-full px-3 active:bg-subtle"
                        : "bg-subtle rounded-full px-3 py-2"
                    }
                    onPress={() => setExcludedFiles(new Set())}
                  >
                    <Text
                      className={
                        Platform.OS === "android"
                          ? "text-primary-text text-sm font-t3-medium"
                          : "text-foreground text-2xs font-t3-bold uppercase"
                      }
                    >
                      Reset
                    </Text>
                  </Pressable>
                ) : null}
                <Pressable
                  className={
                    Platform.OS === "android"
                      ? "min-h-12 justify-center rounded-full px-3 active:bg-subtle"
                      : "bg-subtle rounded-full px-3 py-2"
                  }
                  onPress={() => setIsEditingFiles((current) => !current)}
                >
                  <Text
                    className={
                      Platform.OS === "android"
                        ? "text-primary-text text-sm font-t3-medium"
                        : "text-foreground text-2xs font-t3-bold uppercase"
                    }
                  >
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
                    <Text className="text-xs font-t3-bold text-adaptive-emerald-700-300">
                      +{file.insertions}
                    </Text>
                    <Text className="text-xs font-t3-bold text-adaptive-rose-700-300">
                      -{file.deletions}
                    </Text>
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
                        "px-4 py-3",
                        Platform.OS === "android"
                          ? included
                            ? "rounded-xl bg-subtle"
                            : "rounded-xl"
                          : cn(
                              "rounded-[18px] border",
                              included ? "border-border" : "border-border-subtle",
                            ),
                      )}
                      accessibilityRole="checkbox"
                      accessibilityLabel={file.path}
                      accessibilityState={{ checked: included }}
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
                      {Platform.OS !== "android" ? (
                        <View
                          className={`absolute inset-0 rounded-[18px] ${included ? "bg-card" : "bg-subtle"}`}
                        />
                      ) : null}
                      <View className="flex-row items-start justify-between gap-3">
                        {Platform.OS === "android" ? (
                          <View
                            className={cn(
                              "mt-0.5 size-5 items-center justify-center rounded-sm",
                              included ? "bg-primary" : "border border-input-border",
                            )}
                          >
                            {included ? (
                              <SymbolView
                                name="checkmark"
                                size={16}
                                tintColorClassName="accent-primary-foreground"
                                type="monochrome"
                              />
                            ) : null}
                          </View>
                        ) : null}
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
                          <Text className="text-xs font-t3-bold text-adaptive-emerald-700-300">
                            +{file.insertions}
                          </Text>
                          <Text className="text-xs font-t3-bold text-adaptive-rose-700-300">
                            -{file.deletions}
                          </Text>
                        </View>
                      </View>
                    </Pressable>
                  );
                })}
              </View>
            )}
          </View>

          <View
            className={Platform.OS === "android" ? "gap-3 rounded-[20px] bg-card p-4" : "gap-2"}
          >
            <Text
              className={
                Platform.OS === "android"
                  ? "text-foreground text-base font-t3-medium"
                  : "text-foreground text-sm font-t3-bold"
              }
            >
              Commit message
            </Text>
            <TextInput
              multiline
              accessibilityLabel="Commit message"
              value={dialogCommitMessage}
              onChangeText={setDialogCommitMessage}
              placeholder="Leave empty to auto-generate"
              textAlignVertical="top"
              className={cn(
                "min-h-[128px] px-4 py-3.5",
                Platform.OS === "android" ? "rounded-xl bg-sheet-solid" : "rounded-[20px]",
              )}
            />
          </View>

          <View className={Platform.OS === "android" ? "gap-2" : "flex-row gap-3"}>
            <View className={Platform.OS === "android" ? undefined : "flex-1"}>
              <SheetActionButton
                icon="arrow.branch"
                label={`${vcsTerminology.changeNounTitle} on new ${vcsTerminology.refNoun}`}
                disabled={noneSelected || busy}
                onPress={() => void runCommitAction(true)}
              />
            </View>
            <View className={Platform.OS === "android" ? undefined : "flex-1"}>
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
      </MaterialScreenContent>
    </View>
  );
}
