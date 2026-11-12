import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";

import { environmentServerConfigsAtom } from "../state/server";

/** Labs → Agent Teams. Off hides human team surfaces; bindings and MCP stay. */
export function useAgentTeamsEnabled(environmentId: EnvironmentId | null | undefined): boolean {
  const configs = useAtomValue(environmentServerConfigsAtom);
  if (environmentId === null || environmentId === undefined) return false;
  return configs.get(environmentId)?.settings.agentTeamsEnabled === true;
}

/** True when any connected environment has Labs → Agent Teams on (for global customize menus). */
export function useAnyAgentTeamsEnabled(): boolean {
  const configs = useAtomValue(environmentServerConfigsAtom);
  for (const config of configs.values()) {
    if (config.settings.agentTeamsEnabled === true) return true;
  }
  return false;
}
