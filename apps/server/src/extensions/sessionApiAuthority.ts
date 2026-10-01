import {
  AuthAccessWriteScope,
  ExtensionOperationError,
  type AuthEnvironmentScope,
  type EnvironmentSessionPrincipalShape,
} from "@t3tools/contracts";
import type { HostApiRootAuthority } from "@t3tools/extension-runtime";
import * as DateTime from "effect/DateTime";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import type { AuthenticatedSession } from "../auth/EnvironmentAuth.ts";
import type { SessionStore } from "../auth/SessionStore.ts";

const denied = () =>
  new ExtensionOperationError({
    operation: "api.authorize",
    detail: "The authenticated extension caller is no longer authorized.",
  });

/**
 * Capture verified identity and attenuated scopes without retaining credential
 * material.
 *
 * `writeScope` is the domain scope that makes this root write-capable. When it
 * is omitted, legacy semantics apply: only a root whose required scope is the
 * administrative transport write scope is write-capable. When given, write
 * capability requires that gate scope to be in the captured ∩ live scope
 * intersection, and the same intersection feeds `revalidate`, so losing the
 * gate scope mid-request fails the re-check.
 */
export const makeSessionApiAuthority = Effect.fn("Extensions.makeSessionApiAuthority")(function* (
  session: AuthenticatedSession | EnvironmentSessionPrincipalShape,
  environmentId: string,
  requiredScope: AuthEnvironmentScope,
  sessions: Pick<SessionStore["Service"], "revalidate" | "isConnectionLive">,
  writeScope?: AuthEnvironmentScope,
  /**
   * Identity of the transport connection this root rides on (the ws
   * connection id). Providers that key records to the viewer's root
   * connection receive it as `HostApiInvocationMetadata.rootConnectionId`.
   * When set, every revalidation also requires that connection to still be
   * live — a captured root cannot mint after its connection was revoked.
   */
  connectionId?: string,
) {
  const captured = Object.freeze({
    sessionId: session.sessionId,
    subject: session.subject,
    method: session.method,
    scopes: Object.freeze([...session.scopes]),
    expiresAt: session.expiresAt,
  });
  const read = Effect.fn("Extensions.revalidateApiAuthority")(function* () {
    const current = yield* sessions
      .revalidate(captured.sessionId)
      .pipe(Effect.mapError(() => denied()));
    const now = yield* DateTime.now;
    if (
      current.subject !== captured.subject ||
      current.method !== captured.method ||
      !captured.scopes.includes(requiredScope) ||
      !current.scopes.includes(requiredScope) ||
      (captured.expiresAt !== undefined &&
        DateTime.toEpochMillis(captured.expiresAt) <= DateTime.toEpochMillis(now))
    )
      return yield* denied();
    // A revoked transport connection invalidates the root immediately —
    // `revokeConnection` sweeps existing records, and without this fence an
    // in-flight request could still mint new ones under the dead identity.
    if (connectionId !== undefined && !(yield* sessions.isConnectionLive(connectionId))) {
      return yield* denied();
    }
    return current;
  });
  const current = yield* read();
  const scopes = Object.freeze(captured.scopes.filter((scope) => current.scopes.includes(scope)));
  const principal = Object.freeze({
    kind: "environment-session" as const,
    id: captured.sessionId,
    environmentId,
    subject: captured.subject,
    scopes,
  });
  const clock = yield* Clock.Clock;
  const allowWrite =
    writeScope === undefined ? requiredScope === AuthAccessWriteScope : scopes.includes(writeScope);
  const authority: HostApiRootAuthority = {
    principal,
    allowWrite,
    ...(connectionId === undefined ? {} : { connectionId }),
    revalidate: () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const next = yield* read();
          if (!scopes.every((scope) => next.scopes.includes(scope))) return yield* denied();
        }).pipe(Effect.provideService(Clock.Clock, clock)),
      ),
  };
  return authority;
});
