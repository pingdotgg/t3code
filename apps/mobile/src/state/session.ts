import { useAtomValue } from "@effect/atom-react";
import {
  createEnvironmentSessionAtoms,
  sessionDeniesScope,
} from "@t3tools/client-runtime/state/session";
import {
  type AuthEnvironmentScope,
  type AuthSessionState,
  type EnvironmentId,
  sessionGrantsScope,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { useMemo } from "react";

import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "./atom-registry";

export const environmentSession = createEnvironmentSessionAtoms(connectionAtomRuntime);

const EMPTY_SESSION_STATE_ATOM = Atom.make(AsyncResult.initial<AuthSessionState>());

export type EnvironmentScopeAccess = "granted" | "denied" | "signed-out" | "unknown";

function sessionScopeAccess(
  result: AsyncResult.AsyncResult<AuthSessionState, unknown>,
  scope: AuthEnvironmentScope,
): EnvironmentScopeAccess {
  const session = Option.getOrNull(AsyncResult.value(result));
  if (result._tag === "Failure" || session === null) return "unknown";
  if (!session.authenticated) return "signed-out";
  return sessionGrantsScope(session, scope) ? "granted" : "denied";
}

export function sessionHasScope(
  result: AsyncResult.AsyncResult<AuthSessionState, unknown>,
  scope: AuthEnvironmentScope,
): boolean {
  return sessionScopeAccess(result, scope) === "granted";
}

function sessionStateAtomFor(environmentId: EnvironmentId | null) {
  return environmentId === null
    ? EMPTY_SESSION_STATE_ATOM
    : environmentSession.sessionStateAtom(environmentId);
}

/** Separates a grant the session lacks from expired credentials and a session that never loaded. */
export function useEnvironmentScopeAccess(
  environmentId: EnvironmentId | null,
  scope: AuthEnvironmentScope,
): EnvironmentScopeAccess {
  // Select the access: every revalidation emits a new result, and most consumers are list rows.
  return useAtomValue(sessionStateAtomFor(environmentId), (result) =>
    sessionScopeAccess(result, scope),
  );
}

export function useEnvironmentScope(
  environmentId: EnvironmentId | null,
  scope: AuthEnvironmentScope,
): boolean {
  return useEnvironmentScopeAccess(environmentId, scope) === "granted";
}

/** Unlike `!useEnvironmentScope`, stays false until the host has answered without the scope. */
export function useEnvironmentScopeDenied(
  environmentId: EnvironmentId | null,
  scope: AuthEnvironmentScope,
): boolean {
  return useAtomValue(sessionStateAtomFor(environmentId), (result) =>
    sessionDeniesScope(result, scope),
  );
}

export function useEnvironmentsWithScope(
  environments: ReadonlyArray<{ readonly environmentId: EnvironmentId }>,
  scope: AuthEnvironmentScope,
): ReadonlySet<EnvironmentId> {
  const permittedEnvironments = useMemo(
    () =>
      Atom.make((get) => {
        const permitted = new Set<EnvironmentId>();
        for (const { environmentId } of environments) {
          if (sessionHasScope(get(environmentSession.sessionStateAtom(environmentId)), scope)) {
            permitted.add(environmentId);
          }
        }
        return permitted;
      }),
    [environments, scope],
  );
  return useAtomValue(permittedEnvironments);
}

export function readEnvironmentScope(
  environmentId: EnvironmentId,
  scope: AuthEnvironmentScope,
): boolean {
  const result = appAtomRegistry.get(environmentSession.sessionStateAtom(environmentId));
  return sessionHasScope(result, scope);
}

const EMPTY_PREPARED_CONNECTION_ATOM = Atom.make(Option.none()).pipe(
  Atom.withLabel("mobile-prepared-connection:empty"),
);

export function usePreparedConnection(environmentId: EnvironmentId | null) {
  return useAtomValue(
    environmentId === null
      ? EMPTY_PREPARED_CONNECTION_ATOM
      : environmentSession.preparedConnectionValueAtom(environmentId),
  );
}
