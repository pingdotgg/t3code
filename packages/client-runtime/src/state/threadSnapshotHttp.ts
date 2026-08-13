import type { OrchestrationV2ThreadDetailSnapshot, ThreadId } from "@t3tools/contracts";
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
// fallback for long. The cached thread renders while this runs, so the wait only
// delays the transition to live data on the first open, not the initial paint.
const DEFAULT_THREAD_SNAPSHOT_TIMEOUT_MS = 6_000;

/** Progressive history metadata returned by a bounded snapshot loader. */
export type ThreadSnapshotHistoryMeta = {
  readonly historyCursor: string | null;
  readonly hasMoreHistory: boolean;
  /** Max local turn ordinal from the full projection; optional on older servers. */
  readonly latestLocalTurnOrdinal?: number | null;
};

/**
 * Outcome of an HTTP thread-detail snapshot load.
 *
 * - `present`: snapshot body is available (seed projection, resume via socket).
 * - `missing`: server definitively reported the thread does not exist (404).
 * - `unavailable`: transport/timeout/5xx/etc.; fall back to the socket path.
 */
export type ThreadSnapshotLoadResult =
  | {
      readonly _tag: "present";
      readonly snapshot: OrchestrationV2ThreadDetailSnapshot;
      readonly history?: ThreadSnapshotHistoryMeta;
    }
  | { readonly _tag: "missing" }
  | { readonly _tag: "unavailable" };

/**
 * Load a thread's detail snapshot over HTTP instead of embedding it in the
 * WebSocket subscription's first frame. The response is gzip-compressible by
 * the transport and keeps the (potentially multi-KB) snapshot off the socket.
 */
export const fetchEnvironmentThreadSnapshot = Effect.fn(
  "clientRuntime.state.fetchEnvironmentThreadSnapshot",
)(function* (input: {
  readonly prepared: PreparedConnection;
  readonly threadId: ThreadId;
  readonly signer: Option.Option<ManagedRelayDpopSigner["Service"]>;
  readonly timeoutMs?: number;
}) {
  const requestUrl = environmentEndpointUrl(
    input.prepared.httpBaseUrl,
    `/api/orchestration/threads/${input.threadId}`,
  );
  const client = yield* makeEnvironmentHttpApiClient(input.prepared.httpBaseUrl);
  const headers = yield* buildEnvironmentAuthHeaders(
    input.prepared.httpAuthorization,
    "GET",
    requestUrl,
    input.signer,
  );
  return yield* executeEnvironmentHttpRequest(
    requestUrl,
    input.timeoutMs ?? DEFAULT_THREAD_SNAPSHOT_TIMEOUT_MS,
    withEnvironmentCredentials(
      input.prepared.httpAuthorization,
      client.orchestration.threadSnapshot({
        params: { threadId: input.threadId },
        headers,
      }),
    ),
  );
});

export type FetchEnvironmentThreadSnapshotError = RemoteEnvironmentRequestError;

/**
 * Loads a thread's detail snapshot over HTTP.
 *
 * Distinguishes a definitive missing thread (HTTP 404) from transient snapshot
 * unavailability so the thread state machine can mark the thread deleted without
 * opening a socket subscription, while still falling back to the socket when the
 * HTTP path is merely unavailable.
 */
export class ThreadSnapshotLoader extends Context.Service<
  ThreadSnapshotLoader,
  {
    readonly load: (
      prepared: PreparedConnection,
      threadId: ThreadId,
    ) => Effect.Effect<ThreadSnapshotLoadResult>;
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
    return ThreadSnapshotLoader.of({
      load: (prepared: PreparedConnection, threadId: ThreadId) =>
        fetchEnvironmentThreadSnapshot({ prepared, threadId, signer }).pipe(
          Effect.map(
            (snapshot): ThreadSnapshotLoadResult => ({
              _tag: "present",
              snapshot,
            }),
          ),
          Effect.provideService(HttpClient.HttpClient, httpClient),
          // A genuinely missing thread (404) is definitive: do not fall back to
          // the socket or retry. Callers mark the thread deleted and clear cache.
          Effect.catchTags({
            EnvironmentResourceNotFoundError: () =>
              Effect.logDebug(
                "Thread snapshot not found over HTTP; treating the thread as deleted.",
              ).pipe(
                Effect.annotateLogs({ threadId }),
                Effect.as({ _tag: "missing" } satisfies ThreadSnapshotLoadResult),
              ),
          }),
          Effect.catchCause((cause) =>
            Effect.logWarning(
              "Could not load the thread snapshot over HTTP; using the socket snapshot instead.",
            ).pipe(
              Effect.annotateLogs({ threadId, cause: Cause.pretty(cause) }),
              Effect.as({ _tag: "unavailable" } satisfies ThreadSnapshotLoadResult),
            ),
          ),
        ),
    });
  }),
);
