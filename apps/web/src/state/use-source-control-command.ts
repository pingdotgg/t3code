import type {
  AtomCommand,
  AtomCommandOptions,
  AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import {
  AuthSourceControlWriteScope,
  EnvironmentAuthorizationError,
  type EnvironmentId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import { useCallback } from "react";

import { readEnvironmentScope } from "./session";
import { useAtomCommand } from "./use-atom-command";

/** Recheck the target grant for each mutation, including steps after a host response. */
export function useSourceControlCommand<W extends { readonly environmentId: EnvironmentId }, A, E>(
  command: AtomCommand<W, A, E>,
  options?: string | AtomCommandOptions,
): (value: W) => Promise<AtomCommandResult<A, E | EnvironmentAuthorizationError>> {
  const run = useAtomCommand(command, options);
  return useCallback(
    async (value: W): Promise<AtomCommandResult<A, E | EnvironmentAuthorizationError>> => {
      if (!readEnvironmentScope(value.environmentId, AuthSourceControlWriteScope)) {
        return AsyncResult.failure(
          Cause.fail(
            new EnvironmentAuthorizationError({
              requiredScope: AuthSourceControlWriteScope,
              message: "This connection cannot change source control.",
            }),
          ),
        );
      }
      return run(value);
    },
    [run],
  );
}
