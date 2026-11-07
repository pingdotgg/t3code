import { EnvironmentId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import { HttpClient } from "effect/http";

import {
  issueRemoteDpopWebSocketTicket,
  issueRemoteWebSocketTicket,
} from "../authorization/remote.ts";
import * as RemoteEnvironmentAuthorization from "../authorization/service.ts";
import { environmentEndpointUrl } from "../environment/endpoint.ts";
import * as ManagedRelay from "../relay/managedRelay.ts";
import {
  ConnectionBlockedError,
  ConnectionTransientError,
  type ConnectionAttemptError,
  type PreparedConnection,
} from "./model.ts";

const TICKET_TIMEOUT_MS = 8_000;

export class GatewayHopAuthorization extends Context.Service<
  GatewayHopAuthorization,
  {
    readonly remember: (
      environmentId: EnvironmentId,
      prepared: Option.Option<PreparedConnection>,
    ) => Effect.Effect<void>;
    /** Mints a ticket for the gateway's proxy. A cookie session on the gateway needs none. */
    readonly issueTicket: (
      gatewayEnvironmentId: EnvironmentId,
    ) => Effect.Effect<Option.Option<string>, ConnectionAttemptError>;
  }
>()("@t3tools/client-runtime/connection/gatewayHop/GatewayHopAuthorization") {}

const ticketFailed = (detail: string) =>
  new ConnectionTransientError({ reason: "remote-unavailable", detail });

const make = Effect.gen(function* () {
  const remote = yield* RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization;
  const signer = yield* ManagedRelay.ManagedRelayDpopSigner;
  const httpClient = yield* HttpClient.HttpClient;
  const preparedByEnvironment = yield* Ref.make(new Map<EnvironmentId, PreparedConnection>());

  const remember = Effect.fn("clientRuntime.connection.gatewayHop.remember")(function* (
    environmentId: EnvironmentId,
    prepared: Option.Option<PreparedConnection>,
  ) {
    yield* Ref.update(preparedByEnvironment, (current) => {
      const next = new Map(current);
      if (Option.isNone(prepared)) next.delete(environmentId);
      else next.set(environmentId, prepared.value);
      return next;
    });
  });

  const issueDpopTicket = Effect.fnUntraced(function* (prepared: PreparedConnection) {
    // The socket renews its token in the store, so the one it was prepared with goes stale.
    const current = yield* remote.authorizeDpopHttp({
      expectedEnvironmentId: prepared.environmentId,
    });
    const accessToken = current.httpAuthorization.accessToken;
    // A learned direct route keeps its own origin; only the token renews.
    const httpBaseUrl =
      prepared.target._tag === "RelayConnectionTarget" ? current.httpBaseUrl : prepared.httpBaseUrl;
    const createProof = (url: string) =>
      signer
        .createProof({ method: "POST", url, accessToken })
        .pipe(
          Effect.mapError(() => ticketFailed("Could not sign the LAN gateway ticket request.")),
        );
    return yield* issueRemoteDpopWebSocketTicket({
      httpBaseUrl,
      accessToken,
      dpopProof: yield* createProof(
        environmentEndpointUrl(httpBaseUrl, "/api/auth/websocket-ticket/media"),
      ),
      use: "media",
      fallbackProof: createProof(environmentEndpointUrl(httpBaseUrl, "/api/auth/websocket-ticket")),
      timeoutMs: TICKET_TIMEOUT_MS,
    });
  });

  const issueTicket = Effect.fn("clientRuntime.connection.gatewayHop.issueTicket")(
    function* (gatewayEnvironmentId: EnvironmentId) {
      const prepared = (yield* Ref.get(preparedByEnvironment)).get(gatewayEnvironmentId);
      if (prepared === undefined) {
        return yield* ticketFailed(
          "The LAN gateway host is not connected. Connect to that machine first, then try this peer again.",
        );
      }
      if (prepared.environmentId !== gatewayEnvironmentId) {
        return yield* new ConnectionBlockedError({
          reason: "configuration",
          detail: "The LAN gateway connection does not match the gateway environment id.",
        });
      }
      const authorization = prepared.httpAuthorization;
      if (authorization === null) return Option.none<string>();
      const issued = yield* (
        authorization._tag === "Bearer"
          ? issueRemoteWebSocketTicket({
              httpBaseUrl: prepared.httpBaseUrl,
              bearerToken: authorization.token,
              use: "media",
              timeoutMs: TICKET_TIMEOUT_MS,
            })
          : issueDpopTicket(prepared)
      ).pipe(
        Effect.mapError((error) =>
          error._tag === "ConnectionBlockedError" || error._tag === "ConnectionTransientError"
            ? error
            : ticketFailed(`Could not mint a LAN gateway ticket: ${error.message}`),
        ),
      );
      return Option.some(Redacted.value(issued.ticket));
    },
    Effect.provideService(HttpClient.HttpClient, httpClient),
  );

  return GatewayHopAuthorization.of({ remember, issueTicket });
});

export const layer = Layer.effect(GatewayHopAuthorization, make);
