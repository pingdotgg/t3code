import type {
  MessageId,
  OrchestrationThreadDetailSnapshot,
  OrchestrationThreadHistoryOutline,
  OrchestrationThreadHistoryPage,
  OrchestrationThreadMessageCursor,
  ThreadId,
} from "@t3tools/contracts";
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

// The timeout covers response decoding and schema validation as well as the
// request itself. Dense turns can contain thousands of tool activities, so a
// short timeout can discard an already-delivered page and repeat the same work
// through the socket fallback.
const DEFAULT_THREAD_SNAPSHOT_TIMEOUT_MS = 30_000;
export const THREAD_TURN_PAGE_SIZE = 10;

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
  readonly window?: ThreadSnapshotWindow;
  readonly timeoutMs?: number;
}) {
  const requestUrl = new URL(
    environmentEndpointUrl(
      input.prepared.httpBaseUrl,
      `/api/orchestration/threads/${input.threadId}`,
    ),
  );
  if (input.window !== undefined) {
    requestUrl.searchParams.set("turnLimit", String(input.window.turnLimit));
  }
  if (input.window?.beforeCursor !== undefined) {
    requestUrl.searchParams.set("beforeCursor", input.window.beforeCursor);
  }
  const client = yield* makeEnvironmentHttpApiClient(input.prepared.httpBaseUrl);
  const headers = yield* buildEnvironmentAuthHeaders(
    input.prepared.httpAuthorization,
    "GET",
    requestUrl.toString(),
    input.signer,
  );
  return yield* executeEnvironmentHttpRequest(
    requestUrl.toString(),
    input.timeoutMs ?? DEFAULT_THREAD_SNAPSHOT_TIMEOUT_MS,
    withEnvironmentCredentials(
      input.prepared.httpAuthorization,
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
    ),
  );
});

export const fetchEnvironmentThreadMessageSnapshot = Effect.fn(
  "clientRuntime.state.fetchEnvironmentThreadMessageSnapshot",
)(function* (input: {
  readonly prepared: PreparedConnection;
  readonly threadId: ThreadId;
  readonly turnLimit: number;
  readonly signer: Option.Option<ManagedRelayDpopSigner["Service"]>;
  readonly timeoutMs?: number;
}) {
  const requestUrl = new URL(
    environmentEndpointUrl(
      input.prepared.httpBaseUrl,
      `/api/orchestration/threads/${input.threadId}/with-message-history`,
    ),
  );
  requestUrl.searchParams.set("turnLimit", String(input.turnLimit));
  const client = yield* makeEnvironmentHttpApiClient(input.prepared.httpBaseUrl);
  const headers = yield* buildEnvironmentAuthHeaders(
    input.prepared.httpAuthorization,
    "GET",
    requestUrl.toString(),
    input.signer,
  );
  return yield* executeEnvironmentHttpRequest(
    requestUrl.toString(),
    input.timeoutMs ?? DEFAULT_THREAD_SNAPSHOT_TIMEOUT_MS,
    withEnvironmentCredentials(
      input.prepared.httpAuthorization,
      client.orchestration.threadMessageSnapshot({
        params: { threadId: input.threadId },
        payload: { turnLimit: input.turnLimit },
        headers,
      }),
    ),
  );
});

