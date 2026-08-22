import type { TcpPortForwardHost } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as Option from "effect/Option";

import type { PreparedConnection } from "../connection/model.ts";
import { environmentEndpointUrl } from "../environment/endpoint.ts";
import type { ManagedRelayDpopSigner } from "../relay/managedRelay.ts";
import { executeEnvironmentHttpRequest, makeEnvironmentHttpApiClient } from "../rpc/http.ts";
import {
  buildEnvironmentAuthHeaders,
  withEnvironmentCredentials,
} from "../state/environmentHttpAuth.ts";

const DEFAULT_TCP_FORWARD_TICKET_TIMEOUT_MS = 10_000;

export const resolveTcpPortForwardSocketUrl = Effect.fn(
  "clientRuntime.authorization.resolveTcpPortForwardSocketUrl",
)(function* (input: {
  readonly prepared: PreparedConnection;
  readonly signer: Option.Option<ManagedRelayDpopSigner["Service"]>;
  readonly remoteHost: TcpPortForwardHost;
  readonly remotePort: number;
  readonly timeoutMs?: number;
}) {
  const requestUrl = environmentEndpointUrl(
    input.prepared.httpBaseUrl,
    "/api/auth/tcp-forward-ticket",
  );
  const client = yield* makeEnvironmentHttpApiClient(input.prepared.httpBaseUrl);
  const headers = yield* buildEnvironmentAuthHeaders(
    input.prepared.httpAuthorization,
    "POST",
    requestUrl,
    input.signer,
  );
  const issued = yield* executeEnvironmentHttpRequest(
    requestUrl,
    input.timeoutMs ?? DEFAULT_TCP_FORWARD_TICKET_TIMEOUT_MS,
    withEnvironmentCredentials(
      input.prepared.httpAuthorization,
      client.auth.tcpPortForwardTicket({
        headers,
        payload: { remoteHost: input.remoteHost, remotePort: input.remotePort },
      }),
    ),
  );

  const socketUrl = new URL(input.prepared.httpBaseUrl);
  socketUrl.protocol = socketUrl.protocol === "https:" ? "wss:" : "ws:";
  socketUrl.pathname = "/ws/tcp-forward";
  socketUrl.search = "";
  socketUrl.hash = "";
  socketUrl.searchParams.set("ticket", issued.ticket);
  return socketUrl.toString();
});
