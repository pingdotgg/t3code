import type { EnvironmentId } from "@t3tools/contracts";

import {
  useCanSourceUpdate,
  useSourceUpdateActions,
  useSourceUpdateState,
} from "./useSourceUpdate";

/** Fork-only: a Pull in the checkout the server runs from also rebuilds and restarts it. */
export function useUpdateAfterPull(environmentId: EnvironmentId | null, cwd: string | null) {
  const canUpdate = useCanSourceUpdate(environmentId);
  const { status } = useSourceUpdateState(canUpdate ? environmentId : null);
  const { update } = useSourceUpdateActions();
  const isCheckout =
    canUpdate && cwd !== null && status?.checkout != null && trimSlash(cwd) === status.checkout;
  return () => {
    if (isCheckout && environmentId !== null) void update(environmentId);
  };
}

const trimSlash = (path: string) => path.replace(/\/+$/, "");
