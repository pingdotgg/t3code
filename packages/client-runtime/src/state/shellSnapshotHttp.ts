import type { OrchestrationV2ShellSnapshot } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpClient } from "effect/unstable/http";

import * as RemoteEnvironmentAuthorization from "../authorization/service.ts";
import type { PreparedConnection } from "../connection/model.ts";
import { environmentEndpointUrl } from "../environment/endpoint.ts";
import * as ManagedRelay from "../relay/managedRelay.ts";
import {
  executeAuthenticatedEnvironmentHttpRequest,
  withOrchestrationProtocolHeader,
} from "./environmentHttpAuth.ts";

// Long enough for a slow but alive server to finish. On timeout the socket asks
// the same server for the same full snapshot, so a short deadline only throws
// the first build away. The socket fallback is for setups where /api fails but
// /ws works, such as a proxy that blocks /api. A dead server is caught by the
// socket ping, which drops the session and interrupts this load. The cached
// shell renders while this runs.
const DEFAULT_SHELL_SNAPSHOT_TIMEOUT_MS = 20_000;

/**
 * Load the environment shell snapshot (projects + thread shells) over HTTP
 * instead of as the WebSocket subscription's first frame. The response is
 * gzip-compressible by the transport and keeps the (potentially large) list off
 * the socket.
 */
export const fetchEnvironmentShellSnapshot = Effect.fn(
  "clientRuntime.state.fetchEnvironmentShellSnapshot",
)(function* (input: {
  readonly prepared: PreparedConnection;
  readonly signer: Option.Option<ManagedRelay.ManagedRelayDpopSigner["Service"]>;
  readonly remoteAuthorization?: Option.Option<
    RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization["Service"]
  >;
  readonly timeoutMs?: number;
}) {
  return yield* executeAuthenticatedEnvironmentHttpRequest({
    ...input,
    group: "orchestration",
    method: "GET",
    url: (httpBaseUrl) => environmentEndpointUrl(httpBaseUrl, "/api/orchestration/shell"),
    timeoutMs: input.timeoutMs ?? DEFAULT_SHELL_SNAPSHOT_TIMEOUT_MS,
    request: ({ client, headers }) =>
      client.shellSnapshot({ headers: withOrchestrationProtocolHeader(headers) }),
  });
});

/**
 * Loads the environment shell snapshot over HTTP, returning `Option.none()` when
 * it cannot be loaded (so the caller falls back to the socket-embedded snapshot).
 * Decouples the shell state machine from the underlying HTTP + DPoP details and
 * keeps them out of test contexts.
 */
export class ShellSnapshotLoader extends Context.Service<
  ShellSnapshotLoader,
  {
    /** `onResponse` runs once the server answers, before the body is decoded. */
    readonly load: (
      prepared: PreparedConnection,
      options?: { readonly onResponse?: Effect.Effect<void> },
    ) => Effect.Effect<Option.Option<OrchestrationV2ShellSnapshot>>;
  }
>()("@t3tools/client-runtime/state/shellSnapshotHttp/ShellSnapshotLoader") {}

export const layer: Layer.Layer<ShellSnapshotLoader, never, HttpClient.HttpClient> = Layer.effect(
  ShellSnapshotLoader,
  Effect.gen(function* () {
    const httpClient = yield* HttpClient.HttpClient;
    // Resolve the DPoP signer optionally: it is only needed for relay/DPoP
    // connections, so the loader must not hard-require it.
    const signer = yield* Effect.serviceOption(ManagedRelay.ManagedRelayDpopSigner);
    const remoteAuthorization = yield* Effect.serviceOption(
      RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization,
    );
    return ShellSnapshotLoader.of({
      load: (prepared, options) => {
        const onResponse = options?.onResponse;
        // A rejected credential is retried, so only a success means decoding starts.
        const client =
          onResponse === undefined
            ? httpClient
            : HttpClient.tap(httpClient, (response) =>
                response.status < 400 ? onResponse : Effect.void,
              );
        return fetchEnvironmentShellSnapshot({ prepared, signer, remoteAuthorization }).pipe(
          Effect.map(Option.some<OrchestrationV2ShellSnapshot>),
          Effect.provideService(HttpClient.HttpClient, client),
          Effect.catchCause((cause) =>
            Effect.logWarning(
              "Could not load the environment shell snapshot over HTTP; using the socket snapshot instead.",
            ).pipe(
              Effect.annotateLogs({ cause: Cause.pretty(cause) }),
              Effect.as(Option.none<OrchestrationV2ShellSnapshot>()),
            ),
          ),
        );
      },
    });
  }),
);
