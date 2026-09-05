import type { ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpClient } from "effect/unstable/http";

import { RemoteEnvironmentAuthorization } from "../authorization/service.ts";
import type { PreparedConnection } from "../connection/model.ts";
import { environmentEndpointUrl } from "../environment/endpoint.ts";
import { ManagedRelayDpopSigner } from "../relay/managedRelay.ts";
import {
  executeAuthenticatedEnvironmentHttpRequest,
  withOrchestrationProtocolHeader,
} from "./environmentHttpAuth.ts";
import {
  fetchEnvironmentThreadSnapshot,
  ThreadSnapshotLoader,
  type ThreadSnapshotLoadResult,
} from "./threadSnapshotHttp.ts";

// Same cold-open budget as the full snapshot path; bounded payloads should fit.
const DEFAULT_BOUNDED_THREAD_SNAPSHOT_TIMEOUT_MS = 6_000;

/** Load a bounded recent-window thread snapshot over HTTP. */
export const fetchEnvironmentBoundedThreadSnapshot = Effect.fn(
  "clientRuntime.state.fetchEnvironmentBoundedThreadSnapshot",
)(function* (input: {
  readonly prepared: PreparedConnection;
  readonly threadId: ThreadId;
  readonly signer: Option.Option<ManagedRelayDpopSigner["Service"]>;
  readonly remoteAuthorization?: Option.Option<RemoteEnvironmentAuthorization["Service"]>;
  readonly timeoutMs?: number;
}) {
  return yield* executeAuthenticatedEnvironmentHttpRequest({
    ...input,
    method: "GET",
    url: (httpBaseUrl) =>
      environmentEndpointUrl(httpBaseUrl, `/api/orchestration/threads/${input.threadId}/bounded`),
    timeoutMs: input.timeoutMs ?? DEFAULT_BOUNDED_THREAD_SNAPSHOT_TIMEOUT_MS,
    request: ({ client, headers }) =>
      client.orchestration.threadBoundedSnapshot({
        params: { threadId: input.threadId },
        headers: withOrchestrationProtocolHeader(headers),
      }),
  });
});

/**
 * Shared ThreadSnapshotLoader for clients that render progressive history.
 * Seeds from the bounded HTTP snapshot when available. Older servers that lack
 * the bounded route (plain/generic 404) fall back to the existing full HTTP
 * thread snapshot. Structured EnvironmentResourceNotFoundError from either
 * endpoint still means missing. Transient failures report `unavailable` so the
 * socket path remains a last resort for connectivity issues.
 */
export const boundedThreadSnapshotLoaderLayer: Layer.Layer<
  ThreadSnapshotLoader,
  never,
  HttpClient.HttpClient
> = Layer.effect(
  ThreadSnapshotLoader,
  Effect.gen(function* () {
    const httpClient = yield* HttpClient.HttpClient;
    const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
    const remoteAuthorization = yield* Effect.serviceOption(RemoteEnvironmentAuthorization);
    return ThreadSnapshotLoader.of({
      load: (prepared: PreparedConnection, threadId: ThreadId) => {
        const loadFullFallback = fetchEnvironmentThreadSnapshot({
          prepared,
          threadId,
          signer,
          remoteAuthorization,
        }).pipe(
          Effect.map((snapshot): ThreadSnapshotLoadResult => ({
            _tag: "present",
            snapshot,
          })),
          Effect.provideService(HttpClient.HttpClient, httpClient),
          Effect.catchTags({
            EnvironmentResourceNotFoundError: () =>
              Effect.logDebug(
                "Full thread snapshot not found over HTTP after bounded fallback; treating the thread as deleted.",
              ).pipe(
                Effect.annotateLogs({ threadId }),
                Effect.as({ _tag: "missing" } satisfies ThreadSnapshotLoadResult),
              ),
          }),
          Effect.catchCause((cause) =>
            Effect.logWarning(
              "Could not load the full thread snapshot over HTTP after bounded fallback; using the socket snapshot instead.",
            ).pipe(
              Effect.annotateLogs({ threadId, cause: Cause.pretty(cause) }),
              Effect.as({ _tag: "unavailable" } satisfies ThreadSnapshotLoadResult),
            ),
          ),
        );

        return fetchEnvironmentBoundedThreadSnapshot({
          prepared,
          threadId,
          signer,
          remoteAuthorization,
        }).pipe(
          Effect.map((bounded): ThreadSnapshotLoadResult => ({
            _tag: "present",
            snapshot: {
              snapshotSequence: bounded.snapshotSequence,
              projection: bounded.projection,
              latestLocalTurnOrdinal: bounded.latestLocalTurnOrdinal,
            },
            history: {
              historyCursor: bounded.historyCursor,
              hasMoreHistory: bounded.hasMoreHistory,
              latestLocalTurnOrdinal: bounded.latestLocalTurnOrdinal,
            },
          })),
          Effect.provideService(HttpClient.HttpClient, httpClient),
          Effect.catchTags({
            EnvironmentResourceNotFoundError: () =>
              Effect.logDebug(
                "Bounded thread snapshot not found over HTTP; treating the thread as deleted.",
              ).pipe(
                Effect.annotateLogs({ threadId }),
                Effect.as({ _tag: "missing" } satisfies ThreadSnapshotLoadResult),
              ),
            RemoteEnvironmentAuthInvalidJsonError: (error) =>
              Effect.logDebug(
                "Bounded thread snapshot returned an invalid response; trying the full HTTP thread snapshot for an older server.",
              ).pipe(
                Effect.annotateLogs({ threadId, cause: error.message }),
                Effect.andThen(loadFullFallback),
              ),
            RemoteEnvironmentAuthUndeclaredStatusError: (error) =>
              error.status === 404
                ? Effect.logDebug(
                    "Bounded thread snapshot route was not found; trying the full HTTP thread snapshot for an older server.",
                  ).pipe(Effect.annotateLogs({ threadId }), Effect.andThen(loadFullFallback))
                : Effect.fail(error),
          }),
          Effect.catchCause((cause) =>
            Effect.logWarning(
              "Could not load the bounded thread snapshot over HTTP; using the socket snapshot instead.",
            ).pipe(
              Effect.annotateLogs({ threadId, cause: Cause.pretty(cause) }),
              Effect.as({ _tag: "unavailable" } satisfies ThreadSnapshotLoadResult),
            ),
          ),
        );
      },
    });
  }),
);
