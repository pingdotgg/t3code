import { NativeStackScreenOptions } from "../native/StackHeader";
import { View } from "react-native";
import { EmptyState } from "./EmptyState";
import { LoadingScreen } from "./LoadingScreen";
import type { threadLocalWorkspace } from "../state/threadLocalWorkspace";

export function LocalWorkspaceNotice({
  state,
  title,
}: {
  readonly title: string;
  readonly state: ReturnType<typeof threadLocalWorkspace>["localWorkspaceState"];
}) {
  return (
    <View className="flex-1 items-center justify-center bg-sheet px-6">
      <NativeStackScreenOptions options={{ title }} />
      {state === "loading" ? (
        <LoadingScreen message="Loading conversation workspace..." />
      ) : (
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
      )}
    </View>
  );
}
