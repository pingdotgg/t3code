import type { EnvironmentId } from "@t3tools/contracts";
import { useGT } from "gt-react-native";
import { View } from "react-native";

import { EmptyState } from "../../components/ui/EmptyState";
import type { AssetUrlFailureReason } from "../../state/asset-url-state";
import { useEnvironmentPresentation } from "../../state/presentation";
import { EnvironmentConnectionNotice } from "../connection/EnvironmentConnectionNotice";
import { useRetryEnvironment } from "../connection/useRetryEnvironment";

export function WorkspaceFilePreviewError(props: {
  readonly environmentId: EnvironmentId | null;
  readonly reason: AssetUrlFailureReason;
  readonly onRetry: () => void;
}) {
  const { environmentId, onRetry } = props;
  const gt = useGT();
  const environment = useEnvironmentPresentation(environmentId);
  const retryEnvironment = useRetryEnvironment();
  const retryConnection = () => {
    if (environmentId !== null) void retryEnvironment(environmentId);
    onRetry();
  };

  if (props.reason === "disconnected") {
    return (
      <View className="flex-1 bg-sheet">
        <EnvironmentConnectionNotice
          environmentLabel={
            environment.presentation?.entry.target.label ??
            gt("Environment", { $context: "fallback environment name" })
          }
          connection={
            environment.presentation?.connection ?? {
              phase: "available",
              error: null,
              traceId: null,
            }
          }
          resource="preview"
          onRetry={retryConnection}
        />
      </View>
    );
  }

  return (
    <View className="flex-1 items-center justify-center bg-sheet px-6">
      <EmptyState
        title={gt("Preview unavailable")}
        detail={gt("This file may be missing, unsupported, or unavailable on this environment.")}
        actionLabel={gt("Try again")}
        onAction={props.onRetry}
      />
    </View>
  );
}
