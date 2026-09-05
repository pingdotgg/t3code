import type { OrchestrationThreadDetailSnapshot, ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpClient } from "effect/unstable/http";

import { RemoteEnvironmentAuthorization } from "../authorization/service.ts";
import type { PreparedConnection } from "../connection/model.ts";
import { environmentEndpointUrl } from "../environment/endpoint.ts";
import { ManagedRelayDpopSigner } from "../relay/managedRelay.ts";
import type { RemoteEnvironmentRequestError } from "../rpc/http.ts";
import { executeAuthenticatedEnvironmentHttpRequest } from "./environmentHttpAuth.ts";

// Bounded so a pathologically slow endpoint cannot block the (cheaper) socket
// fallback for long. The cached thread renders while this runs, so the wait only
// delays the transition to live data on the first open, not the initial paint.
const DEFAULT_THREAD_SNAPSHOT_TIMEOUT_MS = 6_000;

/**
 * Load a thread's detail snapshot over HTTP instead of embedding it in the
 * WebSocket subscription's first frame. The response is gzip-compressible by
 * the transport and keeps the (potentially multi-KB) snapshot off the socket.
 */
/**
 * Optional turn window for a snapshot fetch. Only send a window to servers
 * that advertise `threadSnapshotPagination`; older servers reject unknown
 * query parameters.
 */
export interface ThreadSnapshotWindow {
  readonly turnLimit: number;
  readonly beforeCursor?: string;
}

export const fetchEnvironmentThreadSnapshot = Effect.fn(
  "clientRuntime.state.fetchEnvironmentThreadSnapshot",
)(function* (input: {
  readonly prepared: PreparedConnection;
  readonly threadId: ThreadId;
  readonly signer: Option.Option<ManagedRelayDpopSigner["Service"]>;
  readonly remoteAuthorization?: Option.Option<RemoteEnvironmentAuthorization["Service"]>;
  readonly timeoutMs?: number;
  readonly window?: ThreadSnapshotWindow;
}) {
  return yield* executeAuthenticatedEnvironmentHttpRequest({
    ...input,
    method: "GET",
    url: (httpBaseUrl) =>
      environmentEndpointUrl(httpBaseUrl, `/api/orchestration/threads/${input.threadId}`),
    timeoutMs: input.timeoutMs ?? DEFAULT_THREAD_SNAPSHOT_TIMEOUT_MS,
    request: ({ client, headers }) =>
      client.orchestration.threadSnapshot({
        params: { threadId: input.threadId },
        payload: {
          ...(input.window !== undefined ? { turnLimit: input.window.turnLimit } : {}),
          ...(input.window?.beforeCursor !== undefined
            ? { beforeCursor: input.window.beforeCursor }
            : {}),
        },
        headers,
      }),
  });
});

export type FetchEnvironmentThreadSnapshotError = RemoteEnvironmentRequestError;

/**
 * Loads a thread's detail snapshot over HTTP, returning `Option.none()` when it
 * cannot be loaded (so the caller falls back to the socket-embedded snapshot).
 * Decouples the thread state machine from the underlying HTTP + DPoP details and
 * keeps them out of test contexts.
 */
export class ThreadSnapshotLoader extends Context.Service<
  ThreadSnapshotLoader,
  {
    readonly load: (
      prepared: PreparedConnection,
      threadId: ThreadId,
      window?: ThreadSnapshotWindow,
    ) => Effect.Effect<Option.Option<OrchestrationThreadDetailSnapshot>>;
  }
>()("@t3tools/client-runtime/state/threadSnapshotHttp/ThreadSnapshotLoader") {}

export const threadSnapshotLoaderLayer: Layer.Layer<
  ThreadSnapshotLoader,
  never,
  HttpClient.HttpClient
> = Layer.effect(
  ThreadSnapshotLoader,
  Effect.gen(function* () {
    const httpClient = yield* HttpClient.HttpClient;
    // Resolve the DPoP signer optionally: it is only needed for relay/DPoP
    // connections, so the loader must not hard-require it (bearer/primary
    // connections work without one).
    const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
    const remoteAuthorization = yield* Effect.serviceOption(RemoteEnvironmentAuthorization);
    return ThreadSnapshotLoader.of({
      load: (prepared: PreparedConnection, threadId: ThreadId, window?: ThreadSnapshotWindow) =>
        fetchEnvironmentThreadSnapshot({
          prepared,
          threadId,
          signer,
          remoteAuthorization,
          ...(window !== undefined ? { window } : {}),
        }).pipe(
          Effect.map(Option.some<OrchestrationThreadDetailSnapshot>),
          Effect.provideService(HttpClient.HttpClient, httpClient),
          // A genuinely missing thread (404) is expected — the socket
          // subscription is the source of truth for thread existence and will
          // surface the deletion — so don't treat it as an error worth warning
          // about; just defer to the socket path.
          Effect.catchTags({
            EnvironmentResourceNotFoundError: () =>
              Effect.logDebug(
                "Thread snapshot not found over HTTP; deferring to the socket subscription.",
              ).pipe(
                Effect.annotateLogs({ threadId }),
                Effect.as(Option.none<OrchestrationThreadDetailSnapshot>()),
              ),
          }),
          Effect.catchCause((cause) =>
            Effect.logWarning(
              "Could not load the thread snapshot over HTTP; using the socket snapshot instead.",
            ).pipe(
              Effect.annotateLogs({ threadId, cause: Cause.pretty(cause) }),
              Effect.as(Option.none<OrchestrationThreadDetailSnapshot>()),
            ),
          ),
        ),
    });
  }),
);
