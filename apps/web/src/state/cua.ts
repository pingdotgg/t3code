import { createCuaEnvironmentAtoms } from "@t3tools/client-runtime/state/cua";
import type { CuaWindowPreviewState, ScopedThreadRef } from "@t3tools/contracts";

import { connectionAtomRuntime } from "../connection/runtime";
import { useEnvironmentQuery } from "./query";

export const cuaEnvironment = createCuaEnvironmentAtoms(connectionAtomRuntime);

const IDLE: CuaWindowPreviewState = { status: "idle" };

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
