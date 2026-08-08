import type { AgentProfileCatalogResult, EnvironmentId, ProjectId } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

import { createAgentEnvironmentAtoms } from "@t3tools/client-runtime/state/agents";

import { connectionAtomRuntime } from "../connection/runtime";
import { useEnvironmentQuery } from "./query";

export const agentEnvironment = createAgentEnvironmentAtoms(connectionAtomRuntime);

const EMPTY_CATALOG = Atom.make(AsyncResult.initial<AgentProfileCatalogResult, never>(false)).pipe(
  Atom.withLabel("mobile:agents:empty-catalog"),
);

export function useAgentProfileCatalog(
  environmentId: EnvironmentId | null,
  projectId?: ProjectId | null,
  options?: { readonly includeArchived?: boolean },
) {
  return useEnvironmentQuery(
    environmentId === null
      ? EMPTY_CATALOG
      : agentEnvironment.catalog({
          environmentId,
          input: {
            includeArchived: options?.includeArchived ?? false,
            ...(projectId === null || projectId === undefined ? {} : { projectId }),
          },
        }),
  );
}

export function profileKey(profile: { readonly id: string; readonly scope: string }): string {
  return `${profile.scope}:${profile.id}`;
}

export function profileRefKey(
  profile: { readonly id: string; readonly scope: string; readonly revision: string } | null,
): string | null {
  return profile === null ? null : `${profile.scope}:${profile.id}:${profile.revision}`;
}

export {
  selectChatAgentProfiles,
  sortAgentProfiles,
} from "../features/settings/agentProfile.logic";
