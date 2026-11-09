import type {
  AuthAccessSnapshot,
  AuthAccessStreamEvent,
  AuthAccessStreamSnapshotEvent,
  AuthCreatePairingCredentialInput,
  AuthRevokeClientSessionInput,
  AuthRevokePairingLinkInput,
} from "@t3tools/contracts";
import { WS_METHODS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type { HttpClient } from "effect/http";
import * as Stream from "effect/Stream";
import { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { subscribe } from "../rpc/client.ts";
import { executeConnectedEnvironmentHttpRequest } from "./environmentHttpAuth.ts";
import { createEnvironmentCommand, createEnvironmentSubscriptionAtomFamily } from "./runtime.ts";

const ACCESS_REQUEST_TIMEOUT_MS = 8_000;

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

function projectAuthAccessSnapshot(
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

/** Access management runs on the chosen environment with this client's own session there. */
export function createAuthEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | HttpClient.HttpClient | R, E>,
) {
  return {
    createPairingCredential: createEnvironmentCommand(runtime, {
      label: "environment-data:server:auth-create-pairing-credential",
      execute: (input: AuthCreatePairingCredentialInput) =>
        executeConnectedEnvironmentHttpRequest({
          group: "auth",
          method: "POST",
          url: (urls) => urls.pairingCredential(),
          timeoutMs: ACCESS_REQUEST_TIMEOUT_MS,
          request: ({ client, headers }) => client.pairingCredential({ headers, payload: input }),
        }),
    }),
    revokePairingLink: createEnvironmentCommand(runtime, {
      label: "environment-data:server:auth-revoke-pairing-link",
      execute: (input: AuthRevokePairingLinkInput) =>
        executeConnectedEnvironmentHttpRequest({
          group: "auth",
          method: "POST",
          url: (urls) => urls.revokePairingLink(),
          timeoutMs: ACCESS_REQUEST_TIMEOUT_MS,
          request: ({ client, headers }) => client.revokePairingLink({ headers, payload: input }),
        }),
    }),
    revokeClient: createEnvironmentCommand(runtime, {
      label: "environment-data:server:auth-revoke-client",
      execute: (input: AuthRevokeClientSessionInput) =>
        executeConnectedEnvironmentHttpRequest({
          group: "auth",
          method: "POST",
          url: (urls) => urls.revokeClient(),
          timeoutMs: ACCESS_REQUEST_TIMEOUT_MS,
          request: ({ client, headers }) => client.revokeClient({ headers, payload: input }),
        }),
    }),
    revokeOtherClients: createEnvironmentCommand(runtime, {
      label: "environment-data:server:auth-revoke-other-clients",
      execute: (_input: null) =>
        executeConnectedEnvironmentHttpRequest({
          group: "auth",
          method: "POST",
          url: (urls) => urls.revokeOtherClients(),
          timeoutMs: ACCESS_REQUEST_TIMEOUT_MS,
          request: ({ client, headers }) => client.revokeOtherClients({ headers }),
        }).pipe(Effect.map((result) => result.revokedCount)),
    }),
    accessChanges: createEnvironmentSubscriptionAtomFamily(runtime, {
      label: "environment-data:server:auth-access-changes",
      subscribe: (_input: null) =>
        subscribe(WS_METHODS.subscribeAuthAccess, {}).pipe(
          Stream.mapAccum(() => EMPTY_AUTH_ACCESS_SNAPSHOT, projectAuthAccessSnapshot),
        ),
    }),
  };
}
