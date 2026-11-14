import { Platform, Pressable, View } from "react-native";
import { NativeScrollEdgeEffectsContext } from "../../native/NativeScrollViewMarker";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { ComposerInlineControl } from "../../components/ComposerToolbar";
import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import type { ReactNode } from "react";
import { AppBar } from "../../components/ui/AppBar";
import { ComposerEditor } from "../../components/ComposerEditor";
import { ThreadScreenFallback } from "./ThreadScreenHost";
import { threadHeaderAppearance } from "./thread-header-appearance";
import { NATIVE_LIQUID_GLASS_SUPPORTED } from "../../native/native-glass";

export function NewTaskWorkspaceIcon(props: {
  readonly workspaceMode: "local" | "worktree";
  readonly worktreePath: string | null;
  readonly size: number;
}) {
  if (props.workspaceMode === "local" && props.worktreePath === null) {
    return (
      <SymbolView
        name="folder"
        size={props.size}
        tintColorClassName="accent-icon-muted"
        type="monochrome"
      />
    );
  }

  const boxSize = (14 * props.size) / 16;
  return (
    <View
      className="size-4"
      style={Platform.OS === "android" ? { width: boxSize, height: boxSize } : undefined}
    >
      <SymbolView
        name="folder"
        size={props.size}
        tintColorClassName="accent-icon-muted"
        type="monochrome"
      />
      <View
        className="absolute -right-1 -bottom-1"
        style={
          Platform.OS === "android" ? { right: -boxSize / 4, bottom: -boxSize / 4 } : undefined
        }
      >
        <SymbolView
          name="arrow.triangle.branch"
          size={Math.round((9 * props.size) / 16)}
          tintColorClassName="accent-icon-muted"
          type="monochrome"
        />
      </View>
    </View>
  );
}

/** The empty draft's headline: either the project-less prompt or the project it will build in. */
export function NewTaskDraftHero(props: {
  readonly isScratchDraft: boolean;
  readonly projectTitle: string;
  readonly projectLabel: string | null;
  readonly interactionLocked: boolean;
  readonly onChooseProject: () => void;
  readonly environmentControl: ReactNode;
  readonly shareUnavailableNotice: ReactNode;
}) {
  if (props.isScratchDraft) {
    return (
      <View className="items-center gap-2 px-6" testID="new-task-hero">
        <Text className="text-center text-2xl font-t3-medium tracking-tight text-foreground">
          What should we work on?
        </Text>
        <View className="flex-row flex-wrap items-center justify-center gap-x-1">
          <ComposerInlineControl
            accessibilityHint="Opens the project picker"
            accessibilityLabel="No project"
            chevronDirection="right"
            disabled={props.interactionLocked}
            icon="folder"
            label="No project"
            onPress={props.onChooseProject}
          />
          {props.environmentControl}
        </View>
        {props.shareUnavailableNotice}
      </View>
    );
  }
  const label = props.projectLabel ?? props.projectTitle;
  return (
    <View className="items-center gap-6 px-6" testID="new-task-hero">
      <View className="w-full items-center gap-1.5">
        <Text className="text-center text-2xl font-t3-medium tracking-tight text-foreground">
          What should we build
        </Text>
        <View className="max-w-full flex-row items-center justify-center">
          <Text className="text-2xl font-t3-medium tracking-tight text-foreground">in </Text>
          <Pressable
            accessibilityHint="Opens the project picker"
            accessibilityLabel={label}
            accessibilityRole="button"
            disabled={props.interactionLocked}
            onPress={props.onChooseProject}
            className="min-w-0 max-w-[250px] border-b border-foreground-muted active:opacity-65"
          >
            <Text
              className="text-2xl font-t3-medium tracking-tight text-foreground"
              numberOfLines={1}
            >
              {label}
            </Text>
          </Pressable>
          <Text className="text-2xl font-t3-medium tracking-tight text-foreground">?</Text>
        </View>
      </View>

      {props.environmentControl}
      {props.shareUnavailableNotice}
    </View>
  );
}

