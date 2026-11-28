import { useAtomValue } from "@effect/atom-react";
import { offersLinkedEnvironments } from "@t3tools/client-runtime/link-request";
import { createThreadHandoffEnvironmentAtoms } from "@t3tools/client-runtime/state/peerLinks";
import type { EnvironmentId } from "@t3tools/contracts";

import { connectionAtomRuntime } from "../connection/runtime";
import { environmentServerConfigsAtom } from "./server";

export const threadHandoffEnvironment = createThreadHandoffEnvironmentAtoms(connectionAtomRuntime);

/** Whether `environmentId` offers links and this app may move its threads over one. */
export function useCanMoveThreads(environmentId: EnvironmentId | null): boolean {
  const permitted = useAtomValue(threadHandoffEnvironment.start.permissionAtom(environmentId));
  return useAtomValue(
    environmentServerConfigsAtom,
    (configs) =>
      permitted &&
      offersLinkedEnvironments(environmentId === null ? undefined : configs.get(environmentId)),
  );
}
