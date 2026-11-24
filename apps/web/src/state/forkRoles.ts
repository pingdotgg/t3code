import { createForkRolesEnvironmentAtoms } from "@t3tools/client-runtime/state/fork-roles";
import type { EnvironmentId } from "@t3tools/contracts";

import { connectionAtomRuntime } from "../connection/runtime";
import { useEnvironmentQuery } from "./query";
import { serverEnvironment } from "./server";

export const forkRolesEnvironment = createForkRolesEnvironmentAtoms(
  connectionAtomRuntime,
  serverEnvironment.settingsValueAtom,
);

export function useForkRoles(environmentId: EnvironmentId | null) {
  return useEnvironmentQuery(
    environmentId === null ? null : forkRolesEnvironment.list({ environmentId, input: {} }),
  ).data;
}

export function useForkRole(environmentId: EnvironmentId, roleId: string | null) {
  const roles = useForkRoles(roleId === null ? null : environmentId);
  return roles?.roles.find((role) => role.id === roleId) ?? null;
}
