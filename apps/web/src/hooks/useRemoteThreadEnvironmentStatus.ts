import type { EnvironmentId } from "@t3tools/contracts";
import { usePrimaryEnvironmentId } from "../environments/primary";
import {
  useSavedEnvironmentRegistryStore,
  useSavedEnvironmentRuntimeStore,
} from "../environments/runtime";
import type { SavedEnvironmentConnectionState } from "../environments/runtime/catalog";

export function isRemoteEnvironmentDisconnected(
  connectionStates: readonly SavedEnvironmentConnectionState[],
): boolean {
  if (connectionStates.length === 0) {
    return false;
  }

  return connectionStates.every(
    (connectionState) => connectionState === "disconnected" || connectionState === "error",
  );
}

export function resolveRemoteThreadTooltip(input: {
  environmentLabel: string | null;
  isDisconnected: boolean;
}): string {
  return input.environmentLabel
    ? `${input.isDisconnected ? "Remote environment disconnected" : "Remote environment"}: ${input.environmentLabel}`
    : input.isDisconnected
      ? "Remote environment disconnected"
      : "Remote environment";
}

export function useRemoteThreadEnvironmentStatus(environmentId: EnvironmentId): {
  isRemoteThread: boolean;
  isRemoteThreadDisconnected: boolean;
  remoteThreadTooltip: string;
  threadEnvironmentLabel: string | null;
} {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const isRemoteThread = primaryEnvironmentId !== null && environmentId !== primaryEnvironmentId;
  const remoteEnvLabel = useSavedEnvironmentRuntimeStore(
    (state) => state.byId[environmentId]?.descriptor?.label ?? null,
  );
  const remoteEnvironmentConnectionState = useSavedEnvironmentRuntimeStore(
    (state) => state.byId[environmentId]?.connectionState ?? "disconnected",
  );
  const remoteEnvSavedLabel = useSavedEnvironmentRegistryStore(
    (state) => state.byId[environmentId]?.label ?? null,
  );
  const threadEnvironmentLabel = isRemoteThread
    ? (remoteEnvLabel ?? remoteEnvSavedLabel ?? "Remote")
    : null;
  const isRemoteThreadDisconnected = isRemoteEnvironmentDisconnected([
    remoteEnvironmentConnectionState,
  ]);
  const remoteThreadTooltip = resolveRemoteThreadTooltip({
    environmentLabel: threadEnvironmentLabel,
    isDisconnected: isRemoteThreadDisconnected,
  });

  return {
    isRemoteThread,
    isRemoteThreadDisconnected,
    remoteThreadTooltip,
    threadEnvironmentLabel,
  };
}
