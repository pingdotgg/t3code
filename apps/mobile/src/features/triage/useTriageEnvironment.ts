import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";

import { useServerConfigs } from "../../state/entities";
import { serverEnvironment } from "../../state/server";
import { useWorkspaceEnvironments } from "../../state/workspace";
import { pickTriageEnvironment } from "./triageTarget";

/** The machine triage would start on, or null when none can run it for this user. */
export function useTriageEnvironment(onScreen: EnvironmentId | null): EnvironmentId | null {
  const environments = useWorkspaceEnvironments();
  const serverConfigs = useServerConfigs();
  const supportsTriage = (environmentId: EnvironmentId) =>
    serverConfigs.get(environmentId)?.environment.capabilities.triage === true;
  const environmentId = pickTriageEnvironment({
    onScreen,
    connected: environments
      .filter((environment) => environment.connectionState === "connected")
      .map((environment) => environment.environmentId),
    supportsTriage,
  });
  const permitted = useAtomValue(serverEnvironment.prepareTriage.permissionAtom(environmentId));
  return permitted && environmentId !== null && supportsTriage(environmentId)
    ? environmentId
    : null;
}
