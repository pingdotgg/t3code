import type { EnvironmentId, ProjectId, UserCommandSummary } from "@t3tools/contracts";

import { useEnvironmentQuery } from "~/state/query";
import { projectEnvironment } from "~/state/projects";

const NO_USER_COMMANDS: ReadonlyArray<UserCommandSummary> = [];

/** The slash commands a project's threads offer, from the user's commands.json and t3.json. */
export function useUserCommands(
  environmentId: EnvironmentId,
  projectId: ProjectId | null,
): ReadonlyArray<UserCommandSummary> {
  const query = useEnvironmentQuery(
    projectId === null
      ? null
      : projectEnvironment.listUserCommands({ environmentId, input: { projectId } }),
  );
  return query.data?.commands ?? NO_USER_COMMANDS;
}
