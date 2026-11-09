import { CommandId } from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { gitEnvironment } from "../../../state/git";
import { useAtomCommand } from "../../../state/use-atom-command";
import { uuidv4 } from "../../../lib/uuid";
import { ScreenContent } from "../../../components/ui/ScreenContent";
import { SheetHeader } from "../../../components/ui/SheetHeader";
import { Button } from "../../../components/ui/Button";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { useMemo, useRef, useState } from "react";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import {
  buildCommitFileTree,
  flattenCommitFileTree,
  toggleCommitFiles,
} from "@t3tools/client-runtime/commit-file-tree";
import { ThemedSwitch } from "../../../components/ui/ThemedSwitch";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../../state/preferences";
import { Alert, Platform, Pressable, ScrollView, useWindowDimensions, View } from "react-native";
import { formatDiffCount } from "@t3tools/client-runtime/diff-count";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { SymbolView } from "../../../components/ui/AppSymbol";
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
  readonly workflow?: boolean;
}>;

export function GitCommitSheet(_props: GitCommitSheetProps) {
  const rewriteHistory = _props.route.params.workflow === true;
  const [commitMode, setCommitMode] = useState("single");
  const isWorkflow = rewriteHistory || commitMode === "logical";
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
  const allFiles = gitStatus.data?.workingTree?.files ?? [];

  const preferences = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const groupByDirectory =
    AsyncResult.isSuccess(preferences) && preferences.value.gitFilesGroupByDirectory === true;
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const tree = useMemo(
    () => (groupByDirectory ? buildCommitFileTree(allFiles) : []),
    [allFiles, groupByDirectory],
  );
  const groupedRows = useMemo(() => flattenCommitFileTree(tree, collapsed), [tree, collapsed]);

  const [dialogCommitMessage, setDialogCommitMessage] = useState("");
  const [excludedFiles, setExcludedFiles] = useState<ReadonlySet<string>>(new Set());

  const workflowScope = rewriteHistory ? "branch" : "working_tree";
  const [baseRef, setBaseRef] = useState("");
  const [workflowInstructions, setWorkflowInstructions] = useState("");
  const submittedWorkflow = useRef(false);
  const startWorkflow = useAtomCommand(gitEnvironment.startCommitWorkflow, {
    reportFailure: false,
  });
  const canStartWorkflow = useAtomValue(
    gitEnvironment.startCommitWorkflow.permissionAtom(selectedThread?.environmentId ?? null),
  );

  const selectedFiles = allFiles.filter((file) => !excludedFiles.has(file.path));
  const allSelected = selectedFiles.length === allFiles.length;
  const noneSelected = selectedFiles.length === 0;
  const selectedInsertions = selectedFiles.reduce((sum, file) => sum + file.insertions, 0);
  const selectedDeletions = selectedFiles.reduce((sum, file) => sum + file.deletions, 0);

  const workflowUnavailable =
    selectedThread?.id !== _props.route.params.threadId ||
    selectedThread?.environmentId !== _props.route.params.environmentId ||
    !gitStatus.data?.isRepo ||
    (workflowScope === "working_tree"
      ? noneSelected
      : !gitStatus.data?.refName ||
        isDefaultRef ||
        gitStatus.data?.hasWorkingTreeChanges !== false);
  const runWorkflow = async (featureBranch = false) => {
    if (
      !selectedThread ||
      !selectedThreadCwd ||
      !canStartWorkflow ||
      (featureBranch && (!canChangeThreadBranch || rewriteHistory)) ||
      submittedWorkflow.current ||
      workflowUnavailable ||
      !gitStatus.data
    )
      return;
    const payload = {
      threadId: selectedThread.id,
      cwd: selectedThreadCwd,
      expectedBranch: gitStatus.data.refName,
      scope:
        workflowScope === "branch"
          ? { type: "branch" as const, ...(baseRef.trim() ? { baseRef: baseRef.trim() } : {}) }
          : {
              type: featureBranch
                ? ("working_tree_new_branch" as const)
                : ("working_tree" as const),
              ...(!allSelected ? { filePaths: selectedFiles.map((file) => file.path) } : {}),
            },
      ...(workflowInstructions.trim() ? { instructions: workflowInstructions.trim() } : {}),
    };
    submittedWorkflow.current = true;
    const completion = startWorkflow({
      environmentId: selectedThread.environmentId,
      input: { ...payload, commandId: CommandId.make(uuidv4()) },
    });
    navigation.goBack();
    const result = await completion;
    if (result._tag === "Failure") {
      const cause = squashAtomCommandFailure(result);
      Alert.alert(
        "Commit splitting failed",
        cause instanceof Error ? cause.message : "Could not split commits.",
      );
      return;
    }
    Alert.alert("Commit splitting finished", result.value.summary);
  };

  const runCommitAction = async (featureBranch: boolean) => {
    if (!canWriteSourceControl || (featureBranch && !canChangeThreadBranch)) return;
    const commitMessage = dialogCommitMessage.trim();
    navigation.goBack();
    await gitActions.onRunSelectedThreadGitAction({
      action: "commit",
      featureBranch,
      ...(commitMessage ? { commitMessage } : {}),
      ...(!allSelected ? { filePaths: selectedFiles.map((file) => file.path) } : {}),
    });
  };

  const android = Platform.OS === "android";
  const header = (
    <SheetHeader
      title={rewriteHistory ? "Rewrite commits" : "Commit changes"}
      subtitle={gitStatus.data?.refName ?? "(detached HEAD)"}
      onCancel={() => navigation.goBack()}
      accessibilityLabel="Cancel commit"
    />
  );

  return (
    // Material sheet drags follow the first nested-scrolling native view, and the inline
    // header's Compose button is one, so Android renders content first and reverses the column.
    <View
      collapsable={false}
      className="bg-sheet ios:flex-1 android:flex-col-reverse"
      style={android ? { maxHeight: windowHeight * 0.92 } : undefined}
    >
      <ScreenContent fitToContents>
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
          {!rewriteHistory && (
            <View accessibilityRole="radiogroup" accessibilityLabel="Commit mode" className="gap-2">
              {(["single", "logical"] as const).map((mode) => (
                <Pressable
                  key={mode}
                  accessibilityRole="radio"
                  accessibilityState={{ checked: commitMode === mode }}
                  onPress={() => setCommitMode(mode)}
                  className="min-h-12 flex-row items-center gap-2"
                >
                  <Text className="text-foreground text-sm">
                    {commitMode === mode ? "●" : "○"}{" "}
                    {mode === "single" ? "Single commit" : "Logical commits"}
                  </Text>
                </Pressable>
              ))}
            </View>
          )}
          {isWorkflow && (
            <View className="gap-3 bg-card p-4 android:rounded-[20px] ios:rounded-[22px]">
              <Text className="text-foreground-secondary text-sm">
                The model groups changes and writes messages using your Source Control settings. T3
                stages and commits them in this checkout, keeping a backup of the original history.
                Nothing is pushed.
              </Text>
              {workflowScope === "working_tree" && gitStatus.data?.refName === null && (
                <Text className="text-foreground-secondary text-sm">
                  Commits will be created on detached HEAD. Any paused rebase will stay paused.
                </Text>
              )}
              {workflowScope === "branch" && (
                <>
                  <TextInput
                    accessibilityLabel="Base branch"
                    value={baseRef}
                    onChangeText={setBaseRef}
                    maxLength={256}
                    placeholder="Repository default branch"
                    autoCapitalize="none"
                    autoCorrect={false}
                    className="min-h-12 rounded-xl bg-subtle px-4"
                  />
                  {workflowUnavailable && (
                    <Text className="text-warning-foreground text-sm">
                      Use a feature branch with a clean working tree to rebuild existing commits.
                    </Text>
                  )}
                </>
              )}
            </View>
          )}
          {isDefaultRef ? (
            <Text className="text-sm text-warning-foreground">
              You’re on the default branch. You can create a new branch when committing.
            </Text>
          ) : null}
          <View className="gap-2">
            <Text className="text-sm font-t3-medium text-foreground">
              {isWorkflow ? "Grouping instructions (optional)" : "Commit message"}
            </Text>
            <TextInput
              multiline
              accessibilityLabel={isWorkflow ? "Grouping instructions" : "Commit message"}
              value={isWorkflow ? workflowInstructions : dialogCommitMessage}
              onChangeText={isWorkflow ? setWorkflowInstructions : setDialogCommitMessage}
              placeholder={
                isWorkflow ? "Describe the desired commit sequence…" : "Describe your changes…"
              }
              textAlignVertical="top"
              className="min-h-24 rounded-xl bg-subtle px-4 py-3 text-base"
            />
            <Text className="text-xs text-foreground-muted">
              {isWorkflow
                ? "Leave empty to use Source Control settings."
                : "Leave empty to generate a message automatically."}
            </Text>
          </View>
          <View style={isWorkflow && workflowScope === "branch" ? { display: "none" } : undefined}>
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
            {allFiles.length > 0 && (
              <View className="flex-row items-center justify-between gap-3">
                <Text className="text-foreground-muted text-sm">Group by directory</Text>
                <ThemedSwitch
                  accessibilityLabel="Group by directory"
                  value={groupByDirectory}
                  disabled={!AsyncResult.isSuccess(preferences)}
                  onValueChange={(value) => savePreferences({ gitFilesGroupByDirectory: value })}
                />
              </View>
            )}
            {allFiles.length === 0 ? (
              <Text className="py-4 text-sm text-foreground-muted">
                No changed files to commit.
              </Text>
            ) : groupByDirectory ? (
              <View className="gap-1">
                {groupedRows.map(({ node, depth }) => {
                  const files = node.kind === "directory" ? node.files : [node.file];
                  const includedCount = files.filter(
                    (file) => !excludedFiles.has(file.path),
                  ).length;
                  const checked =
                    includedCount === files.length ? true : includedCount === 0 ? false : "mixed";
                  return (
                    <View
                      key={`${node.kind}:${node.path}`}
                      className="flex-row items-center gap-2"
                      style={{ paddingLeft: depth * 12 }}
                    >
                      {
                        <Pressable
                          accessibilityRole="checkbox"
                          accessibilityLabel={`Include ${node.kind === "directory" ? "directory " : ""}${node.path}`}
                          accessibilityState={{ checked }}
                          className="min-h-11 w-8 items-center justify-center"
                          onPress={() =>
                            setExcludedFiles((current) => toggleCommitFiles(files, current))
                          }
                        >
                          <SymbolView
                            name={checked === "mixed" ? "minus" : checked ? "checkmark" : "circle"}
                            size={20}
                            tintColorClassName="accent-foreground"
                          />
                        </Pressable>
                      }
                      {node.kind === "directory" ? (
                        <Pressable
                          accessibilityRole="button"
                          accessibilityLabel={node.path}
                          accessibilityState={{ expanded: !collapsed.has(node.path) }}
                          className="min-h-11 flex-1 flex-row items-center gap-2"
                          onPress={() =>
                            setCollapsed((current) => {
                              const next = new Set(current);
                              if (next.has(node.path)) next.delete(node.path);
                              else next.add(node.path);
                              return next;
                            })
                          }
                        >
                          <SymbolView
                            name={collapsed.has(node.path) ? "chevron.right" : "chevron.down"}
                            size={12}
                            tintColorClassName="accent-foreground-muted"
                          />
                          <SymbolView
                            name="folder"
                            size={16}
                            tintColorClassName="accent-foreground-muted"
                          />
                          <Text
                            className="text-foreground flex-1 text-sm font-medium"
                            numberOfLines={1}
                          >
                            {node.name}
                          </Text>
                          <Text className="text-foreground-muted text-xs">{files.length}</Text>
                        </Pressable>
                      ) : (
                        <View
                          accessibilityLabel={node.path}
                          className="min-h-11 flex-1 flex-row items-center gap-2 pl-4"
                        >
                          <Text
                            className={cn(
                              "flex-1 text-sm",
                              includedCount ? "text-foreground" : "text-foreground-muted",
                            )}
                            numberOfLines={1}
                          >
                            {node.name}
                          </Text>
                          {includedCount ? (
                            <>
                              <Text className="text-xs font-t3-bold text-adaptive-emerald-700-300">
                                +{formatDiffCount(node.file.insertions)}
                              </Text>
                              <Text className="text-xs font-t3-bold text-adaptive-rose-700-300">
                                -{formatDiffCount(node.file.deletions)}
                              </Text>
                            </>
                          ) : (
                            <Text className="text-foreground-muted text-xs">Excluded</Text>
                          )}
                        </View>
                      )}
                    </View>
                  );
                })}
              </View>
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
          {isWorkflow ? (
            <View className="gap-2">
              <Button
                label={rewriteHistory ? "Rebuild history" : "Create logical commits"}
                icon="arrow.branch"
                tone="primary"
                fullWidth
                disabled={!canStartWorkflow || workflowUnavailable || busy}
                onPress={() => void runWorkflow()}
              />
              {!rewriteHistory ? (
                <Button
                  label="Commit on a new branch"
                  icon="arrow.branch"
                  tone="text"
                  fullWidth
                  disabled={
                    !canStartWorkflow || !canChangeThreadBranch || workflowUnavailable || busy
                  }
                  onPress={() => void runWorkflow(true)}
                />
              ) : null}
            </View>
          ) : (
            <View className="gap-2">
              <Button
                label="Commit changes"
                icon="checkmark"
                tone="primary"
                fullWidth
                disabled={!canWriteSourceControl || noneSelected || busy}
                onPress={() => void runCommitAction(false)}
              />
              <Button
                label="Commit on a new branch"
                icon="arrow.branch"
                tone="text"
                fullWidth
                disabled={!canWriteSourceControl || !canChangeThreadBranch || noneSelected || busy}
                onPress={() => void runCommitAction(true)}
              />
            </View>
          )}
        </ScrollView>
      </ScreenContent>
      {header}
    </View>
  );
}
