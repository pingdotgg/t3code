import type { OrchestrationV2ShellSnapshot } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpClient } from "effect/unstable/http";

import type { PreparedConnection } from "../connection/model.ts";
import { environmentEndpointUrl } from "../environment/endpoint.ts";
import { ManagedRelayDpopSigner } from "../relay/managedRelay.ts";
import {
  executeEnvironmentHttpRequest,
  makeEnvironmentHttpApiClient,
  type RemoteEnvironmentRequestError,
} from "../rpc/http.ts";
import { buildEnvironmentAuthHeaders, withEnvironmentCredentials } from "./environmentHttpAuth.ts";

// Bounded so a pathologically slow endpoint cannot block the (cheaper) socket
// fallback for long. The cached shell renders while this runs.
const DEFAULT_SHELL_SNAPSHOT_TIMEOUT_MS = 6_000;

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
  readonly signer: Option.Option<ManagedRelayDpopSigner["Service"]>;
  readonly timeoutMs?: number;
}) {
  const requestUrl = environmentEndpointUrl(input.prepared.httpBaseUrl, "/api/orchestration/shell");
  const client = yield* makeEnvironmentHttpApiClient(input.prepared.httpBaseUrl);
  const headers = yield* buildEnvironmentAuthHeaders(
    input.prepared.httpAuthorization,
    "GET",
    requestUrl,
    input.signer,
  );
  return yield* executeEnvironmentHttpRequest(
    requestUrl,
    input.timeoutMs ?? DEFAULT_SHELL_SNAPSHOT_TIMEOUT_MS,
    withEnvironmentCredentials(
      input.prepared.httpAuthorization,
      client.orchestration.shellSnapshot({ headers }),
    ),
  );
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
    readonly load: (
      prepared: PreparedConnection,
    ) => Effect.Effect<Option.Option<OrchestrationV2ShellSnapshot>, RemoteEnvironmentRequestError>;
  }
>()("@t3tools/client-runtime/state/shellSnapshotHttp/ShellSnapshotLoader") {}

export const shellSnapshotLoaderLayer: Layer.Layer<
  ShellSnapshotLoader,
  never,
  HttpClient.HttpClient
> = Layer.effect(
  ShellSnapshotLoader,
  Effect.gen(function* () {
    const httpClient = yield* HttpClient.HttpClient;
    // Resolve the DPoP signer optionally: it is only needed for relay/DPoP
    // connections, so the loader must not hard-require it.
    const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
    return ShellSnapshotLoader.of({
      load: (prepared: PreparedConnection) =>
        fetchEnvironmentShellSnapshot({ prepared, signer }).pipe(
          Effect.map(Option.some<OrchestrationV2ShellSnapshot>),
          Effect.provideService(HttpClient.HttpClient, httpClient),
          Effect.catchCause((cause) =>
            Effect.logWarning(
              "Could not load the environment shell snapshot over HTTP; using the socket snapshot instead.",
            ).pipe(
              Effect.annotateLogs({ cause: Cause.pretty(cause) }),
              Effect.as(Option.none<OrchestrationV2ShellSnapshot>()),
            ),
          ),
        ),
    });
  }),
);
