import type {
  AuthAccessSnapshot,
  AuthAccessStreamEvent,
  AuthAccessStreamSnapshotEvent,
  AuthEnvironmentScope,
  AuthSessionId,
} from "@t3tools/contracts";
import { WS_METHODS } from "@t3tools/contracts";
import * as Stream from "effect/Stream";
import type { HttpClient } from "effect/unstable/http";
import { Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { subscribe } from "../rpc/client.ts";
export { EnvironmentNotConnectedError } from "./authHttp.ts";

import {
  createEnvironmentPairingCredential,
  fetchEnvironmentSessionState,
  revokeEnvironmentClientSession,
  revokeEnvironmentPairingLink,
  revokeOtherEnvironmentClientSessions,
} from "./authHttp.ts";
import {
  createEnvironmentCommand,
  createEnvironmentQueryAtomFamily,
  createEnvironmentSubscriptionAtomFamily,
} from "./runtime.ts";

export const EMPTY_AUTH_ACCESS_SNAPSHOT: AuthAccessSnapshot = {
  pairingLinks: [],
  clientSessions: [],
};

function upsertByKey<A>(
  values: ReadonlyArray<A>,
  next: A,
  key: (value: A) => string,
): ReadonlyArray<A> {
  const nextKey = key(next);
  return [...values.filter((value) => key(value) !== nextKey), next];
}

export function applyAuthAccessStreamEvent(
  current: AuthAccessSnapshot,
  event: AuthAccessStreamEvent,
): AuthAccessSnapshot {
  switch (event.type) {
    case "snapshot":
      return event.payload;
    case "pairingLinkUpserted":
      return {
        ...current,
        pairingLinks: upsertByKey(current.pairingLinks, event.payload, (value) => value.id),
      };
    case "pairingLinkRemoved":
      return {
        ...current,
        pairingLinks: current.pairingLinks.filter((value) => value.id !== event.payload.id),
      };
    case "clientUpserted":
      return {
        ...current,
        clientSessions: upsertByKey(
          current.clientSessions,
          event.payload,
          (value) => value.sessionId,
        ),
      };
    case "clientRemoved":
      return {
        ...current,
        clientSessions: current.clientSessions.filter(
          (value) => value.sessionId !== event.payload.sessionId,
        ),
      };
  }
}

export function projectAuthAccessSnapshot(
  current: AuthAccessSnapshot,
  event: AuthAccessStreamEvent,
): readonly [AuthAccessSnapshot, ReadonlyArray<AuthAccessStreamEvent>] {
  const snapshot = applyAuthAccessStreamEvent(current, event);
  const projected: AuthAccessStreamSnapshotEvent = {
    version: 1,
    revision: event.revision,
    type: "snapshot",
    payload: snapshot,
  };
  return [snapshot, [projected]];
}

export function createAuthEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | HttpClient.HttpClient | R, E>,
) {
  return {
    accessChanges: createEnvironmentSubscriptionAtomFamily(runtime, {
      label: "environment-data:server:auth-access-changes",
      subscribe: (_input: null) =>
        subscribe(WS_METHODS.subscribeAuthAccess, {}).pipe(
          Stream.mapAccum(() => EMPTY_AUTH_ACCESS_SNAPSHOT, projectAuthAccessSnapshot),
        ),
    }),
    sessionState: createEnvironmentQueryAtomFamily(runtime, {
      label: "environment-data:server:auth-session-state",
      execute: (_input: null) => fetchEnvironmentSessionState(),
    }),
    // Access mutations address the environment they run in rather than the
    // primary, so a client with no managed backend can still administer a saved
    // server it holds an `access:write` credential for.
    createPairingCredential: createEnvironmentCommand(runtime, {
      label: "environment-command:server:create-pairing-credential",
      execute: (input: {
        readonly label?: string;
        readonly scopes?: ReadonlyArray<AuthEnvironmentScope>;
      }) => createEnvironmentPairingCredential(input),
    }),
    revokePairingLink: createEnvironmentCommand(runtime, {
      label: "environment-command:server:revoke-pairing-link",
      execute: (input: { readonly id: string }) => revokeEnvironmentPairingLink(input),
    }),
    revokeClientSession: createEnvironmentCommand(runtime, {
      label: "environment-command:server:revoke-client-session",
      execute: (input: { readonly sessionId: AuthSessionId }) =>
        revokeEnvironmentClientSession(input),
    }),
    revokeOtherClientSessions: createEnvironmentCommand(runtime, {
      label: "environment-command:server:revoke-other-client-sessions",
      execute: (_input: null) => revokeOtherEnvironmentClientSessions(),
    }),
  };
}
