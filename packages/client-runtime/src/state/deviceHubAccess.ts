/**
 * Credentials for the Device panel's media requests.
 *
 * The panel reaches simulator streams through `/api/device-hub/*` on the
 * environment origin, using `<img>`, `fetch`, and `WebSocket`. None of those
 * can carry a bearer or DPoP header, so bearer and DPoP connections mint a
 * short-lived WebSocket ticket and pass it as `wsTicket`, the same way the
 * app's own `/ws` upgrade authenticates. Cookie sessions send the cookie.
 *
 * A ticket lives five minutes server-side and is bound to the session, not
 * to one request, so one ticket covers everything a panel opens at once.
 * Callers fetch a fresh one each time they (re)connect a stream.
 */
import * as Effect from "effect/Effect";
import type { HttpClient } from "effect/unstable/http";

import { RemoteEnvironmentAuthorization } from "../authorization/service.ts";
import type { PreparedConnection } from "../connection/model.ts";
import { environmentEndpointUrl } from "../environment/endpoint.ts";
import { ManagedRelayDpopSigner } from "../relay/managedRelay.ts";
import type { RemoteEnvironmentRequestError } from "../rpc/http.ts";
import { executeAuthenticatedEnvironmentHttpRequest } from "./environmentHttpAuth.ts";

const TICKET_TIMEOUT_MS = 8_000;

export interface DeviceHubAccess {
  /** Absolute origin-relative base, e.g. `https://env.example/api/device-hub`. */
  readonly httpBase: string;
  /** Same base with the `ws(s)` scheme. */
  readonly wsBase: string;
  /** Query parameters to append to every hub request; empty for cookie sessions. */
  readonly query: Readonly<Record<string, string>>;
  /** Whether requests must include cookies (same-origin session). */
  readonly credentials: boolean;
}

export const resolveDeviceHubAccess = Effect.fn("clientRuntime.state.resolveDeviceHubAccess")(
  function* (input: {
    readonly prepared: PreparedConnection;
    readonly hubBasePath: string;
  }): Effect.fn.Return<DeviceHubAccess, RemoteEnvironmentRequestError, HttpClient.HttpClient> {
    const httpBase = environmentEndpointUrl(input.prepared.httpBaseUrl, input.hubBasePath);
    const wsBase = httpBase.replace(/^http/, "ws");
    if (input.prepared.httpAuthorization === null) {
      return { httpBase, wsBase, query: {}, credentials: true };
    }
    const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
    const remoteAuthorization = yield* Effect.serviceOption(RemoteEnvironmentAuthorization);
    const ticket = yield* executeAuthenticatedEnvironmentHttpRequest({
      prepared: input.prepared,
      signer,
      remoteAuthorization,
      method: "POST",
      url: (httpBaseUrl) => environmentEndpointUrl(httpBaseUrl, "/api/auth/websocket-ticket"),
      timeoutMs: TICKET_TIMEOUT_MS,
      request: ({ client, headers }) => client.auth.webSocketTicket({ headers }),
    });
    return {
      httpBase,
      wsBase,
      query: { wsTicket: ticket.ticket },
      credentials: false,
    };
  },
);

export const withDeviceHubQuery = (url: string, access: DeviceHubAccess): string => {
  const entries = Object.entries(access.query);
  if (entries.length === 0) return url;
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}${new URLSearchParams(entries).toString()}`;
};