export const fetchEnvironmentThreadMessagesBefore = Effect.fn(
  "clientRuntime.state.fetchEnvironmentThreadMessagesBefore",
)(function* (input: {
  readonly prepared: PreparedConnection;
  readonly threadId: ThreadId;
  readonly before: OrchestrationThreadMessageCursor;
  readonly turnLimit: number;
  readonly signer: Option.Option<ManagedRelayDpopSigner["Service"]>;
  readonly timeoutMs?: number;
}) {
  const requestUrl = new URL(
    environmentEndpointUrl(
      input.prepared.httpBaseUrl,
      `/api/orchestration/threads/${input.threadId}/messages`,
    ),
  );
  requestUrl.searchParams.set("beforeCreatedAt", input.before.createdAt);
  requestUrl.searchParams.set("beforeMessageId", input.before.messageId);
  requestUrl.searchParams.set("turnLimit", String(input.turnLimit));
  const client = yield* makeEnvironmentHttpApiClient(input.prepared.httpBaseUrl);
  const headers = yield* buildEnvironmentAuthHeaders(
    input.prepared.httpAuthorization,
    "GET",
    requestUrl.toString(),
    input.signer,
  );
  return yield* executeEnvironmentHttpRequest(
    requestUrl.toString(),
    input.timeoutMs ?? DEFAULT_THREAD_SNAPSHOT_TIMEOUT_MS,
    withEnvironmentCredentials(
      input.prepared.httpAuthorization,
      client.orchestration.threadMessages({
        params: { threadId: input.threadId },
        payload: {
          beforeCreatedAt: input.before.createdAt,
          beforeMessageId: input.before.messageId,
          turnLimit: input.turnLimit,
        },
        headers,
      }),
    ),
  );
});

export const fetchEnvironmentThreadMessagesAfter = Effect.fn(
  "clientRuntime.state.fetchEnvironmentThreadMessagesAfter",
)(function* (input: {
  readonly prepared: PreparedConnection;
  readonly threadId: ThreadId;
  readonly after: OrchestrationThreadMessageCursor;
  readonly turnLimit: number;
  readonly signer: Option.Option<ManagedRelayDpopSigner["Service"]>;
  readonly timeoutMs?: number;
}) {
  const requestUrl = new URL(
    environmentEndpointUrl(
      input.prepared.httpBaseUrl,
      `/api/orchestration/threads/${input.threadId}/messages/after`,
    ),
  );
  requestUrl.searchParams.set("afterCreatedAt", input.after.createdAt);
  requestUrl.searchParams.set("afterMessageId", input.after.messageId);
  requestUrl.searchParams.set("turnLimit", String(input.turnLimit));
  const client = yield* makeEnvironmentHttpApiClient(input.prepared.httpBaseUrl);
  const headers = yield* buildEnvironmentAuthHeaders(
    input.prepared.httpAuthorization,
    "GET",
    requestUrl.toString(),
    input.signer,
  );
  return yield* executeEnvironmentHttpRequest(
    requestUrl.toString(),
    input.timeoutMs ?? DEFAULT_THREAD_SNAPSHOT_TIMEOUT_MS,
    withEnvironmentCredentials(
      input.prepared.httpAuthorization,
      client.orchestration.threadMessagesAfter({
        params: { threadId: input.threadId },
        payload: {
          afterCreatedAt: input.after.createdAt,
          afterMessageId: input.after.messageId,
          turnLimit: input.turnLimit,
        },
        headers,
      }),
    ),
  );
});

export const fetchEnvironmentThreadMessagesAround = Effect.fn(
  "clientRuntime.state.fetchEnvironmentThreadMessagesAround",
)(function* (input: {
  readonly prepared: PreparedConnection;
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
  readonly signer: Option.Option<ManagedRelayDpopSigner["Service"]>;
  readonly timeoutMs?: number;
}) {
  const requestUrl = new URL(
    environmentEndpointUrl(
      input.prepared.httpBaseUrl,
      `/api/orchestration/threads/${input.threadId}/messages/${input.messageId}/around`,
    ),
  );
  requestUrl.searchParams.set("turnLimit", String(THREAD_TURN_PAGE_SIZE));
  const client = yield* makeEnvironmentHttpApiClient(input.prepared.httpBaseUrl);
  const headers = yield* buildEnvironmentAuthHeaders(
    input.prepared.httpAuthorization,
    "GET",
    requestUrl.toString(),
    input.signer,
  );
  return yield* executeEnvironmentHttpRequest(
    requestUrl.toString(),
    input.timeoutMs ?? DEFAULT_THREAD_SNAPSHOT_TIMEOUT_MS,
    withEnvironmentCredentials(
      input.prepared.httpAuthorization,
      client.orchestration.threadMessagesAround({
        params: { threadId: input.threadId, messageId: input.messageId },
        payload: { turnLimit: THREAD_TURN_PAGE_SIZE },
        headers,
      }),
    ),
  );
});

