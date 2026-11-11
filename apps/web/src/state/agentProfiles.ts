import { useAtomValue } from "@effect/atom-react";
import {
  createAgentProfilesAtom,
  createEnvironmentAgentsAtom,
  type EnvironmentAgents,
} from "@t3tools/client-runtime/state/agentIdentity";
import type { EnvironmentId, McpGatewayProfile } from "@t3tools/contracts";

import { environmentServerConfigsAtom, serverEnvironment } from "./server";

/** Every known environment's agents, merged into one library as the Agents board does. */
const agentProfilesAtom = createAgentProfilesAtom(() => environmentServerConfigsAtom);

export function useAgentProfiles(): ReadonlyArray<McpGatewayProfile> {
  return useAtomValue(agentProfilesAtom);
}

const environmentAgentsAtom = createEnvironmentAgentsAtom((environmentId) =>
  serverEnvironment.configValueAtom(environmentId),
);

/** The agents `@` mentions can name and resolve on one environment: its own library only. */
export function useEnvironmentAgents(
  environmentId: EnvironmentId | null | undefined,
): EnvironmentAgents {
  return useAtomValue(environmentAgentsAtom(environmentId ?? null));
}
