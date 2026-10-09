import type { ThreadId } from "@t3tools/contracts";
import { boundedSnapshotProjection } from "@t3tools/shared/orchestrationV2BoundedSnapshot";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpClient } from "effect/http";

import * as RemoteEnvironmentAuthorization from "../authorization/service.ts";
import type { PreparedConnection } from "../connection/model.ts";
import { environmentEndpointUrl } from "../environment/endpoint.ts";
import * as ManagedRelay from "../relay/managedRelay.ts";
import {
  executeAuthenticatedEnvironmentHttpRequest,
  withOrchestrationProtocolHeader,
} from "./environmentHttpAuth.ts";
import * as ThreadSnapshotLoader from "./threadSnapshotHttp.ts";

// Same cold-open budget as the full snapshot path; bounded payloads should fit.
const DEFAULT_BOUNDED_THREAD_SNAPSHOT_TIMEOUT_MS = 6_000;

/**
 * Load a bounded recent-window thread snapshot over HTTP. Opts into compact
 * turnItems and restores them, so callers always see the full bounded shape.
 * Older servers ignore the query and send the full shape.
 */
export const fetchEnvironmentBoundedThreadSnapshot = Effect.fn(
  "clientRuntime.state.fetchEnvironmentBoundedThreadSnapshot",
)(function* (input: {
  readonly prepared: PreparedConnection;
  readonly threadId: ThreadId;
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
    url: (httpBaseUrl) =>
      environmentEndpointUrl(
        httpBaseUrl,
        `/api/orchestration/threads/${encodeURIComponent(input.threadId)}/bounded`,
      ),
    timeoutMs: input.timeoutMs ?? DEFAULT_BOUNDED_THREAD_SNAPSHOT_TIMEOUT_MS,
    request: ({ client, headers }) =>
      client.threadBoundedSnapshot({
        params: { threadId: input.threadId },
        query: { compactTurnItems: "1" },
        headers: withOrchestrationProtocolHeader(headers),
      }),
  }).pipe(
    // Drop the marker with the restore so nothing can restore twice.
    Effect.map(({ turnItemsOmitLocalVisible, ...snapshot }) => ({
      ...snapshot,
      projection: boundedSnapshotProjection({ ...snapshot, turnItemsOmitLocalVisible }),
    })),
  );
});

/**
 * Shared ThreadSnapshotLoader for clients that render progressive history.
 * Seeds from the bounded HTTP snapshot when available. Older servers that lack
 * the bounded route (plain/generic 404) fall back to the existing full HTTP
 * thread snapshot. Structured EnvironmentResourceNotFoundError from either
 * endpoint still means missing. Transient failures report `unavailable` so the
 * socket path remains a last resort for connectivity issues.
 */
export const layer: Layer.Layer<
  ThreadSnapshotLoader.ThreadSnapshotLoader,
  never,
  HttpClient.HttpClient
> = Layer.effect(
  ThreadSnapshotLoader.ThreadSnapshotLoader,
  Effect.gen(function* () {
    const httpClient = yield* HttpClient.HttpClient;
    const signer = yield* Effect.serviceOption(ManagedRelay.ManagedRelayDpopSigner);
    const remoteAuthorization = yield* Effect.serviceOption(
      RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization,
    );
    return ThreadSnapshotLoader.ThreadSnapshotLoader.of({
      load: (prepared: PreparedConnection, threadId: ThreadId) => {
        const loadFullFallback = ThreadSnapshotLoader.fetchEnvironmentThreadSnapshot({
          prepared,
          threadId,
          signer,
          remoteAuthorization,
        }).pipe(
          Effect.map((snapshot): ThreadSnapshotLoader.ThreadSnapshotLoadResult => ({
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
                Effect.as({
                  _tag: "missing",
                } satisfies ThreadSnapshotLoader.ThreadSnapshotLoadResult),
              ),
          }),
          Effect.catchCause((cause) =>
            Effect.logWarning(
              "Could not load the full thread snapshot over HTTP after bounded fallback; using the socket snapshot instead.",
            ).pipe(
              Effect.annotateLogs({ threadId, cause: Cause.pretty(cause) }),
              Effect.as({
                _tag: "unavailable",
              } satisfies ThreadSnapshotLoader.ThreadSnapshotLoadResult),
            ),
          ),
        );

        return fetchEnvironmentBoundedThreadSnapshot({
          prepared,
          threadId,
          signer,
          remoteAuthorization,
        }).pipe(
          Effect.map((bounded): ThreadSnapshotLoader.ThreadSnapshotLoadResult => ({
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
                Effect.as({
                  _tag: "missing",
                } satisfies ThreadSnapshotLoader.ThreadSnapshotLoadResult),
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
              Effect.as({
                _tag: "unavailable",
              } satisfies ThreadSnapshotLoader.ThreadSnapshotLoadResult),
            ),
          ),
        );
      },
    });
  }),
);
