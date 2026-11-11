import type { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type { PreparedConnection } from "../connection/model.ts";
import {
  executeAuthenticatedEnvironmentHttpRequest,
  withOrchestrationProtocolHeader,
} from "./environmentHttpAuth.ts";

export const fetchEnvironmentThreadTranscript = Effect.fn(
  "clientRuntime.state.fetchEnvironmentThreadTranscript",
)(function* (input: { readonly prepared: PreparedConnection; readonly threadId: ThreadId }) {
  return yield* executeAuthenticatedEnvironmentHttpRequest({
    ...input,
    group: "orchestration",
    method: "GET",
    url: (urls) => urls.threadTranscript({ params: { threadId: input.threadId } }),
    timeoutMs: 60_000,
    request: ({ client, headers }) =>
      client.threadTranscript({
        params: { threadId: input.threadId },
        headers: withOrchestrationProtocolHeader(headers),
      }),
  });
});
