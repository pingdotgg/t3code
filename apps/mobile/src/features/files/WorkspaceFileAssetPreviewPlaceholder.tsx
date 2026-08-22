import { ActivityIndicator, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { EmptyState } from "../../components/EmptyState";
import type { AssetUrlState } from "../../state/assets";

export function WorkspaceFileAssetPreviewPlaceholder(props: {
  readonly preparingLabel: string;
  readonly status: Exclude<AssetUrlState, { readonly _tag: "Success" }>;
  readonly onRetry: () => void;
}) {
  if (props.status._tag === "Loading") {
    return (
      <View className="flex-1 items-center justify-center gap-3 bg-card px-6">
        <ActivityIndicator />
        <Text className="text-center text-sm text-foreground-muted">{props.preparingLabel}</Text>
      </View>
    );
  }

  return (
    <View className="flex-1 items-center justify-center bg-card px-6">
      <EmptyState
        title="Preview unavailable"
        detail={
          props.status._tag === "Disconnected"
            ? "Reconnect the environment, then retry."
            : "The preview URL could not be created."
        }
        actionLabel="Retry"
        onAction={props.onRetry}
      />
    </View>
  );
}
