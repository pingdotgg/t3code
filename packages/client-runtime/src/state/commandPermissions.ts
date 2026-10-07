import {
  clientRpcRequiredScopes,
  EnvironmentAuthorizationError,
  type EnvironmentId,
  type AuthSessionState,
  type AuthEnvironmentScope,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentSessionAtoms } from "./session.ts";

function grants(session: AuthSessionState, scope: AuthEnvironmentScope) {
  return session.authenticated && session.scopes?.includes(scope) === true;
}

/** UI availability and dispatch use the same target session and method policy. */
function makeCommandPermissions<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
  method: string,
) {
  const sessions = createEnvironmentSessionAtoms(runtime);
  const requiredScopes = (input?: unknown) => clientRpcRequiredScopes(method, input);
  const atomsByEnvironment = Atom.family((environmentId: EnvironmentId | null) =>
    Atom.family((scopeKey: string) =>
      Atom.make((get) => {
        if (environmentId === null) return false;
        const scopes = scopeKey.split(",").filter(Boolean) as AuthEnvironmentScope[];
        if (scopes.length === 0) return true;
        const result = get(sessions.sessionStateAtom(environmentId));
        const session = Option.getOrNull(AsyncResult.value(result));
        return (
          result._tag !== "Failure" &&
          session !== null &&
          scopes.every((scope) => grants(session, scope))
        );
      }),
    ),
  );
  const permissionAtom = (environmentId: EnvironmentId | null, input?: unknown) =>
    atomsByEnvironment(environmentId)(requiredScopes(input).join(","));
  const authorize = (
    registry: AtomRegistry.AtomRegistry,
    environmentId: EnvironmentId,
    input?: unknown,
  ) =>
    Effect.suspend(() => {
      const scopes = requiredScopes(input);
      if (scopes.length === 0) return Effect.void;
      const atom = sessions.sessionStateAtom(environmentId);
      return Effect.scoped(
        Effect.gen(function* () {
          yield* AtomRegistry.mount(registry, atom);
          const session = yield* AtomRegistry.getResult(registry, atom, {
            suspendOnWaiting: false,
          }).pipe(
            Effect.timeoutOption(6_000),
            Effect.catch(() => Effect.succeed(Option.none<AuthSessionState>())),
          );
          const missing = scopes.find(
            (scope) => Option.isNone(session) || !grants(session.value, scope),
          );
          if (missing !== undefined)
            return yield* Effect.fail(
              new EnvironmentAuthorizationError({
                requiredScope: missing,
                message: `This connection requires ${missing}.`,
              }),
            );
        }),
      );
    });
  return { requiredScopes, permissionAtom, authorize };
}

const permissionsByRuntime = new WeakMap<
  object,
  Map<string, ReturnType<typeof makeCommandPermissions>>
>();

/** Reuse availability atoms and dispatch guards across commands on the same runtime. */
export function createCommandPermissions<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
  method: string,
) {
  let permissions = permissionsByRuntime.get(runtime);
  if (permissions === undefined) {
    permissions = new Map();
    permissionsByRuntime.set(runtime, permissions);
  }
  const existing = permissions.get(method);
  if (existing !== undefined) return existing;
  const created = makeCommandPermissions(runtime, method);
  permissions.set(method, created);
  return created;
}
