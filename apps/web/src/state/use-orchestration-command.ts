import type {
  AtomCommand,
  AtomCommandOptions,
  AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { AuthOrchestrationOperateScope, type EnvironmentId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import { useCallback } from "react";

import { readEnvironmentScope } from "./session";
import { useAtomCommand } from "./use-atom-command";

/** Recheck the target grant for every step of a thread or project mutation. */
export function useOrchestrationCommand<W extends { readonly environmentId: EnvironmentId }, A, E>(
  command: AtomCommand<W, A, E>,
  options?: string | AtomCommandOptions,
): (value: W) => Promise<AtomCommandResult<A, E | Error>> {
  const run = useAtomCommand(command, options);
  return useCallback(
    async (value: W): Promise<AtomCommandResult<A, E | Error>> => {
      if (!readEnvironmentScope(value.environmentId, AuthOrchestrationOperateScope)) {
        return AsyncResult.failure(
          Cause.fail(new Error("This connection cannot change threads or projects.")),
        );
      }
      return run(value);
    },
    [run],
  );
}
