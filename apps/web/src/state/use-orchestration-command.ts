import type {
  AtomCommand,
  AtomCommandOptions,
  AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import {
  AuthOrchestrationOperateScope,
  EnvironmentAuthorizationError,
  type EnvironmentId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";

import { readEnvironmentScope } from "./session";
import { useAtomCommand } from "./use-atom-command";

const ORCHESTRATION_OPERATE_DENIED_MESSAGE = "This connection cannot change threads or projects.";

// Module scope: React Compiler cannot reorder an inline arrow used as a parameter default.
function hasLiveOperateGrant(environmentId: EnvironmentId): boolean {
  return readEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
}

/**
 * `permitted` replaces the live operate check, so settle, snooze and their undo can pass the
 * remembered offline grant. It runs on every call, like the default.
 */
export function useOrchestrationCommand<W extends { readonly environmentId: EnvironmentId }, A, E>(
  command: AtomCommand<W, A, E>,
  options?: string | AtomCommandOptions,
  permitted: (environmentId: EnvironmentId) => boolean = hasLiveOperateGrant,
): (value: W) => Promise<AtomCommandResult<A, E | EnvironmentAuthorizationError>> {
  const run = useAtomCommand(command, options);
  return async (value: W): Promise<AtomCommandResult<A, E | EnvironmentAuthorizationError>> => {
    if (!permitted(value.environmentId)) {
      return AsyncResult.failure(
        Cause.fail(
          new EnvironmentAuthorizationError({
            requiredScope: AuthOrchestrationOperateScope,
            message: ORCHESTRATION_OPERATE_DENIED_MESSAGE,
          }),
        ),
      );
    }
    return run(value);
  };
}
