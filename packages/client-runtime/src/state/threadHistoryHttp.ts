import type { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type { RemoteEnvironmentAuthorization } from "../authorization/service.ts";
import type { PreparedConnection } from "../connection/model.ts";
import * as ManagedRelay from "../relay/managedRelay.ts";
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
  readonly throughEntryId?: string | undefined;
  readonly view?: "conversation" | "activity" | undefined;
  readonly signer: Option.Option<ManagedRelay.ManagedRelayDpopSigner["Service"]>;
  readonly remoteAuthorization?: Option.Option<RemoteEnvironmentAuthorization["Service"]>;
  readonly timeoutMs?: number;
}) {
  const endpoint = {
    params: { threadId: input.threadId },
    query: {
      cursor: input.cursor,
      ...(input.view === undefined ? {} : { view: input.view }),
      ...(input.throughEntryId === undefined ? {} : { throughEntryId: input.throughEntryId }),
    },
  };
  return yield* executeAuthenticatedEnvironmentHttpRequest({
    ...input,
    group: "orchestration",
    method: "GET",
    url: (urls) => urls.threadHistoryPage(endpoint),
    timeoutMs: input.timeoutMs ?? DEFAULT_THREAD_HISTORY_TIMEOUT_MS,
    request: ({ client, headers }) =>
      client.threadHistoryPage({ ...endpoint, headers: withOrchestrationProtocolHeader(headers) }),
  });
});
