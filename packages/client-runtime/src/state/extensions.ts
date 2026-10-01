import { PULL_REQUEST_HANDOFF_DEADLINE_MS, WS_METHODS } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";
import { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcSubscriptionAtomFamily } from "./runtime.ts";
import type {
  ClientProvidersConnectInput,
  ClientProvidersEmitInput,
  ClientProvidersRespondInput,
  ExtensionClientInput,
  ExtensionAssetInput,
  ExtensionApiSubscribeInput,
  EnvironmentId,
  ExtensionApiInvokeInput,
  ExtensionApiDiscoverInput,
  ExtensionApiSelection,
  ExtensionInstallInput,
  ExtensionInvokeInput,
  ExtensionManageInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import {
  request as rpcRequest,
  runStream,
  subscribeDynamicUntilCompleteWithSuspensions,
} from "../rpc/client.ts";
import { RemoteEnvironmentAuthorization } from "../authorization/service.ts";
import type { PreparedConnection } from "../connection/model.ts";
import { environmentEndpointUrl } from "../environment/endpoint.ts";
import { ManagedRelayDpopSigner } from "../relay/managedRelay.ts";
import { makeEnvironmentHttpApiGroupClient } from "../rpc/http.ts";
import {
  executeAuthenticatedEnvironmentHttpRequest,
  type EnvironmentHttpAuthHeaders,
} from "./environmentHttpAuth.ts";

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Long-running API methods. Each HTTP deadline exceeds the server broker's
 * deadline for that method, so the broker's answer (or its deadline error)
 * always reaches the caller. Cookie import: 5-minute host wait plus 30 seconds
 * of post-checks on the server.
 */
const API_INVOKE_TIMEOUT_MS: Readonly<Record<string, number>> = {
  "t3.browser/profiles#importCookies": 6 * 60_000,
  "t3.vcs/actions#handoffPullRequest": PULL_REQUEST_HANDOFF_DEADLINE_MS + 30_000,
};

function request<A, E, R>(
  prepared: PreparedConnection,
  operation: string,
  execute: (
    client: Effect.Success<ReturnType<typeof makeEnvironmentHttpApiGroupClient<"extensions">>>,
    headers: EnvironmentHttpAuthHeaders,
  ) => Effect.Effect<A, E, R>,
  timeoutMs = DEFAULT_TIMEOUT_MS,
) {
  return Effect.gen(function* () {
    const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
    const remoteAuthorization = yield* Effect.serviceOption(RemoteEnvironmentAuthorization);
    return yield* executeAuthenticatedEnvironmentHttpRequest({
      prepared,
      signer,
      remoteAuthorization,
      method: "POST",
      url: (base) => environmentEndpointUrl(base, "/api/extensions/" + operation),
      timeoutMs,
      group: "extensions",
      request: ({ client, headers }) => execute(client, headers),
    });
  });
}

/** Uses the same cookie, bearer and refreshed request-bound relay authorization as other environment HTTP requests. */
export const environmentExtensionsHttp = {
  invokeApi: (prepared: PreparedConnection, payload: ExtensionApiInvokeInput) =>
    request(
      prepared,
      "api/invoke",
      (client, headers) => client.invokeApi({ payload, headers }),
      API_INVOKE_TIMEOUT_MS[`${payload.request.id}#${payload.request.method}`],
    ),
  discoverApis: (prepared: PreparedConnection, payload: ExtensionApiDiscoverInput) =>
    request(prepared, "api/discover", (client, headers) =>
      client.discoverApis({ payload, headers }),
    ),
  selectApi: (prepared: PreparedConnection, payload: ExtensionApiSelection) =>
    request(prepared, "api/select", (client, headers) => client.selectApi({ payload, headers })),

  list: (prepared: PreparedConnection) =>
    request(prepared, "list", (client, headers) => client.list({ payload: {}, headers })),
  asset: (prepared: PreparedConnection, payload: ExtensionAssetInput) =>
    request(prepared, "asset", (client, headers) => client.asset({ payload, headers })).pipe(
      Effect.map((response) => response.body),
    ),
  client: (prepared: PreparedConnection, payload: ExtensionClientInput) =>
    request(prepared, "client", (client, headers) => client.client({ payload, headers })),
  invoke: (prepared: PreparedConnection, payload: ExtensionInvokeInput) =>
    request(prepared, "invoke", (client, headers) => client.invoke({ payload, headers })),
  install: (prepared: PreparedConnection, payload: ExtensionInstallInput) =>
    request(prepared, "install", (client, headers) => client.install({ payload, headers })),
  manage: (prepared: PreparedConnection, payload: ExtensionManageInput) =>
    request(prepared, "manage", (client, headers) => client.manage({ payload, headers })),
};

/** Initial receipts replay on each authenticated session, including reconnection. No timer or retries. */
export function createExtensionCatalogueAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return createEnvironmentRpcSubscriptionAtomFamily(runtime, {
    label: "environment-data:extensions:catalogue",
    tag: WS_METHODS.subscribeExtensionCatalogue,
    idleTtlMs: 0,
  });
}

