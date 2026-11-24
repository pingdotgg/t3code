import { EnvironmentRpcUnavailableError } from "@t3tools/client-runtime/rpc";
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
import { msg } from "gt-react";

import { m } from "../i18n/messages";

import { readEnvironment, readEnvironmentConnected } from "./environments";
import { readEnvironmentScope } from "./session";
import { useAtomCommand } from "./use-atom-command";

const ORCHESTRATION_OPERATE_DENIED_MESSAGE = msg(
  "This connection cannot change threads or projects.",
);

export function environmentOfflineMessage(environmentId: EnvironmentId): string {
  const label = readEnvironment(environmentId)?.label;
  return label === undefined
    ? m(msg("This environment is offline."))
    : m(msg("{environment} is offline.", { environment: label }));
}

export function readEnvironmentCanOperate(environmentId: EnvironmentId): boolean {
  return (
    readEnvironmentConnected(environmentId) &&
    readEnvironmentScope(environmentId, AuthOrchestrationOperateScope)
  );
}

export function useOrchestrationCommand<W extends { readonly environmentId: EnvironmentId }, A, E>(
  command: AtomCommand<W, A, E>,
  options?: string | AtomCommandOptions,
): (
  value: W,
) => Promise<
  AtomCommandResult<A, E | EnvironmentAuthorizationError | EnvironmentRpcUnavailableError>
> {
  const run = useAtomCommand(command, options);
  return async (value: W) => {
    if (!readEnvironmentConnected(value.environmentId)) {
      return AsyncResult.failure(
        Cause.fail(
          new EnvironmentRpcUnavailableError({
            environmentId: value.environmentId,
            message: environmentOfflineMessage(value.environmentId),
          }),
        ),
      );
    }
    if (!readEnvironmentScope(value.environmentId, AuthOrchestrationOperateScope)) {
      return AsyncResult.failure(
        Cause.fail(
          new EnvironmentAuthorizationError({
            requiredScope: AuthOrchestrationOperateScope,
            message: m(ORCHESTRATION_OPERATE_DENIED_MESSAGE),
          }),
        ),
      );
    }
    return run(value);
  };
}
