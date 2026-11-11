import { useAtomValue } from "@effect/atom-react";
import { mergeAgentLibraries, type McpGatewayProfile } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { environmentServerConfigsAtom } from "./server";

/** Every known environment's agents, merged into one library as the Agents board does. */
const agentProfilesAtom = Atom.make(
  (get) =>
    mergeAgentLibraries(
      [...get(environmentServerConfigsAtom).values()].map((config) => config.settings),
    ).mcpGatewayProfiles,
).pipe(Atom.keepAlive);

export function useAgentProfiles(): ReadonlyArray<McpGatewayProfile> {
  return useAtomValue(agentProfilesAtom);
}
