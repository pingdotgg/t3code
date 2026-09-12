import type { CreateShareInput, EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import type { HttpClient } from "effect/unstable/http";
import type { Atom, AtomRegistry } from "effect/unstable/reactivity";

import { RemoteEnvironmentAuthorization } from "../authorization/service.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import { environmentEndpointUrl } from "../environment/endpoint.ts";
import { ManagedRelayDpopSigner } from "../relay/managedRelay.ts";
import { EnvironmentRpcUnavailableError } from "../rpc/client.ts";
import { executeAuthenticatedEnvironmentHttpRequest } from "./environmentHttpAuth.ts";
import { createEnvironmentCommand, createEnvironmentQueryAtomFamily } from "./runtime.ts";

const shareConnection = Effect.gen(function* () {
  const supervisor = yield* EnvironmentSupervisor;
  const prepared = yield* SubscriptionRef.get(supervisor.prepared);
  if (Option.isNone(prepared)) {
    return yield* new EnvironmentRpcUnavailableError({
      environmentId: supervisor.target.environmentId,
      message: "Connect to this environment to manage shared chats.",
    });
  }
  const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
  const remoteAuthorization = yield* Effect.serviceOption(RemoteEnvironmentAuthorization);
  return { prepared: prepared.value, signer, remoteAuthorization };
});

export function createShareEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | HttpClient.HttpClient | R, E>,
) {
  const list = createEnvironmentQueryAtomFamily(runtime, {
    label: "environment-data:shares:list",
    staleTimeMs: 5_000,
    execute: Effect.fn("clientRuntime.shares.list")(function* (input: { threadId: ThreadId }) {
      const connection = yield* shareConnection;
      let baseUrl = connection.prepared.httpBaseUrl;
      const shares = yield* executeAuthenticatedEnvironmentHttpRequest({
        ...connection,
        group: "shares",
        method: "GET",
        timeoutMs: 10_000,
        url: (httpBaseUrl) => {
          baseUrl = httpBaseUrl;
          return environmentEndpointUrl(httpBaseUrl, `/api/shares/thread/${input.threadId}`);
        },
        request: ({ client, headers }) => client.list({ params: input, headers }),
      });
      return shares.map((share) => ({
        ...share,
        url: environmentEndpointUrl(baseUrl, `/share/${share.code}`),
      }));
    }),
  });

  const create = createEnvironmentCommand(runtime, {
    label: "environment-data:shares:create",
    execute: Effect.fn("clientRuntime.shares.create")(function* (
      input: CreateShareInput,
      registry: AtomRegistry.AtomRegistry,
      environmentId: EnvironmentId,
    ) {
      const connection = yield* shareConnection;
      let baseUrl = connection.prepared.httpBaseUrl;
      const share = yield* executeAuthenticatedEnvironmentHttpRequest({
        ...connection,
        group: "shares",
        method: "POST",
        timeoutMs: 30_000,
        url: (httpBaseUrl) => {
          baseUrl = httpBaseUrl;
          return environmentEndpointUrl(httpBaseUrl, "/api/shares");
        },
        request: ({ client, headers }) => client.create({ payload: input, headers }),
      });
      registry.refresh(list({ environmentId, input: { threadId: input.threadId } }));
      return { ...share, url: environmentEndpointUrl(baseUrl, `/share/${share.code}`) };
    }),
  });

  const revoke = createEnvironmentCommand(runtime, {
    label: "environment-data:shares:revoke",
    execute: Effect.fn("clientRuntime.shares.revoke")(function* (
      input: { code: string; threadId: ThreadId },
      registry: AtomRegistry.AtomRegistry,
      environmentId: EnvironmentId,
    ) {
      const connection = yield* shareConnection;
      const result = yield* executeAuthenticatedEnvironmentHttpRequest({
        ...connection,
        group: "shares",
        method: "DELETE",
        timeoutMs: 10_000,
        url: (httpBaseUrl) => environmentEndpointUrl(httpBaseUrl, `/api/shares/${input.code}`),
        request: ({ client, headers }) => client.revoke({ params: { code: input.code }, headers }),
      });
      registry.refresh(list({ environmentId, input: { threadId: input.threadId } }));
      return result;
    }),
  });

  return { create, list, revoke };
}
