import type { OrchestrationV2ThreadDetailSnapshot, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { RemoteEnvironmentAuthorization } from "../authorization/service.ts";
import type { PreparedConnection } from "../connection/model.ts";
import { environmentEndpointUrl } from "../environment/endpoint.ts";
import { ManagedRelayDpopSigner } from "../relay/managedRelay.ts";
import type { RemoteEnvironmentRequestError } from "../rpc/http.ts";
import {
  executeAuthenticatedEnvironmentHttpRequest,
  withOrchestrationProtocolHeader,
} from "./environmentHttpAuth.ts";

// Long enough for a slow but alive server to finish. On a cold open a timeout
// makes the socket ask the same server for the same snapshot again, and older
// turn pages have no fallback, so a short deadline only drops work. The socket
// fallback is for setups where /api fails but /ws works, such as a proxy that
// blocks /api. A dead server drops the socket session, which interrupts a
// cold-open load. Older turn pages wait for this deadline.
const DEFAULT_THREAD_SNAPSHOT_TIMEOUT_MS = 20_000;

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
  readonly remoteAuthorization?: Option.Option<RemoteEnvironmentAuthorization["Service"]>;
  readonly timeoutMs?: number;
}) {
  return yield* executeAuthenticatedEnvironmentHttpRequest({
    ...input,
    group: "orchestration",
    method: "GET",
    url: (httpBaseUrl) =>
      environmentEndpointUrl(httpBaseUrl, `/api/orchestration/threads/${input.threadId}`),
    timeoutMs: input.timeoutMs ?? DEFAULT_THREAD_SNAPSHOT_TIMEOUT_MS,
    request: ({ client, headers }) =>
      client.threadSnapshot({
        params: { threadId: input.threadId },
        headers: withOrchestrationProtocolHeader(headers),
      }),
  });
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
