import { SymbolView } from "../../components/ui/AppSymbol";
import { Platform, Pressable, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { NewThreadButton } from "../../components/NewThreadButton";
import { FloatingActionButton } from "../../components/ui/FloatingActionButton";
import { EmptyState } from "../../components/ui/EmptyState";
import type { WorkspaceTab } from "../workspace/workspace-tabs-state";

export function WorkspaceEmptyDetail(props: {
  readonly tab?: WorkspaceTab;
  readonly onStartNewTask?: () => void;
  readonly onAddConnection?: () => void;
}) {
  const pullRequests = props.tab === "pullRequests";
  return (
    <View
      className={
        Platform.OS === "android"
          ? "flex-1 items-center justify-center px-10"
          : "flex-1 items-center justify-center bg-screen px-10"
      }
    >
      {props.onAddConnection ? (
        <View className="w-full max-w-[430px]">
          <EmptyState
            title="No environments connected"
            detail="Add an environment to load projects and start coding sessions."
            variant="plain"
            action={
              <FloatingActionButton
                label="Add environment"
                icon="plus"
                variant="extended"
                tone="primary"
                onPress={props.onAddConnection}
              />
            }
          />
        </View>
      ) : (
        <View className="max-w-[360px] items-center gap-3">
          <SymbolView
            name="sidebar.left"
            size={34}
            tintColorClassName="accent-icon-subtle"
            type="hierarchical"
          />
          <Text className="text-center text-xl font-t3-bold">
            {pullRequests ? "Select a pull request" : "Select a thread"}
          </Text>
          <Text className="text-center text-base text-foreground-muted">
            {pullRequests
              ? "Choose a pull request from the sidebar to review it."
              : Platform.OS === "android"
                ? "Choose a thread from the sidebar or start a new thread."
                : "Choose a thread from the sidebar or start a new task."}
          </Text>
          {props.onStartNewTask && !pullRequests ? (
            Platform.OS === "android" ? (
              <NewThreadButton extended className="mt-2" onPress={props.onStartNewTask} />
            ) : (
              <Pressable
                accessibilityRole="button"
                className="mt-2 flex-row items-center gap-2 rounded-full bg-primary px-5 py-3 active:opacity-70"
                onPress={props.onStartNewTask}
              >
                <Text className="text-base font-t3-bold text-primary-foreground">New thread</Text>
              </Pressable>
            )
          ) : null}
        </View>
      )}
    </View>
  );
}
