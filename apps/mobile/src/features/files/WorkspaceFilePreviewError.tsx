import type { EnvironmentId } from "@t3tools/contracts";
import { useCallback } from "react";
import { View } from "react-native";

import { EmptyState } from "../../components/EmptyState";
import { environmentCatalog } from "../../connection/catalog";
import type { AssetUrlFailureReason } from "../../state/asset-url-state";
import { useAtomCommand } from "../../state/use-atom-command";
import { useEnvironmentPresentation } from "../../state/presentation";
import { EnvironmentConnectionNotice } from "../connection/EnvironmentConnectionNotice";

/**
 * Terminal state for a preview whose signed asset URL will not arrive. A dead
 * environment reuses the same notice the terminal and review sheets show, so the
 * user gets one recognizable way back online.
 */
export function WorkspaceFilePreviewError(props: {
  readonly environmentId: EnvironmentId | null;
  readonly reason: AssetUrlFailureReason;
  readonly onRetry: () => void;
}) {
  const { environmentId, onRetry } = props;
  const environment = useEnvironmentPresentation(environmentId);
  const retryEnvironment = useAtomCommand(environmentCatalog.retryNow, "environment retry");
  const retryConnection = useCallback(() => {
    if (environmentId !== null) void retryEnvironment(environmentId);
    onRetry();
  }, [environmentId, onRetry, retryEnvironment]);

  if (props.reason === "disconnected") {
    return (
      <View className="flex-1 bg-sheet">
        <EnvironmentConnectionNotice
          environmentLabel={environment.presentation?.entry.target.label ?? "Environment"}
          connection={
            environment.presentation?.connection ?? {
              phase: "available",
              error: null,
              traceId: null,
            }
          }
          resourceName="preview"
          onRetry={retryConnection}
        />
      </View>
    );
  }

  return (
    <View className="flex-1 items-center justify-center bg-sheet px-6">
      <EmptyState
        title="Preview unavailable"
        detail="This file may be missing, unsupported, or unavailable on this environment."
        actionLabel="Try again"
        onAction={props.onRetry}
      />
    </View>
  );
}
