import { View } from "react-native";
import { EmptyState } from "./EmptyState";
import { LoadingScreen } from "./LoadingScreen";
import type { threadLocalWorkspace } from "../state/threadLocalWorkspace";

export function LocalWorkspaceNotice({
  state,
}: {
  readonly state: ReturnType<typeof threadLocalWorkspace>["localWorkspaceState"];
}) {
  if (state === "loading") return <LoadingScreen message="Loading conversation workspace..." />;
  return (
    <View className="flex-1 bg-screen">
      <EmptyState
        title={
          state === "error"
            ? "Workspace could not be loaded"
            : state === "cloud"
              ? "Remote workspace"
              : "Workspace unavailable"
        }
        detail={
          state === "error"
            ? "Check the environment connection and reopen this conversation to try again."
            : state === "cloud"
              ? "This cloud conversation cannot use local files, Git, terminals or review diffs."
              : "This conversation has no available local workspace."
        }
      />
    </View>
  );
}
