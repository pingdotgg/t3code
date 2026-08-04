import { WsRpcGroup } from "@t3tools/contracts";
import { Duration, Effect, Layer, Schedule } from "effect";
import { RpcClient, RpcSerialization } from "effect/unstable/rpc";
import * as Socket from "effect/unstable/socket/Socket";

import {
  acknowledgeRpcRequest,
  clearAllTrackedRpcRequests,
  trackRpcRequestSent,
} from "./requestLatencyState";
import {
  getWsReconnectDelayMsForRetry,
  recordWsConnectionAttempt,
  recordWsConnectionClosed,
  recordWsConnectionErrored,
  recordWsConnectionOpened,
  WS_RECONNECT_MAX_RETRIES,
} from "./wsConnectionState";
import { recordWsDiagnostic, sanitizeWsSocketUrl } from "./wsDiagnostics";

export interface WsProtocolLifecycleHandlers {
  readonly isActive?: () => boolean;
  readonly onAttempt?: (socketUrl: string) => void;
  readonly onOpen?: () => void;
  readonly onError?: (message: string) => void;
  readonly onClose?: (details: { readonly code: number; readonly reason: string }) => void;
  /**
   * Fires once the RPC protocol can send on a freshly opened socket. Transient
   * socket reopens (ping timeouts, failed reconnect attempts) never fail
   * in-flight requests, so this is the only signal that pending streams were
   * abandoned server-side and have to be re-subscribed.
   */
  readonly onProtocolConnected?: () => void;
}

const PING_TIMEOUT_ERROR_MESSAGE = "The T3 server WebSocket stopped responding.";

export const makeWsRpcProtocolClient = RpcClient.make(WsRpcGroup);
type RpcClientFactory = typeof makeWsRpcProtocolClient;
export type WsRpcProtocolClient =
  RpcClientFactory extends Effect.Effect<infer Client, any, any> ? Client : never;
export type WsRpcProtocolSocketUrlProvider = string | (() => Promise<string>);

function formatSocketErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  return String(error);
}

function resolveWsRpcSocketUrl(rawUrl: string): string {
  const resolved = new URL(rawUrl);
  if (resolved.protocol !== "ws:" && resolved.protocol !== "wss:") {
    throw new Error(`Unsupported websocket transport URL protocol: ${resolved.protocol}`);
  }

  resolved.pathname = "/ws";
  return resolved.toString();
}

function defaultLifecycleHandlers(): Required<WsProtocolLifecycleHandlers> {
  return {
    isActive: () => true,
    onAttempt: (socketUrl) => {
      const safeSocketUrl = sanitizeWsSocketUrl(socketUrl);
      recordWsDiagnostic("socket-attempt", { socketUrl: safeSocketUrl });
      recordWsConnectionAttempt(safeSocketUrl);
    },
    onOpen: () => {
      recordWsDiagnostic("socket-open");
      recordWsConnectionOpened();
    },
    onError: (message) => {
      recordWsDiagnostic("socket-error", { message });
      clearAllTrackedRpcRequests();
      recordWsConnectionErrored(message);
    },
    onClose: (details) => {
      recordWsDiagnostic("socket-close", details);
      clearAllTrackedRpcRequests();
      recordWsConnectionClosed(details);
    },
    onProtocolConnected: () => undefined,
  };
}

function composeLifecycleHandlers(
  handlers?: WsProtocolLifecycleHandlers,
): Required<WsProtocolLifecycleHandlers> {
  const defaults = defaultLifecycleHandlers();
  const isActive = handlers?.isActive ?? (() => true);

  return {
    isActive,
    onAttempt: (socketUrl) => {
      if (!isActive()) {
        return;
      }
      defaults.onAttempt(socketUrl);
      handlers?.onAttempt?.(socketUrl);
    },
    onOpen: () => {
      if (!isActive()) {
        return;
      }
      defaults.onOpen();
      handlers?.onOpen?.();
    },
    onError: (message) => {
      if (!isActive()) {
        return;
      }
      defaults.onError(message);
      handlers?.onError?.(message);
    },
    onClose: (details) => {
      if (!isActive()) {
        return;
      }
      defaults.onClose(details);
      handlers?.onClose?.(details);
    },
    onProtocolConnected: () => {
      if (!isActive()) {
        return;
      }
      recordWsDiagnostic("protocol-connected");
      handlers?.onProtocolConnected?.();
    },
  };
}

export function createWsRpcProtocolLayer(
  url: WsRpcProtocolSocketUrlProvider,
  handlers?: WsProtocolLifecycleHandlers,
) {
  const lifecycle = composeLifecycleHandlers(handlers);
  const resolvedUrl =
    typeof url === "function"
      ? Effect.promise(() => url()).pipe(
          Effect.map((rawUrl) => resolveWsRpcSocketUrl(rawUrl)),
          Effect.tapError((error) =>
            Effect.sync(() => {
              lifecycle.onError(formatSocketErrorMessage(error));
            }),
          ),
          Effect.orDie,
        )
      : resolveWsRpcSocketUrl(url);

  const trackingWebSocketConstructorLayer = Layer.succeed(
    Socket.WebSocketConstructor,
    (socketUrl, protocols) => {
      lifecycle.onAttempt(socketUrl);
      const socket = new globalThis.WebSocket(socketUrl, protocols);

      socket.addEventListener(
        "open",
        () => {
          lifecycle.onOpen();
        },
        { once: true },
      );
      socket.addEventListener(
        "error",
        () => {
          lifecycle.onError("Unable to connect to the T3 server WebSocket.");
        },
        { once: true },
      );
      socket.addEventListener(
        "close",
        (event) => {
          lifecycle.onClose({
            code: event.code,
            reason: event.reason,
          });
        },
        { once: true },
      );

      return socket;
    },
  );
  const socketLayer = Socket.layerWebSocket(resolvedUrl).pipe(
    Layer.provide(trackingWebSocketConstructorLayer),
  );
  const retryPolicy = Schedule.addDelay(Schedule.recurs(WS_RECONNECT_MAX_RETRIES), (retryCount) =>
    Effect.succeed(Duration.millis(getWsReconnectDelayMsForRetry(retryCount) ?? 0)),
  );
  const protocolLayer = Layer.effect(
    RpcClient.Protocol,
    Effect.map(
      RpcClient.makeProtocolSocket({
        retryPolicy,
        retryTransientErrors: true,
      }),
      (protocol) => ({
        ...protocol,
        run: (clientId, writeResponse) =>
          protocol.run(clientId, (response) => {
            if (response._tag === "Chunk" || response._tag === "Exit") {
              acknowledgeRpcRequest(response.requestId);
            } else if (response._tag === "ClientProtocolError" || response._tag === "Defect") {
              clearAllTrackedRpcRequests();
            }
            return writeResponse(response);
          }),
        send: (clientId, request, transferables) => {
          if (request._tag === "Request") {
            trackRpcRequestSent(request.id, request.tag);
          }
          return protocol.send(clientId, request, transferables);
        },
      }),
    ),
  );

  const connectionHooksLayer = Layer.succeed(RpcClient.ConnectionHooks, {
    onConnect: Effect.sync(() => {
      lifecycle.onProtocolConnected();
    }),
    onDisconnect: Effect.void,
    onPingTimeout: Effect.sync(() => {
      recordWsDiagnostic("ping-timeout");
      lifecycle.onError(PING_TIMEOUT_ERROR_MESSAGE);
    }),
  });

  return protocolLayer.pipe(
    Layer.provide(Layer.mergeAll(socketLayer, RpcSerialization.layerJson, connectionHooksLayer)),
  );
}
