import { sanitizeFeatureBranchName } from "@t3tools/shared/git";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { useState } from "react";
import { Platform, Pressable, ScrollView, useWindowDimensions, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppBar } from "../../../components/ui/AppBar";
import { SheetHeader } from "../../../components/ui/SheetHeader";
import { ScreenContent } from "../../../components/ui/ScreenContent";
import { NativeStackScreenOptions } from "../../../native/StackHeader";
import { AppText as Text, AppTextInput as TextInput } from "../../../components/ui/AppText";
import { cn } from "../../../lib/cn";
import { useThreadSelection } from "../../../state/use-thread-selection";
import { useSelectedThreadGitActions } from "../../../state/use-selected-thread-git-actions";
import { useSelectedThreadGitState } from "../../../state/use-selected-thread-git-state";
import { useSelectedThreadCwd } from "../../../state/use-selected-thread-cwd";
import { SheetActionButton } from "./gitSheetComponents";

type GitBranchesSheetProps = StaticScreenProps<{
  readonly environmentId: string;
  readonly threadId: string;
}>;

export function GitBranchesSheet(_props: GitBranchesSheetProps) {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const { height: windowHeight } = useWindowDimensions();
  useThreadSelection();
  useSelectedThreadCwd();
  const gitState = useSelectedThreadGitState();
  const gitActions = useSelectedThreadGitActions();
  const { canChangeThreadBranch } = gitActions;

  const availableBranches = gitState.selectedThreadBranches;
  const branchesLoading = gitState.selectedThreadBranchesLoading;
  const busy = gitState.gitOperationLabel !== null;

  const [newBranchName, setNewBranchName] = useState("");
  return (
    <View
      collapsable={false}
      className="bg-sheet ios:flex-1"
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
        <AppBar sheet title="Branches" onBack={() => navigation.goBack()} hideBottomBorder />
      ) : (
        <SheetHeader presentation="native" title="Branches" onClose={() => navigation.goBack()} />
      )}
      <ScreenContent fitToContents>
        <ScrollView
          nestedScrollEnabled
          className="android:shrink android:grow-0 ios:flex-1"
          contentInsetAdjustmentBehavior={Platform.OS === "ios" ? "automatic" : "never"}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
          contentInset={{ bottom: Math.max(insets.bottom, 18) + 18 }}
          contentContainerClassName="android:gap-2 android:p-2 ios:gap-4 ios:px-5 ios:pt-2"
          contentContainerStyle={
            Platform.OS === "android"
              ? { paddingBottom: Math.max(insets.bottom, 18) + 18 }
              : undefined
          }
        >
          <View className="bg-card android:gap-3 android:rounded-[20px] android:p-4 ios:gap-2 ios:rounded-[18px] ios:border ios:border-border ios:px-4 ios:py-4">
            <Text className="android:text-foreground android:text-base android:font-t3-medium ios:text-foreground-secondary ios:text-2xs ios:font-t3-bold ios:tracking-[1px] ios:uppercase">
              New branch
            </Text>
            <TextInput
              value={newBranchName}
              onChangeText={setNewBranchName}
              placeholder="feature/mobile-polish"
              accessibilityLabel="New branch name"
              className="android:rounded-xl android:bg-sheet-solid ios:rounded-[18px]"
            />
            <SheetActionButton
              icon="plus"
              label="Create & checkout"
              tone="primary"
              disabled={!canChangeThreadBranch || busy || newBranchName.trim().length === 0}
              onPress={() => {
                const branch = sanitizeFeatureBranchName(newBranchName.trim());
                if (branch.length === 0) return;
                void gitActions.onCreateSelectedThreadBranch(branch).then((result) => {
                  if (result === null) return;
                  setNewBranchName("");
                  navigation.goBack();
                });
              }}
            />
          </View>

          <View className="gap-2">
            <Text className="text-foreground-secondary android:px-4 android:pb-1 android:pt-3 android:text-sm android:font-t3-medium ios:text-2xs ios:font-t3-bold ios:tracking-[1px] ios:uppercase">
              Existing branches
            </Text>
            {branchesLoading ? (
              <Text className="text-foreground-secondary text-sm font-medium android:px-4">
                Loading branches...
              </Text>
            ) : null}
            {!branchesLoading && availableBranches.length === 0 ? (
              <Text className="text-foreground-secondary text-sm font-medium android:px-4">
                No local branches found.
              </Text>
            ) : null}
            {availableBranches.map((branch) => {
              const subtitle = branch.isDefault ? "Default branch" : "Local branch";

              return (
                <Pressable
                  key={branch.name}
                  className={cn(
                    "gap-1 px-4 py-3 disabled:opacity-[0.45] android:rounded-[20px] android:active:bg-subtle ios:rounded-[18px] ios:border",
                    branch.current
                      ? "android:bg-secondary ios:border-subtle-strong"
                      : "android:bg-card ios:border-border",
                  )}
                  accessibilityRole="button"
                  accessibilityState={{ selected: branch.current, disabled: busy }}
                  disabled={!canChangeThreadBranch || busy}
                  onPress={() => {
                    void gitActions.onCheckoutSelectedThreadBranch(branch.name).then((result) => {
                      if (result === null) return;
                      navigation.goBack();
                    });
                  }}
                >
                  {Platform.OS !== "android" ? (
                    <View className="absolute inset-0 rounded-[18px] bg-card" />
                  ) : null}
                  <Text className="text-foreground text-base android:font-t3-medium ios:font-t3-bold">
                    {branch.name}
                  </Text>
                  <Text className="text-foreground-secondary text-xs font-medium">{subtitle}</Text>
                </Pressable>
              );
            })}
          </View>
        </ScrollView>
      </ScreenContent>
    </View>
  );
}