export const fetchEnvironmentThreadHistoryOutline = Effect.fn(
  "clientRuntime.state.fetchEnvironmentThreadHistoryOutline",
)(function* (input: {
  readonly prepared: PreparedConnection;
  readonly threadId: ThreadId;
  readonly signer: Option.Option<ManagedRelayDpopSigner["Service"]>;
  readonly timeoutMs?: number;
}) {
  const requestUrl = environmentEndpointUrl(
    input.prepared.httpBaseUrl,
    `/api/orchestration/threads/${input.threadId}/history/outline`,
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
      client.orchestration.threadHistoryOutline({
        params: { threadId: input.threadId },
        headers,
      }),
    ),
  );
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
    readonly loadMessageHistory: (
      prepared: PreparedConnection,
      threadId: ThreadId,
      turnLimit: number,
    ) => Effect.Effect<Option.Option<OrchestrationThreadDetailSnapshot>>;
    readonly loadPreviousMessages: (
      prepared: PreparedConnection,
      threadId: ThreadId,
      before: OrchestrationThreadMessageCursor,
      turnLimit: number,
    ) => Effect.Effect<Option.Option<OrchestrationThreadHistoryPage>>;
    readonly loadNextMessages: (
      prepared: PreparedConnection,
      threadId: ThreadId,
      after: OrchestrationThreadMessageCursor,
      turnLimit: number,
    ) => Effect.Effect<Option.Option<OrchestrationThreadHistoryPage>>;
    readonly loadMessagesAround: (
      prepared: PreparedConnection,
      threadId: ThreadId,
      messageId: MessageId,
    ) => Effect.Effect<Option.Option<OrchestrationThreadHistoryPage>>;
    readonly loadHistoryOutline: (
      prepared: PreparedConnection,
      threadId: ThreadId,
    ) => Effect.Effect<Option.Option<OrchestrationThreadHistoryOutline>>;
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
      load: (prepared: PreparedConnection, threadId: ThreadId, window?: ThreadSnapshotWindow) =>
        fetchEnvironmentThreadSnapshot({
          prepared,
          threadId,
          signer,
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
      loadMessageHistory: (prepared: PreparedConnection, threadId: ThreadId, turnLimit: number) =>
        fetchEnvironmentThreadMessageSnapshot({
          prepared,
          threadId,
          turnLimit,
          signer,
        }).pipe(
          Effect.map(Option.some<OrchestrationThreadDetailSnapshot>),
          Effect.provideService(HttpClient.HttpClient, httpClient),
          Effect.catchTags({
            EnvironmentResourceNotFoundError: () =>
              Effect.logDebug(
                "Thread message snapshot not found over HTTP; deferring to the socket subscription.",
              ).pipe(
                Effect.annotateLogs({ threadId }),
                Effect.as(Option.none<OrchestrationThreadDetailSnapshot>()),
              ),
          }),
          Effect.catchCause((cause) =>
            Effect.logWarning(
              "Could not load the thread message snapshot over HTTP; using the socket snapshot instead.",
            ).pipe(
              Effect.annotateLogs({ threadId, cause: Cause.pretty(cause) }),
              Effect.as(Option.none<OrchestrationThreadDetailSnapshot>()),
            ),
          ),
        ),
      loadPreviousMessages: (
        prepared: PreparedConnection,
        threadId: ThreadId,
        before: OrchestrationThreadMessageCursor,
        turnLimit: number,
      ) =>
        fetchEnvironmentThreadMessagesBefore({
          prepared,
          threadId,
          before,
          turnLimit,
          signer,
        }).pipe(
          Effect.map(Option.some<OrchestrationThreadHistoryPage>),
          Effect.provideService(HttpClient.HttpClient, httpClient),
          Effect.catchTags({
            EnvironmentResourceNotFoundError: () =>
              Effect.logDebug("Thread message history was not found.").pipe(
                Effect.annotateLogs({ threadId }),
                Effect.as(Option.none<OrchestrationThreadHistoryPage>()),
              ),
          }),
          Effect.catchCause((cause) =>
            Effect.logWarning("Could not load previous thread messages.").pipe(
              Effect.annotateLogs({ threadId, cause: Cause.pretty(cause) }),
              Effect.as(Option.none<OrchestrationThreadHistoryPage>()),
            ),
          ),
        ),
      loadNextMessages: (
        prepared: PreparedConnection,
        threadId: ThreadId,
        after: OrchestrationThreadMessageCursor,
        turnLimit: number,
      ) =>
        fetchEnvironmentThreadMessagesAfter({
          prepared,
          threadId,
          after,
          turnLimit,
          signer,
        }).pipe(
          Effect.map(Option.some<OrchestrationThreadHistoryPage>),
          Effect.provideService(HttpClient.HttpClient, httpClient),
          Effect.catchTags({
            EnvironmentResourceNotFoundError: () =>
              Effect.logDebug("Thread message history was not found.").pipe(
                Effect.annotateLogs({ threadId }),
                Effect.as(Option.none<OrchestrationThreadHistoryPage>()),
              ),
          }),
          Effect.catchCause((cause) =>
            Effect.logWarning("Could not load next thread messages.").pipe(
              Effect.annotateLogs({ threadId, cause: Cause.pretty(cause) }),
              Effect.as(Option.none<OrchestrationThreadHistoryPage>()),
            ),
          ),
        ),
      loadMessagesAround: (
        prepared: PreparedConnection,
        threadId: ThreadId,
        messageId: MessageId,
      ) =>
        fetchEnvironmentThreadMessagesAround({ prepared, threadId, messageId, signer }).pipe(
          Effect.map(Option.some<OrchestrationThreadHistoryPage>),
          Effect.provideService(HttpClient.HttpClient, httpClient),
          Effect.catchTags({
            EnvironmentResourceNotFoundError: () =>
              Effect.logDebug("Thread message history target was not found.").pipe(
                Effect.annotateLogs({ threadId, messageId }),
                Effect.as(Option.none<OrchestrationThreadHistoryPage>()),
              ),
          }),
          Effect.catchCause((cause) =>
            Effect.logWarning("Could not load thread messages around the target.").pipe(
              Effect.annotateLogs({ threadId, messageId, cause: Cause.pretty(cause) }),
              Effect.as(Option.none<OrchestrationThreadHistoryPage>()),
            ),
          ),
        ),
      loadHistoryOutline: (prepared: PreparedConnection, threadId: ThreadId) =>
        fetchEnvironmentThreadHistoryOutline({ prepared, threadId, signer }).pipe(
          Effect.map(Option.some<OrchestrationThreadHistoryOutline>),
          Effect.provideService(HttpClient.HttpClient, httpClient),
          Effect.catchTags({
            EnvironmentResourceNotFoundError: () =>
              Effect.logDebug("Thread history outline was not found.").pipe(
                Effect.annotateLogs({ threadId }),
                Effect.as(Option.none<OrchestrationThreadHistoryOutline>()),
              ),
          }),
          Effect.catchCause((cause) =>
            Effect.logWarning("Could not load the thread history outline.").pipe(
              Effect.annotateLogs({ threadId, cause: Cause.pretty(cause) }),
              Effect.as(Option.none<OrchestrationThreadHistoryOutline>()),
            ),
          ),
        ),
    });
  }),
);
