import { EnvironmentId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import type { HttpClient } from "effect/http";

import {
  issueRemoteDpopWebSocketTicket,
  issueRemoteWebSocketTicket,
} from "../authorization/remote.ts";
import { appendGatewayTicket, environmentEndpointUrl } from "../environment/endpoint.ts";
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
    readonly withGatewayTicket: (input: {
      readonly gatewayEnvironmentId: EnvironmentId;
      readonly httpBaseUrl: string;
      readonly wsBaseUrl: string;
    }) => Effect.Effect<
      { readonly httpBaseUrl: string; readonly wsBaseUrl: string },
      ConnectionAttemptError,
      HttpClient.HttpClient
    >;
  }
>()("@t3tools/client-runtime/connection/gatewayHop/GatewayHopAuthorization") {}

const issueMediaTicket = Effect.fn("clientRuntime.connection.gatewayHop.issueMediaTicket")(
  function* (prepared: PreparedConnection) {
    // Cookie sessions on the gateway host do not need a hop ticket.
    if (prepared.httpAuthorization === null) {
      return Option.none<string>();
    }
    if (prepared.httpAuthorization._tag === "Bearer") {
      const ticket = yield* issueRemoteWebSocketTicket({
        httpBaseUrl: prepared.httpBaseUrl,
        bearerToken: prepared.httpAuthorization.token,
        use: "media",
        timeoutMs: TICKET_TIMEOUT_MS,
      }).pipe(
        Effect.mapError(
          (error) =>
            new ConnectionTransientError({
              reason: "remote-unavailable",
              detail: `Could not mint a LAN gateway ticket: ${error.message}`,
            }),
        ),
      );
      return Option.some(Redacted.value(ticket.ticket));
    }
    const signer = yield* Effect.serviceOption(ManagedRelay.ManagedRelayDpopSigner);
    if (Option.isNone(signer)) {
      return yield* new ConnectionBlockedError({
        reason: "configuration",
        detail: "No DPoP signer is available to mint a LAN gateway ticket.",
      });
    }
    const accessToken = prepared.httpAuthorization.accessToken;
    const createProof = (method: "GET" | "POST", url: string) =>
      signer.value.createProof({ method, url, accessToken }).pipe(
        Effect.mapError(
          () =>
            new ConnectionTransientError({
              reason: "remote-unavailable",
              detail: "Could not sign the LAN gateway ticket request.",
            }),
        ),
      );
    const dpopProof = yield* createProof(
      "POST",
      environmentEndpointUrl(prepared.httpBaseUrl, "/api/auth/websocket-ticket/media"),
    );
    const ticket = yield* issueRemoteDpopWebSocketTicket({
      httpBaseUrl: prepared.httpBaseUrl,
      accessToken,
      dpopProof,
      use: "media",
      fallbackProof: createProof(
        "POST",
        environmentEndpointUrl(prepared.httpBaseUrl, "/api/auth/websocket-ticket"),
      ),
      timeoutMs: TICKET_TIMEOUT_MS,
    }).pipe(
      Effect.mapError(
        (error) =>
          new ConnectionTransientError({
            reason: "remote-unavailable",
            detail: `Could not mint a LAN gateway ticket: ${error.message}`,
          }),
      ),
    );
    return Option.some(Redacted.value(ticket.ticket));
  },
);

const make = Effect.gen(function* () {
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

  const withGatewayTicket = Effect.fn("clientRuntime.connection.gatewayHop.withGatewayTicket")(
    function* (input: {
      readonly gatewayEnvironmentId: EnvironmentId;
      readonly httpBaseUrl: string;
      readonly wsBaseUrl: string;
    }) {
      const prepared = (yield* Ref.get(preparedByEnvironment)).get(input.gatewayEnvironmentId);
      if (prepared === undefined) {
        return yield* new ConnectionTransientError({
          reason: "remote-unavailable",
          detail:
            "The LAN gateway host is not connected. Connect to that machine first, then try this peer again.",
        });
      }
      if (prepared.environmentId !== input.gatewayEnvironmentId) {
        return yield* new ConnectionBlockedError({
          reason: "configuration",
          detail: "The LAN gateway connection does not match the gateway environment id.",
        });
      }
      const ticket = yield* issueMediaTicket(prepared);
      if (Option.isNone(ticket)) {
        return { httpBaseUrl: input.httpBaseUrl, wsBaseUrl: input.wsBaseUrl };
      }
      return {
        httpBaseUrl: appendGatewayTicket(input.httpBaseUrl, ticket.value),
        wsBaseUrl: appendGatewayTicket(input.wsBaseUrl, ticket.value),
      };
    },
  );

  return GatewayHopAuthorization.of({ remember, withGatewayTicket });
});

export const layer = Layer.effect(GatewayHopAuthorization, make);
