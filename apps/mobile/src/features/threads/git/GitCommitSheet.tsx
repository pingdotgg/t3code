import { useRouter } from "expo-router";
import { useCallback, useState } from "react";
import { Pressable, ScrollView, View, useColorScheme } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useThemeColor } from "../../../lib/useThemeColor";

import { AppText as Text, AppTextInput as TextInput } from "../../../components/AppText";
import { useGitStatus } from "../../../state/use-git-status";
import { useThreadSelection } from "../../../state/use-thread-selection";
import { useSelectedThreadGitActions } from "../use-selected-thread-git-actions";
import { useSelectedThreadGitState } from "../use-selected-thread-git-state";
import { SheetActionButton } from "./gitSheetComponents";

export function GitCommitSheet() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const isDarkMode = useColorScheme() === "dark";
  const { selectedThread, selectedThreadProject } = useThreadSelection();
  const gitState = useSelectedThreadGitState();
  const gitActions = useSelectedThreadGitActions();

  const borderColor = useThemeColor("--color-border");
  const borderSubtleColor = useThemeColor("--color-border-subtle");
  const inputBorderColor = useThemeColor("--color-input-border");
  const inputBg = useThemeColor("--color-input");
  const foregroundColor = useThemeColor("--color-foreground");

  const gitStatus = useGitStatus({
    environmentId: selectedThread?.environmentId ?? "",
    cwd: selectedThread?.worktreePath ?? selectedThreadProject?.workspaceRoot ?? null,
  });

  const busy = gitState.gitOperationLabel !== null;
  const isDefaultBranch = gitStatus.data?.isDefaultBranch ?? false;
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
      router.dismiss();
      await gitActions.onRunSelectedThreadGitAction({
        action: "commit",
        featureBranch,
        ...(commitMessage ? { commitMessage } : {}),
        ...(!allSelected ? { filePaths: selectedFiles.map((file) => file.path) } : {}),
      });
    },
    [allSelected, dialogCommitMessage, gitActions, router, selectedFiles],
  );

  return (
    <ScrollView
      keyboardShouldPersistTaps="handled"
      showsVerticalScrollIndicator={false}
      contentContainerStyle={{
        paddingHorizontal: 20,
        paddingTop: 8,
        paddingBottom: Math.max(insets.bottom, 18) + 18,
        gap: 16,
      }}
    >
      <View className="gap-3 rounded-[22px] border border-border bg-card px-4 py-4">
        <View className="flex-row items-center justify-between gap-3">
          <Text className="text-foreground-muted text-[13px] font-medium">Branch</Text>
          <Text className="text-foreground text-[15px] font-t3-bold">
            {gitStatus.data?.branch ?? "(detached HEAD)"}
          </Text>
        </View>
        {isDefaultBranch ? (
          <Text
            className="text-[12px] leading-[18px]"
            style={{ color: isDarkMode ? "#fbbf24" : "#b45309" }}
          >
            Warning: this is the default branch.
          </Text>
        ) : null}
      </View>

      <View className="gap-3 rounded-[22px] border border-border bg-card px-4 py-4">
        <View className="flex-row items-center justify-between gap-3">
          <View className="gap-1">
            <Text className="text-foreground text-[16px] font-t3-bold">Files</Text>
            <Text className="text-foreground-muted text-[12px] leading-[18px]">
              {selectedFiles.length} selected · +{selectedInsertions} / -{selectedDeletions}
            </Text>
          </View>
          <View className="flex-row items-center gap-2">
            {!allSelected && isEditingFiles ? (
              <Pressable
                className="bg-subtle rounded-full px-3 py-2"
                onPress={() => setExcludedFiles(new Set())}
              >
                <Text className="text-foreground text-[11px] font-t3-bold uppercase">Reset</Text>
              </Pressable>
            ) : null}
            <Pressable
              className="bg-subtle rounded-full px-3 py-2"
              onPress={() => setIsEditingFiles((current) => !current)}
            >
              <Text className="text-foreground text-[11px] font-t3-bold uppercase">
                {isEditingFiles ? "Done" : "Edit"}
              </Text>
            </Pressable>
          </View>
        </View>

        {allFiles.length === 0 ? (
          <Text className="text-foreground-secondary text-[13px] leading-[19px]">
            No changed files are available to commit.
          </Text>
        ) : !isEditingFiles ? (
          <View className="gap-2">
            {selectedFilePreview.map((file) => (
              <View key={file.path} className="flex-row items-center justify-between gap-3">
                <Text className="text-foreground flex-1 text-[13px] font-medium" numberOfLines={1}>
                  {file.path}
                </Text>
                <Text className="text-[12px] font-t3-bold" style={{ color: "#10b981" }}>
                  +{file.insertions}
                </Text>
                <Text className="text-[12px] font-t3-bold" style={{ color: "#f43f5e" }}>
                  -{file.deletions}
                </Text>
              </View>
            ))}
            {selectedFiles.length > selectedFilePreview.length ? (
              <Text className="text-foreground-muted text-[12px] leading-[17px]">
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
                  className="rounded-[18px] border px-4 py-3"
                  style={{
                    borderColor: included ? borderColor : borderSubtleColor,
                  }}
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
                        className={`text-[13px] font-t3-bold ${included ? "text-foreground" : "text-foreground-muted"}`}
                      >
                        {file.path}
                      </Text>
                      {!included ? (
                        <Text className="text-foreground-muted text-[11px] leading-[16px]">
                          Excluded from this commit
                        </Text>
                      ) : null}
                    </View>
                    <View className="items-end gap-1">
                      <Text className="text-[12px] font-t3-bold" style={{ color: "#10b981" }}>
                        +{file.insertions}
                      </Text>
                      <Text className="text-[12px] font-t3-bold" style={{ color: "#f43f5e" }}>
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

      <View className="gap-2">
        <Text className="text-foreground text-[13px] font-t3-bold">Commit message</Text>
        <TextInput
          multiline
          value={dialogCommitMessage}
          onChangeText={setDialogCommitMessage}
          placeholder="Leave empty to auto-generate"
          textAlignVertical="top"
          className="min-h-[128px] rounded-[20px] px-4 py-3.5 font-sans text-[15px]"
          style={{
            minHeight: 128,
            borderWidth: 1,
            borderColor: inputBorderColor,
            backgroundColor: inputBg,
            color: foregroundColor,
          }}
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
