import { useAtomValue } from "@effect/atom-react";
import {
  createEnvironmentAgentsAtom,
  type EnvironmentAgents,
} from "@t3tools/client-runtime/state/agentIdentity";
import type { EnvironmentId } from "@t3tools/contracts";

import { serverEnvironment } from "./server";

const environmentAgentsAtom = createEnvironmentAgentsAtom((environmentId) =>
  serverEnvironment.configValueAtom(environmentId),
);

/** The agents `@` mentions can name and resolve on one environment: its own library only. */
export function useEnvironmentAgents(
  environmentId: EnvironmentId | null | undefined,
): EnvironmentAgents {
  return useAtomValue(environmentAgentsAtom(environmentId ?? null));
}
