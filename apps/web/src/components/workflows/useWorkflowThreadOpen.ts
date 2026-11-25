import {
  type LinkedThreadOpen,
  resolveLinkedThreadOpen,
} from "@lathe/client-runtime/linked-thread";
import type { EnvironmentId } from "@lathe/contracts";

import { useConnectedEnvironmentIds, useEnvironment } from "../../state/environments";
import { useLinkedEnvironments } from "../../state/peerLinks";

/**
 * How this client opens an agent's thread on `environmentId` from a run on `viaEnvironmentId`:
 * its own connection, else through the run's server when that server links to it.
 */
export function useWorkflowThreadOpen(
  viaEnvironmentId: EnvironmentId,
  environmentId: EnvironmentId,
): { readonly open: LinkedThreadOpen; readonly label: string | null } {
  const own = useEnvironment(environmentId);
  const connected = useConnectedEnvironmentIds().includes(environmentId);
  const linkedLabel = useLinkedEnvironments(
    connected || environmentId === viaEnvironmentId ? null : viaEnvironmentId,
    environmentId,
  ).get(environmentId);
  const open = resolveLinkedThreadOpen({
    environmentId,
    viaEnvironmentId,
    own: own === null ? undefined : { connected },
    linked: linkedLabel !== undefined,
  });
  return { open, label: open === "linked" ? (linkedLabel ?? null) : (own?.label ?? null) };
}
