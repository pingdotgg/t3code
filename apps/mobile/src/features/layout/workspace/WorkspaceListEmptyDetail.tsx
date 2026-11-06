import { Platform } from "react-native";

import { AppBar } from "../../../components/ui/AppBar";
import { Toolbar } from "../../../components/ui/Toolbar";
import { NativeStackScreenOptions } from "../../../native/StackHeader";
import { useAdaptiveWorkspaceLayout } from "../adaptive-workspace-context";
import { WorkspaceEmptyDetail } from "../WorkspaceEmptyDetail";

/**
 * The thread list's route in split view, where the list is the sidebar beside it: an empty
 * detail. iOS clears the list's bar and keeps only New task.
 */
export function WorkspaceListEmptyDetail(props: {
  readonly hasConnections: boolean;
  readonly onAddConnection: () => void;
  readonly onStartNewTask: () => void;
}) {
  const { panes } = useAdaptiveWorkspaceLayout();
  return (
    <>
      <NativeStackScreenOptions
        options={{
          title: "",
          headerTitle: "",
          unstable_headerLeftItems: () => [],
          headerSearchBarOptions: undefined,
          unstable_headerRightItems: () => [],
          unstable_headerToolbarItems: () => [],
        }}
      />
      <Toolbar placement="left">
        <Toolbar.Button
          accessibilityLabel="New task"
          icon="square.and.pencil"
          onPress={props.onStartNewTask}
        />
      </Toolbar>
      <AppBar embedded title="Threads" />
      <WorkspaceEmptyDetail
        onAddConnection={
          Platform.OS === "android" && !props.hasConnections ? props.onAddConnection : undefined
        }
        onStartNewTask={
          Platform.OS === "android" && panes.primarySidebarVisible
            ? undefined
            : props.onStartNewTask
        }
      />
    </>
  );
}
