import type { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type { PreparedConnection } from "../connection/model.ts";
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
  readonly view?: "conversation" | "activity" | "work" | undefined;
  readonly timeoutMs?: number;
}) {
  const endpoint = {
    params: { threadId: input.threadId },
    query: {
      cursor: input.cursor,
      compactIds: "1",
      ...(input.throughEntryId === undefined ? { deferWork: "1" } : {}),
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