/** The nested hero scroll view does not receive UIKit's automatic navigation inset in split columns. */
export function newTaskDraftHeroViewport(props: {
  readonly hero: ReactNode;
  readonly headerInset: number;
  readonly bottomInset: number;
  readonly availableHeight: number;
}) {
  if (props.availableHeight < 180) return null;
  return (
    <NativeScrollEdgeEffectsContext
      value={{ top: "hidden", bottom: "hidden", left: "hidden", right: "hidden" }}
    >
      <View
        collapsable={false}
        style={{
          position: "absolute",
          top: props.headerInset,
          bottom: props.bottomInset,
          left: 0,
          right: 0,
          overflow: "hidden",
        }}
      >
        <ScrollView
          alwaysBounceVertical={false}
          className="flex-1"
          contentInsetAdjustmentBehavior="never"
          contentContainerClassName="grow items-center"
          contentContainerStyle={{ paddingVertical: 24 }}
          keyboardDismissMode={Platform.OS === "ios" ? "interactive" : "on-drag"}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
          style={{ flex: 1 }}
          testID="new-task-hero-scroll"
        >
          <View style={{ flexGrow: 1 }} />
          {props.hero}
          <View style={{ flexGrow: 2 }} />
        </ScrollView>
      </View>
    </NativeScrollEdgeEffectsContext>
  );
}

export function NewTaskDraftWorkspaceControls(props: {
  readonly workspaceMode: "local" | "worktree";
  readonly isGitRepo: boolean;
  readonly selectedWorktreePath: string | null;
  readonly workspaceLabel: string;
  readonly selectedBranchLabel: string;
  readonly showBranchLoading: boolean;
  readonly interactionLocked: boolean;
  readonly onToggleWorkspaceMode: () => void;
  readonly onOpenBranchPicker: () => void;
}) {
  return (
    <View className="flex-row items-center gap-1 px-2">
      <ComposerInlineControl
        accessibilityHint={`Switches to ${props.workspaceMode === "local" ? "a new worktree" : "the current checkout"}`}
        accessibilityLabel={props.workspaceLabel}
        disabled={props.interactionLocked || !props.isGitRepo}
        renderIcon={(size) => (
          <NewTaskWorkspaceIcon
            workspaceMode={props.workspaceMode}
            worktreePath={props.selectedWorktreePath}
            size={size}
          />
        )}
        label={props.workspaceLabel}
        maxWidth="100%"
        onPress={props.onToggleWorkspaceMode}
        showChevron={false}
      />

      <View className="min-w-0 shrink">
        <ComposerInlineControl
          accessibilityLabel={`${props.workspaceMode === "worktree" ? "Base branch" : "Branch"}: ${props.selectedBranchLabel}`}
          chevronDirection="right"
          disabled={props.interactionLocked || !props.isGitRepo}
          icon="arrow.triangle.branch"
          label={props.showBranchLoading ? "Loading branches…" : props.selectedBranchLabel}
          maxWidth="100%"
          onPress={props.onOpenBranchPicker}
        />
      </View>
    </View>
  );
}

/** The draft before its environment offers a model: the composer still saves what is typed. */
export function NewTaskDraftModelFallback(props: {
  readonly onBack: () => void;
  readonly environmentControl: ReactNode;
  readonly draftKey: string | null | undefined;
  readonly prompt: string;
  readonly onChangePrompt: (value: string) => void;
}) {
  return (
    <ThreadScreenFallback
      header={
        <AppBar
          title="New thread"
          sidebar={false}
          onBack={props.onBack}
          options={{
            ...threadHeaderAppearance(NATIVE_LIQUID_GLASS_SUPPORTED),
            unstable_headerSubtitle: undefined,
            unstable_headerRightItems: () => [],
            unstable_headerToolbarItems: () => [],
          }}
        />
      }
    >
      <View className="flex-1 justify-end gap-3 p-4">
        {props.environmentControl}
        <Text className="text-foreground-muted">
          Your draft is saved on this device. Connect to an environment to choose its first model.
        </Text>
        <ComposerEditor
          draftKey={props.draftKey}
          value={props.prompt}
          onChangeText={props.onChangePrompt}
          placeholder="Ask anything"
          multiline
          style={{ minHeight: 64 }}
        />
      </View>
    </ThreadScreenFallback>
  );
}
