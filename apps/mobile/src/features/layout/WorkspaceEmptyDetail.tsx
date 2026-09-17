import { SymbolView } from "../../components/AppSymbol";
import { Platform, Pressable, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { MaterialNewThreadButton } from "../../components/MaterialNewThreadButton";
import { MaterialFloatingActionButton } from "../../components/MaterialFloatingActionButton";
import { EmptyState } from "../../components/EmptyState";

export function WorkspaceEmptyDetail(props: {
  readonly onStartNewTask?: () => void;
  readonly onAddConnection?: () => void;
}) {
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
              <MaterialFloatingActionButton
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
          <Text className="text-center text-xl font-t3-bold">Select a thread</Text>
          <Text className="text-center text-base text-foreground-muted">
            {Platform.OS === "android"
              ? "Choose a thread from the sidebar or start a new thread."
              : "Choose a thread from the sidebar or start a new task."}
          </Text>
          {props.onStartNewTask ? (
            Platform.OS === "android" ? (
              <MaterialNewThreadButton extended className="mt-2" onPress={props.onStartNewTask} />
            ) : (
              <Pressable
                accessibilityRole="button"
                className="mt-2 flex-row items-center gap-2 rounded-full bg-primary px-5 py-3 active:opacity-70"
                onPress={props.onStartNewTask}
              >
                <Text className="text-base font-t3-bold text-primary-foreground">New Task</Text>
              </Pressable>
            )
          ) : null}
        </View>
      )}
    </View>
  );
}
