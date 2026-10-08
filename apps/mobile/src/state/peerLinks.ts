import { linkableMachines } from "@t3tools/client-runtime/link-request";
import { createPeerLinkEnvironmentAtoms } from "@t3tools/client-runtime/state/peerLinks";
import type { EnvironmentId } from "@t3tools/contracts";
import { useMemo } from "react";

import { connectionAtomRuntime } from "../connection/runtime";
import { useEnvironments } from "./environments";
import { useEnvironmentQuery } from "./query";

export const peerLinkEnvironment = createPeerLinkEnvironmentAtoms(connectionAtomRuntime);

/**
 * The user's other machines, for picking one to link `environmentId` to.
 * Reads that environment's links only while `enabled`, since listing them
 * asks every linked machine whether it answers.
 */
export function useLinkableMachines(environmentId: EnvironmentId, enabled: boolean) {
  const { environments } = useEnvironments();
  const links = useEnvironmentQuery(
    enabled ? peerLinkEnvironment.list({ environmentId, input: {} }) : null,
  );
  return useMemo(
    () =>
      linkableMachines({
        environments,
        threadEnvironmentId: environmentId,
        linkedIds: new Set(links.data?.links.map((link) => link.environmentId)),
      }),
    [environmentId, environments, links.data],
  );
}
