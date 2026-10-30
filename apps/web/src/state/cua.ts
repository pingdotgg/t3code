import { createCuaEnvironmentAtoms } from "@t3tools/client-runtime/state/cua";
import type { CuaWindowPreviewState, ScopedThreadRef, EnvironmentId } from "@t3tools/contracts";

import { connectionAtomRuntime } from "../connection/runtime";
import { useEnvironmentQuery } from "./query";

const cuaEnvironment = createCuaEnvironmentAtoms(connectionAtomRuntime);

const IDLE: CuaWindowPreviewState = { status: "idle" };

export function useCuaApplications(environmentId: EnvironmentId | null) {
  return useEnvironmentQuery(
    environmentId === null ? null : cuaEnvironment.applications({ environmentId, input: {} }),
  );
}

/** Subscribes while mounted; the server captures only for mounted subscribers. */
export function useCuaWindowPreview(threadRef: ScopedThreadRef | null): CuaWindowPreviewState {
  const query = useEnvironmentQuery(
    threadRef === null
      ? null
      : cuaEnvironment.windowPreview({
          environmentId: threadRef.environmentId,
          input: { threadId: threadRef.threadId },
        }),
  );
  return query.data ?? IDLE;
}
