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
  readonly isCloseIntentional?: () => boolean;
  readonly isActive?: () => boolean;
  readonly onAttempt?: (socketUrl: string) => void;
  readonly onOpen?: () => void;
  readonly onHeartbeatPing?: () => void;
  readonly onHeartbeatPong?: () => void;
  readonly onHeartbeatTimeout?: () => void;
  readonly onRequestStart?: (info: {
    readonly id: string;
    readonly tag: string;
    readonly stream: boolean;
  }) => void;
  readonly onRequestChunk?: (info: {
    readonly id: string;
    readonly tag: string;
    readonly chunkCount: number;
  }) => void;
  readonly onRequestExit?: (info: {
    readonly id: string;
    readonly tag: string;
    readonly stream: boolean;
  }) => void;
  readonly onRequestInterrupt?: (info: { readonly id: string; readonly tag?: string }) => void;
  readonly onError?: (message: string) => void;
  readonly onClose?: (
    details: { readonly code: number; readonly reason: string },
    context: { readonly intentional: boolean },
  ) => void;
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

type ResolvedLifecycleHandlers = Required<
  Pick<
    WsProtocolLifecycleHandlers,
    | "getConnectionLabel"
    | "getVersionMismatchHint"
    | "isCloseIntentional"
    | "isActive"
    | "onAttempt"
    | "onOpen"
    | "onHeartbeatPing"
    | "onHeartbeatPong"
    | "onHeartbeatTimeout"
    | "onError"
    | "onClose"
  >
>;

function defaultLifecycleHandlers(): ResolvedLifecycleHandlers {
  return {
    onAttempt: () => undefined,
    onOpen: () => undefined,
    onHeartbeatPing: () => undefined,
    onHeartbeatPong: () => undefined,
    onHeartbeatTimeout: () => undefined,
    onError: () => undefined,
    onClose: () => undefined,
    getConnectionLabel: () => null,
    getVersionMismatchHint: () => null,
    isCloseIntentional: () => false,
    isActive: () => true,
  };
}

function resolveLifecycleHandlers(
  handlers: WsProtocolLifecycleHandlers | undefined,
  telemetryLifecycle: WsProtocolLifecycleHandlers | undefined,
): ResolvedLifecycleHandlers {
  const defaults = defaultLifecycleHandlers();
  const isActive = handlers?.isActive ?? telemetryLifecycle?.isActive ?? defaults.isActive;
  const isCloseIntentional =
    handlers?.isCloseIntentional ??
    telemetryLifecycle?.isCloseIntentional ??
    defaults.isCloseIntentional;

  return {
    getConnectionLabel: () =>
      handlers?.getConnectionLabel?.() ?? telemetryLifecycle?.getConnectionLabel?.() ?? null,
    getVersionMismatchHint: () =>
      handlers?.getVersionMismatchHint?.() ??
      telemetryLifecycle?.getVersionMismatchHint?.() ??
      null,
    isActive,
    isCloseIntentional,
    onAttempt: (socketUrl) => {
      if (!isActive()) {
        return;
      }
      telemetryLifecycle?.onAttempt?.(socketUrl);
      handlers?.onAttempt?.(socketUrl);
    },
    onOpen: () => {
      if (!isActive()) {
        return;
      }
      telemetryLifecycle?.onOpen?.();
      handlers?.onOpen?.();
    },
    onHeartbeatPing: () => {
      if (!isActive()) {
        return;
      }
      telemetryLifecycle?.onHeartbeatPing?.();
      handlers?.onHeartbeatPing?.();
    },
    onHeartbeatPong: () => {
      if (!isActive()) {
        return;
      }
      telemetryLifecycle?.onHeartbeatPong?.();
      handlers?.onHeartbeatPong?.();
    },
    onHeartbeatTimeout: () => {
      if (!isActive()) {
        return;
      }
      telemetryLifecycle?.onHeartbeatTimeout?.();
      handlers?.onHeartbeatTimeout?.();
    },
    onError: (message) => {
      if (!isActive()) {
        return;
      }
      telemetryLifecycle?.onError?.(message);
      handlers?.onError?.(message);
    },
    onClose: (details, context) => {
      if (!isActive()) {
        return;
      }
      telemetryLifecycle?.onClose?.(details, context);
      handlers?.onClose?.(details, context);
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
          lifecycle.onClose(
            {
              code: event.code,
              reason: event.reason,
            },
            {
              intentional: lifecycle.isCloseIntentional(),
            },
          );
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
  const requestHooksLayer = Layer.succeed(
    RpcClient.RequestHooks,
    RpcClient.RequestHooks.of({
      onRequestStart: (info) =>
        Effect.sync(() => {
          if (!lifecycle.isActive()) {
            return;
          }
          handlers?.onRequestStart?.({
            id: String(info.id),
            tag: info.tag,
            stream: info.stream,
          });
        }),
      onRequestChunk: (info) =>
        Effect.sync(() => {
          if (!lifecycle.isActive()) {
            return;
          }
          handlers?.onRequestChunk?.({
            id: String(info.id),
            tag: info.tag,
            chunkCount: info.chunkCount,
          });
        }),
      onRequestExit: (info) =>
        Effect.sync(() => {
          if (!lifecycle.isActive()) {
            return;
          }
          handlers?.onRequestExit?.({
            id: String(info.id),
            tag: info.tag,
            stream: info.stream,
          });
        }),
      onRequestInterrupt: (info) =>
        Effect.sync(() => {
          if (!lifecycle.isActive()) {
            return;
          }
          handlers?.onRequestInterrupt?.({
            id: String(info.id),
            ...(info.tag === undefined ? {} : { tag: info.tag }),
          });
        }),
    }),
  );
  const connectionHooksLayer = Layer.succeed(
    RpcClient.ConnectionHooks,
    RpcClient.ConnectionHooks.of({
      onConnect: Effect.void,
      onDisconnect: Effect.void,
      onPing: Effect.sync(() => {
        lifecycle.onHeartbeatPing();
      }),
      onPong: Effect.sync(() => {
        lifecycle.onHeartbeatPong();
      }),
      onPingTimeout: Effect.sync(() => {
        requestTelemetry?.onClearTrackedRequests?.();
        lifecycle.onHeartbeatTimeout();
      }),
    }),
  );

  return Layer.mergeAll(
    protocolLayer.pipe(
      Layer.provide(Layer.mergeAll(socketLayer, RpcSerialization.layerJson, connectionHooksLayer)),
    ),
    requestHooksLayer,
    connectionHooksLayer,
  );
}
