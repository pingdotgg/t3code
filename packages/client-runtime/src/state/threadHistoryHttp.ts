import type { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type { RemoteEnvironmentAuthorization } from "../authorization/service.ts";
import type { PreparedConnection } from "../connection/model.ts";
import { environmentEndpointUrl } from "../environment/endpoint.ts";
import { ManagedRelayDpopSigner } from "../relay/managedRelay.ts";
import {
  executeAuthenticatedEnvironmentHttpRequest,
  withOrchestrationProtocolHeader,
} from "./environmentHttpAuth.ts";

const DEFAULT_THREAD_HISTORY_TIMEOUT_MS = 6_000;

export const fetchEnvironmentThreadHistoryPage = Effect.fn(
  "clientRuntime.state.fetchEnvironmentThreadHistoryPage",
)(function* (input: {
  readonly prepared: PreparedConnection;
  readonly threadId: ThreadId;
  readonly cursor: string;
  readonly signer: Option.Option<ManagedRelayDpopSigner["Service"]>;
  readonly remoteAuthorization?: Option.Option<RemoteEnvironmentAuthorization["Service"]>;
  readonly timeoutMs?: number;
}) {
  return yield* executeAuthenticatedEnvironmentHttpRequest({
    ...input,
    method: "GET",
    url: (httpBaseUrl) =>
      environmentEndpointUrl(httpBaseUrl, `/api/orchestration/threads/${input.threadId}/history`),
    timeoutMs: input.timeoutMs ?? DEFAULT_THREAD_HISTORY_TIMEOUT_MS,
    request: ({ client, headers }) =>
      client.orchestration.threadHistoryPage({
        params: { threadId: input.threadId },
        query: { cursor: input.cursor },
        headers: withOrchestrationProtocolHeader(headers),
      }),
  });
});