/** One authenticated connection lifetime. Reconnect requires explicit rediscovery and a new cursor. */
export function environmentExtensionApiStream(
  environmentId: EnvironmentId,
  payload: ExtensionApiSubscribeInput,
) {
  return Stream.unwrap(
    Effect.gen(function* () {
      const registry = yield* EnvironmentRegistry;
      return registry.runStream(
        environmentId,
        runStream(WS_METHODS.subscribeExtensionApi, payload, { streamBufferSize: 1 }),
      );
    }),
  );
}

/**
 * `ClientHost.resumableStreams` transport: follows the environment's transport
 * sessions like native durable subscriptions. Each session opens one fresh
 * subscription with a payload built for it, and a transport failure waits
 * for the next session, emitting `Option.none()` in order with the frames
 * when it starts waiting. `makePayload` only sees state the caller holds,
 * not which session is opening, so it must not carry session-bound hints.
 * The source's own completion or domain failure ends the stream. It follows
 * the registry entry too, so a same-ID re-registration moves it to the
 * replacement supervisor instead of leaving it on the retired one.
 */
export function environmentResumableExtensionApiStream(
  environmentId: EnvironmentId,
  makePayload: () => ExtensionApiSubscribeInput,
) {
  return Stream.unwrap(
    Effect.gen(function* () {
      const registry = yield* EnvironmentRegistry;
      // followStream never completes on its own, so the source's completion
      // is carried out as a final `none` that ends the outer stream.
      return registry
        .followStream(
          environmentId,
          subscribeDynamicUntilCompleteWithSuspensions(
            WS_METHODS.subscribeExtensionApi,
            () => Effect.sync(makePayload),
            { streamBufferSize: 1 },
          ).pipe(Stream.map(Option.some), Stream.concat(Stream.succeed(Option.none()))),
        )
        .pipe(
          Stream.takeWhile(Option.isSome),
          Stream.map((frame) => frame.value),
        );
    }),
  );
}

/**
 * The `t3.client/*` connect stream — one per connection lifetime. The server
 * mints the socket-bound `connectionId` in the first `registered` frame;
 * subsequent frames carry `invoke`/`cancel`/`subscriptionOpen`/`subscriptionClose`.
 */
export function environmentClientProvidersStream(
  environmentId: EnvironmentId,
  payload: ClientProvidersConnectInput,
) {
  return Stream.unwrap(
    Effect.gen(function* () {
      const registry = yield* EnvironmentRegistry;
      return registry.runStream(
        environmentId,
        runStream(WS_METHODS.extensionsClientProvidersConnect, payload, {
          streamBufferSize: 8,
        }),
      );
    }),
  );
}

/** Unary client-provider response for a server `invoke` frame, same session. */
export function environmentClientProviderRespond(
  environmentId: EnvironmentId,
  payload: ClientProvidersRespondInput,
) {
  return Effect.gen(function* () {
    const registry = yield* EnvironmentRegistry;
    return yield* registry.run(
      environmentId,
      rpcRequest(WS_METHODS.extensionsClientProvidersRespond, payload),
    );
  });
}

/** Client→server event on a server-known correlation (subscription or notification id). */
export function environmentClientProviderEmit(
  environmentId: EnvironmentId,
  payload: ClientProvidersEmitInput,
) {
  return Effect.gen(function* () {
    const registry = yield* EnvironmentRegistry;
    return yield* registry.run(
      environmentId,
      rpcRequest(WS_METHODS.extensionsClientProvidersEmit, payload),
    );
  });
}

/** Emits once per connection-state change; callers filter for the phase they need. */
export function environmentConnectionStateChanges(environmentId: EnvironmentId) {
  return Stream.unwrap(
    Effect.gen(function* () {
      const registry = yield* EnvironmentRegistry;
      return registry.stateChanges(environmentId);
    }),
  );
}
