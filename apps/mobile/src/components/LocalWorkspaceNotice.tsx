import { NativeStackScreenOptions } from "../native/StackHeader";
import { ActivityIndicator, View } from "react-native";
import { EmptyState } from "./EmptyState";
import { AppText } from "./AppText";
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
        <View className="items-center gap-4">
          <ActivityIndicator />
          <AppText className="text-sm text-foreground-muted">
            Loading conversation workspace...
          </AppText>
        </View>
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
