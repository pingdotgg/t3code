import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { createForkRolesEnvironmentAtoms } from "@t3tools/client-runtime/state/fork-roles";
import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { msg } from "gt-react";

import type { ForkRoleMenuState } from "../components/threadActionMenu.forkRoles";
import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { connectionAtomRuntime } from "../connection/runtime";
import { m } from "../i18n/messages";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { useEnvironmentQuery } from "./query";
import { serverEnvironment } from "./server";
import { threadEnvironment } from "./threads";
import { useOrchestrationCommand } from "./use-orchestration-command";

const forkRolesEnvironment = createForkRolesEnvironmentAtoms(
  connectionAtomRuntime,
  serverEnvironment.settingsValueAtom,
);

const rolesListAtom = (environmentId: EnvironmentId) =>
  forkRolesEnvironment.list({ environmentId, input: {} });

function useForkRoles(environmentId: EnvironmentId | null) {
  return useEnvironmentQuery(environmentId === null ? null : rolesListAtom(environmentId)).data;
}

export function useForkRole(environmentId: EnvironmentId, roleId: string | null) {
  const roles = useForkRoles(roleId === null ? null : environmentId);
  return roles?.roles.find((role) => role.id === roleId) ?? null;
}

/** Reading starts the fetch, so a menu opened before the first answer shows roles as loading. */
export function readForkRoleMenuState(
  environmentId: EnvironmentId,
  current: string | null,
): ForkRoleMenuState {
  const settings = appAtomRegistry.get(serverEnvironment.settingsValueAtom(environmentId));
  if (!settings?.forkRolesDirectory) return { current, list: { directory: null, roles: [] } };
  const list = AsyncResult.getOrElse(appAtomRegistry.get(rolesListAtom(environmentId)), () => null);
  return { current, list };
}

/** Sets or clears a thread's role and reports a failure as a toast. */
export function useSetThreadRole() {
  const run = useOrchestrationCommand(threadEnvironment.setRole, { reportFailure: false });
  return async (target: ScopedThreadRef, roleId: string | null) => {
    const result = await run({
      environmentId: target.environmentId,
      input: { threadId: target.threadId, roleId },
    });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: m(msg("Failed to change role")),
          description:
            thrownErrorMessage(squashAtomCommandFailure(result), m) ?? m(msg("An error occurred.")),
        }),
      );
    }
  };
}
