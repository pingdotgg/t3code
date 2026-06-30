/**
 * Thin compatibility shim: re-exports useRemoteEnvironmentRuntime under the
 * previous name used by the Workflow Boards screens, always returning a
 * non-null EnvironmentRuntimeState (defaults to "offline" when not connected).
 */
import type { EnvironmentId } from "@t3tools/contracts";

import type { EnvironmentRuntimeState } from "./remote-runtime-types";
import { useRemoteEnvironmentRuntime } from "./use-remote-environment-registry";

const DISCONNECTED_RUNTIME: EnvironmentRuntimeState = {
  connectionState: "offline",
  connectionError: null,
  connectionErrorTraceId: null,
  serverConfig: null,
};

export function useEnvironmentRuntime(
  environmentId: EnvironmentId | null,
): EnvironmentRuntimeState {
  return useRemoteEnvironmentRuntime(environmentId) ?? DISCONNECTED_RUNTIME;
}
