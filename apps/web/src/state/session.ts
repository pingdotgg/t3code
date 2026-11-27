import { useAtomValue } from "@effect/atom-react";
import {
  createEnvironmentSessionAtoms,
  sessionDeniesScope,
} from "@t3tools/client-runtime/state/session";
import {
  type AuthEnvironmentScope,
  type AuthSessionState,
  AuthRelayConfigureScope,
  type EnvironmentId,
  sessionGrantsScope,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentAtomList, environmentIdsKey } from "./environmentAtomList";

export const environmentSession = createEnvironmentSessionAtoms(connectionAtomRuntime);
export const environmentSessionStatesAtom = environmentAtomList(
  "web-environment-session-states",
  environmentSession.sessionStateAtom,
);

const EMPTY_SESSION_STATE_ATOM = Atom.make(AsyncResult.initial<AuthSessionState>());

export function useEnvironmentScope(
  environmentId: EnvironmentId | null,
  scope: AuthEnvironmentScope,
): boolean {
  // Select the grant: every revalidation emits a new result, and most consumers are list rows.
  return useAtomValue(
    environmentId === null
      ? EMPTY_SESSION_STATE_ATOM
      : environmentSession.sessionStateAtom(environmentId),
    (result) => sessionHasScope(result, scope),
  );
}

export function useEnvironmentCanConfigureRelay(environmentId: EnvironmentId | null): boolean {
  return useAtomValue(
    environmentId === null
      ? EMPTY_SESSION_STATE_ATOM
      : environmentSession.sessionStateAtom(environmentId),
    (result) => sessionHasScope(result, AuthRelayConfigureScope),
  );
}

export function readEnvironmentCanConfigureRelay(environmentId: EnvironmentId): boolean {
  const result = appAtomRegistry.get(environmentSession.sessionStateAtom(environmentId));
  return sessionHasScope(result, AuthRelayConfigureScope);
}

/** This client's own session on the environment, or null until the host has said. */
export function useEnvironmentSessionId(environmentId: EnvironmentId | null): string | null {
  return useAtomValue(
    environmentId === null
      ? EMPTY_SESSION_STATE_ATOM
      : environmentSession.sessionStateAtom(environmentId),
    (result) => AsyncResult.getOrElse(result, () => null)?.sessionId ?? null,
  );
}

export function sessionHasScope(
  result: AsyncResult.AsyncResult<AuthSessionState, unknown>,
  scope: AuthEnvironmentScope,
): boolean {
  const session = AsyncResult.getOrElse(result, () => null);
  return result._tag !== "Failure" && session !== null && sessionGrantsScope(session, scope);
}

const environmentsWithScopeAtom = Atom.family((key: string) => {
  const [scope, idsKey = ""] = key.split(/\n(.*)/s) as [AuthEnvironmentScope, string?];
  const ids = idsKey === "" ? [] : (idsKey.split("\n") as EnvironmentId[]);
  const statesAtom = environmentSessionStatesAtom(idsKey);
  return Atom.make((get) => {
    const states = get(statesAtom);
    return new Set(ids.filter((_, index) => sessionHasScope(states[index]!, scope)));
  }).pipe(Atom.withLabel(`web-environments-with-scope:${key}`));
});

export function useEnvironmentsWithScope(
  environments: ReadonlyArray<{ readonly environmentId: EnvironmentId }>,
  scope: AuthEnvironmentScope,
): ReadonlySet<EnvironmentId> {
  return useAtomValue(
    environmentsWithScopeAtom(
      `${scope}\n${environmentIdsKey(environments.map(({ environmentId }) => environmentId))}`,
    ),
  );
}

export function readEnvironmentScope(
  environmentId: EnvironmentId,
  scope: AuthEnvironmentScope,
): boolean {
  return sessionHasScope(
    appAtomRegistry.get(environmentSession.sessionStateAtom(environmentId)),
    scope,
  );
}

/** Unlike `!useEnvironmentScope`, stays false until the host has answered without the scope. */
export function useEnvironmentScopeDenied(
  environmentId: EnvironmentId | null,
  scope: AuthEnvironmentScope,
): boolean {
  return useAtomValue(
    environmentId === null
      ? EMPTY_SESSION_STATE_ATOM
      : environmentSession.sessionStateAtom(environmentId),
    (result) => sessionDeniesScope(result, scope),
  );
}

export function readEnvironmentScopeDenied(
  environmentId: EnvironmentId,
  scope: AuthEnvironmentScope,
): boolean {
  return sessionDeniesScope(
    appAtomRegistry.get(environmentSession.sessionStateAtom(environmentId)),
    scope,
  );
}

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

/** Each environment's prepared connection, in the order of the ids. */
export const preparedConnectionsAtom = environmentAtomList(
  "web-prepared-connections",
  environmentSession.preparedConnectionValueAtom,
);

export function readPreparedConnection(environmentId: EnvironmentId) {
  return Option.getOrNull(
    appAtomRegistry.get(environmentSession.preparedConnectionValueAtom(environmentId)),
  );
}

/** data survives SWR revalidation; isPending applies only before first resolve. */
export function useEnvironmentSessionState(environmentId: EnvironmentId | null) {
  const result = useAtomValue(
    environmentId === null
      ? EMPTY_SESSION_STATE_ATOM
      : environmentSession.sessionStateAtom(environmentId),
  );
  return {
    data: AsyncResult.getOrElse(result, () => null),
    hasError: result._tag === "Failure",
    isPending: result.waiting,
  };
}
