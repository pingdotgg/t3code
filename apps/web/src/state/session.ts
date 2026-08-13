import { useAtomValue } from "@effect/atom-react";
import {
  createEnvironmentSessionAtoms,
  currentPreparedConnection,
} from "@t3tools/client-runtime/state/session";
import { createRuntimeCommand } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";

export const environmentSession = createEnvironmentSessionAtoms(connectionAtomRuntime);

const EMPTY_PREPARED_CONNECTION_ATOM = Atom.make(Option.none()).pipe(
  Atom.withLabel("web-prepared-connection:empty"),
);

export function usePreparedConnection(environmentId: EnvironmentId | null) {
  return useAtomValue(
    environmentId === null
      ? EMPTY_PREPARED_CONNECTION_ATOM
      : environmentSession.preparedConnectionValueAtom(environmentId),
  );
}

export function readPreparedConnection(environmentId: EnvironmentId) {
  return Option.getOrNull(
    appAtomRegistry.get(environmentSession.preparedConnectionValueAtom(environmentId)),
  );
}

const readCurrentPreparedConnectionCommand = createRuntimeCommand(connectionAtomRuntime, {
  label: "environment-prepared-connection:read-current",
  execute: currentPreparedConnection,
});

export async function readCurrentPreparedConnection(environmentId: EnvironmentId) {
  const result = await readCurrentPreparedConnectionCommand.run(appAtomRegistry, environmentId);
  if (result._tag === "Failure") {
    throw Cause.squash(result.cause);
  }
  return Option.getOrNull(result.value);
}

/**
 * This client's authenticated session on one environment, as reported by that
 * environment's `/api/auth/session` endpoint. `data` stays populated across
 * SWR revalidations; `isPending` is only meaningful before the first resolve.
 */
export function useEnvironmentSessionState(environmentId: EnvironmentId) {
  const result = useAtomValue(environmentSession.sessionStateAtom(environmentId));
  return {
    data: Option.getOrNull(AsyncResult.value(result)),
    hasError: result._tag === "Failure",
    isPending: result.waiting,
  };
}
