import { WS_METHODS, type CanvasImportUploadInput, type EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import type { HttpClient } from "effect/http";
import { Atom, type AtomRegistry } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import * as RemoteEnvironmentAuthorization from "../authorization/service.ts";
import * as ManagedRelay from "../relay/managedRelay.ts";
import { RemoteEnvironmentAuthFetchError } from "../rpc/http.ts";
import { executeAuthenticatedEnvironmentHttpRequest } from "./environmentHttpAuth.ts";
import { createCommandPermissions } from "./commandPermissions.ts";
import {
  createAtomCommandScheduler,
  createEnvironmentCommand,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "./runtime.ts";

export function createCanvasEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | HttpClient.HttpClient | R, E>,
) {
  const scheduler = createAtomCommandScheduler();
  const hostScheduler = createAtomCommandScheduler();
  const importPermissions = createCommandPermissions(runtime, WS_METHODS.canvasCreate);
  // Batches for one document apply in send order.
  const perDocument = {
    mode: "serial" as const,
    key: ({ environmentId, input }: { environmentId: string; input: { documentId: string } }) =>
      JSON.stringify([environmentId, input.documentId]),
  };
  return {
    list: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:canvas:list",
      tag: WS_METHODS.canvasList,
      staleTimeMs: 5_000,
    }),
    create: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:canvas:create",
      tag: WS_METHODS.canvasCreate,
    }),
    importFile: {
      ...createEnvironmentCommand(runtime, {
        label: "environment-data:canvas:import",
        execute: Effect.fn("canvas.importFile")(function* (
          input: {
            metadata: CanvasImportUploadInput;
            bytes: Uint8Array;
            encoding?: "gzip";
          },
          registry: AtomRegistry.AtomRegistry,
          environmentId: EnvironmentId,
        ) {
          yield* importPermissions.authorize(registry, environmentId);
          const supervisor = yield* EnvironmentSupervisor.EnvironmentSupervisor;
          const prepared = yield* SubscriptionRef.get(supervisor.prepared);
          if (Option.isNone(prepared)) {
            return yield* new RemoteEnvironmentAuthFetchError({
              message: "The environment is not connected.",
              cause: "unavailable",
            });
          }
          const signer = yield* Effect.serviceOption(ManagedRelay.ManagedRelayDpopSigner);
          const remoteAuthorization = yield* Effect.serviceOption(
            RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization,
          );
          return yield* executeAuthenticatedEnvironmentHttpRequest({
            prepared: prepared.value,
            signer,
            remoteAuthorization,
            group: "canvas",
            method: "POST",
            url: (urls) => urls.import({ query: input.metadata }),
            timeoutMs: 5 * 60_000,
            request: ({ client, headers }) =>
              client.import({
                query: input.metadata,
                payload: input.bytes,
                headers: {
                  ...headers,
                  ...(input.encoding ? { "content-encoding": input.encoding } : {}),
                },
              }),
          });
        }),
      }),
      permissionAtom: importPermissions.permissionAtom,
      requiredScopes: importPermissions.requiredScopes,
    },
    delete: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:canvas:delete",
      tag: WS_METHODS.canvasDelete,
      scheduler,
      concurrency: perDocument,
    }),
    applyOps: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:canvas:apply-ops",
      tag: WS_METHODS.canvasApplyOps,
      scheduler,
      concurrency: perDocument,
    }),
    updateHost: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:canvas:update-host",
      tag: WS_METHODS.canvasUpdateHost,
      scheduler: hostScheduler,
      concurrency: {
        // Open waits for its mounted-document report; a background report must not cancel it.
        mode: "serial",
        key: ({ environmentId, input }) => JSON.stringify([environmentId, input.clientId]),
      },
    }),
    respondToHostRequest: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:canvas:respond-host",
      tag: WS_METHODS.canvasRespondHost,
      scheduler: hostScheduler,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) =>
          JSON.stringify([environmentId, input.connectionId, input.requestId]),
      },
    }),
  };
}
