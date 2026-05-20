import { WsRpcGroup } from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import { RpcClient, RpcSerialization } from "effect/unstable/rpc";
import * as Socket from "effect/unstable/socket/Socket";

import {
  DEFAULT_RECONNECT_BACKOFF,
  getReconnectDelayMs,
  type ReconnectBackoffConfig,
} from "./reconnectBackoff.ts";

export interface WsProtocolLifecycleHandlers {
  readonly getConnectionLabel?: () => string | null;
  readonly getVersionMismatchHint?: () => string | null;
  readonly onAttempt?: (socketUrl: string) => void;
  readonly onOpen?: () => void;
  readonly onError?: (message: string) => void;
  readonly onClose?: (details: { readonly code: number; readonly reason: string }) => void;
}

export interface WsRpcProtocolRequestTelemetry {
  readonly onRequestSent?: (requestId: string, tag: string) => void;
  readonly onRequestAcknowledged?: (requestId: string) => void;
  readonly onClearTrackedRequests?: () => void;
}

export interface WsRpcProtocolOptions {
  /** Backoff configuration for reconnect retries. */
  readonly backoff?: ReconnectBackoffConfig;
  /**
   * Invoked before user {@link WsProtocolLifecycleHandlers} for each socket lifecycle event.
   * Use for additive telemetry (connection state, clearing request trackers on disconnect).
   */
  readonly telemetryLifecycle?: WsProtocolLifecycleHandlers;
  /** Optional hooks around outbound requests and inbound RPC responses (latency tracking, etc.). */
  readonly requestTelemetry?: WsRpcProtocolRequestTelemetry;
}

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
    onAttempt: () => undefined,
    onOpen: () => undefined,
    onError: () => undefined,
    onClose: () => undefined,
    getConnectionLabel: () => null,
    getVersionMismatchHint: () => null,
  };
}

function resolveLifecycleHandlers(
  handlers: WsProtocolLifecycleHandlers | undefined,
  telemetryLifecycle: WsProtocolLifecycleHandlers | undefined,
): Required<WsProtocolLifecycleHandlers> {
  if (telemetryLifecycle === undefined) {
    return {
      ...defaultLifecycleHandlers(),
      ...handlers,
    };
  }

  return {
    getConnectionLabel: () =>
      handlers?.getConnectionLabel?.() ?? telemetryLifecycle.getConnectionLabel?.() ?? null,
    getVersionMismatchHint: () =>
      handlers?.getVersionMismatchHint?.() ?? telemetryLifecycle.getVersionMismatchHint?.() ?? null,
    onAttempt: (socketUrl) => {
      telemetryLifecycle.onAttempt?.(socketUrl);
      handlers?.onAttempt?.(socketUrl);
    },
    onOpen: () => {
      telemetryLifecycle.onOpen?.();
      handlers?.onOpen?.();
    },
    onError: (message) => {
      telemetryLifecycle.onError?.(message);
      handlers?.onError?.(message);
    },
    onClose: (details) => {
      telemetryLifecycle.onClose?.(details);
      handlers?.onClose?.(details);
    },
  };
}

export function createWsRpcProtocolLayer(
  url: WsRpcProtocolSocketUrlProvider,
  handlers?: WsProtocolLifecycleHandlers,
  options?: WsRpcProtocolOptions,
) {
  const lifecycle = resolveLifecycleHandlers(handlers, options?.telemetryLifecycle);
  const backoff = options?.backoff ?? DEFAULT_RECONNECT_BACKOFF;
  const requestTelemetry = options?.requestTelemetry;
  const instrumentRequests =
    requestTelemetry?.onRequestSent !== undefined ||
    requestTelemetry?.onRequestAcknowledged !== undefined ||
    requestTelemetry?.onClearTrackedRequests !== undefined;

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

  const baseSchedule =
    backoff.maxRetries === null ? Schedule.forever : Schedule.recurs(backoff.maxRetries);
  const retryPolicy = Schedule.addDelay(baseSchedule, (retryCount) =>
    Effect.succeed(Duration.millis(getReconnectDelayMs(retryCount, backoff) ?? 0)),
  );
  const protocolLayer = Layer.effect(
    RpcClient.Protocol,
    instrumentRequests
      ? Effect.map(
          RpcClient.makeProtocolSocket({
            retryPolicy,
            retryTransientErrors: true,
          }),
          (protocol) => ({
            ...protocol,
            run: (clientId, writeResponse) =>
              protocol.run(clientId, (response) => {
                if (response._tag === "Chunk" || response._tag === "Exit") {
                  requestTelemetry?.onRequestAcknowledged?.(response.requestId);
                } else if (response._tag === "ClientProtocolError" || response._tag === "Defect") {
                  requestTelemetry?.onClearTrackedRequests?.();
                }
                return writeResponse(response);
              }),
            send: (clientId, request, transferables) => {
              if (request._tag === "Request") {
                requestTelemetry?.onRequestSent?.(request.id, request.tag);
              }
              return protocol.send(clientId, request, transferables);
            },
          }),
        )
      : RpcClient.makeProtocolSocket({
          retryPolicy,
          retryTransientErrors: true,
        }),
  );

  return protocolLayer.pipe(Layer.provide(Layer.mergeAll(socketLayer, RpcSerialization.layerJson)));
}
