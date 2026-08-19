// @effect-diagnostics globalRandom:off globalTimers:off -- WebSocket callbacks own reconnect scheduling at this imperative adapter boundary.
import * as Result from "effect/Result";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import {
  decodeRelayTransportControlFrame,
  decodeRelayTransportFrame,
  encodeRelayTransportControlFrame,
  encodeRelayTransportFrame,
  encodeRelayTransportMessageFrames,
  normalizeRelayWebSocketCloseCode,
  RelayConnectorTicketResponse,
  RELAY_TRANSPORT_MAX_BUFFERED_MESSAGE_BYTES,
  RELAY_TRANSPORT_MAX_FRAME_PAYLOAD_BYTES,
  RELAY_TRANSPORT_MAX_HTTP_REQUEST_BYTES,
  RELAY_TRANSPORT_MAX_MESSAGE_BYTES,
  RelayTransportFrameKind,
  RelayTransportMessageAssembler,
} from "@t3tools/contracts/relayTransport";

export interface RelayConnectorSocket {
  binaryType: string;
  readonly readyState: number;
  send(data: string | ArrayBuffer | Uint8Array): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "open", listener: () => void): void;
  addEventListener(
    type: "close",
    listener: (event: { readonly code: number; readonly reason: string }) => void,
  ): void;
  addEventListener(
    type: "message",
    listener: (event: { readonly data: string | ArrayBuffer | Uint8Array }) => void,
  ): void;
}

export interface T3RelayConnectorConfig {
  readonly connectorUrl: string;
  readonly connectorToken: string;
  readonly originUrl: string;
}

export type T3RelayConnectorLifecycleEvent =
  | { readonly type: "connecting" }
  | { readonly type: "connected" }
  | {
      readonly type: "disconnected";
      readonly code: number;
      readonly reason: string;
    }
  | {
      readonly type: "retry_scheduled";
      readonly attempt: number;
      readonly delayMillis: number;
      readonly reason: string;
    };

export type T3RelayConnectorObserver = (event: T3RelayConnectorLifecycleEvent) => void;

export type RelayConnectorFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

interface PendingHttpRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: ReadonlyArray<readonly [string, string]>;
  readonly body: Array<Uint8Array>;
  bodyBytes: number;
}

interface RelayResponseWindow {
  creditBytes: number;
  readonly waiters: Set<() => void>;
}

interface PendingLocalWebSocketMessage {
  readonly text: boolean;
  readonly payload: Uint8Array;
}

const CONNECT_ATTEMPT_TIMEOUT_MILLIS = 15_000;
const MAX_PENDING_LOCAL_WEBSOCKET_MESSAGES = 1_024;

const CONNECTING = 0;
const OPEN = 1;
const decodeConnectorTicketResponse = Schema.decodeUnknownSync(RelayConnectorTicketResponse);

function validateConnectorConfig(config: T3RelayConnectorConfig): void {
  const connector = new URL(config.connectorUrl);
  if (
    connector.protocol !== "wss:" ||
    connector.username !== "" ||
    connector.password !== "" ||
    connector.pathname !== "/.well-known/t3-relay/connect" ||
    connector.hash !== ""
  ) {
    throw new TypeError("T3 relay connector URL must be a secure connector endpoint.");
  }
  const origin = new URL(config.originUrl);
  const hostname = origin.hostname.replace(/^\[(.*)\]$/u, "$1").toLowerCase();
  if (
    origin.protocol !== "http:" ||
    (hostname !== "127.0.0.1" && hostname !== "::1" && hostname !== "localhost")
  ) {
    throw new TypeError("T3 relay origin must be a loopback HTTP endpoint.");
  }
}

function asBytes(value: ArrayBuffer | Uint8Array): Uint8Array {
  return value instanceof Uint8Array ? value : new Uint8Array(value);
}

function closeSocket(socket: RelayConnectorSocket | null, code: number, reason: string): void {
  try {
    socket?.close(code, reason);
  } catch {
    // Closing a WebSocket in CONNECTING may throw. Teardown must continue.
  }
}

function localWebSocketUrl(originUrl: string, publicUrl: string): string {
  const origin = new URL(originUrl);
  const target = new URL(publicUrl);
  origin.protocol = origin.protocol === "https:" ? "wss:" : "ws:";
  origin.pathname = target.pathname;
  origin.search = target.search;
  origin.hash = "";
  return origin.toString();
}

function relayResponseHeaders(headers: Headers): ReadonlyArray<readonly [string, string]> {
  const hopByHop = new Set([
    "connection",
    "keep-alive",
    "proxy-connection",
    "transfer-encoding",
    "upgrade",
  ]);
  const forwarded = [...headers].filter(
    ([name]) => name.toLowerCase() !== "set-cookie" && !hopByHop.has(name.toLowerCase()),
  );
  for (const cookie of headers.getSetCookie()) {
    forwarded.push(["set-cookie", cookie]);
  }
  return forwarded;
}

export class T3RelayConnectorSession {
  readonly #config: T3RelayConnectorConfig;
  readonly #makeSocket: (url: string) => RelayConnectorSocket;
  readonly #fetch: RelayConnectorFetch;
  readonly #observer: T3RelayConnectorObserver;
  readonly #localSockets = new Map<number, RelayConnectorSocket>();
  readonly #pendingLocalMessages = new Map<number, Array<PendingLocalWebSocketMessage>>();
  readonly #httpRequests = new Map<number, PendingHttpRequest>();
  readonly #httpAbortControllers = new Map<number, AbortController>();
  readonly #responseWindows = new Map<number, RelayResponseWindow>();
  readonly #edgeMessages = new RelayTransportMessageAssembler();
  #pendingLocalMessageBytes = 0;
  #pendingLocalMessageCount = 0;
  #edgeSocket: RelayConnectorSocket | null = null;
  #edgeReady = false;
  #stopped = true;
  #connecting = false;
  #reconnectAttempt = 0;
  #reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  #connectAbortController: AbortController | null = null;
  readonly #handshakeTimers = new Set<ReturnType<typeof setTimeout>>();

  constructor(
    config: T3RelayConnectorConfig,
    makeSocket: (url: string) => RelayConnectorSocket = (url) => new WebSocket(url),
    fetcher: RelayConnectorFetch = fetch,
    observer: T3RelayConnectorObserver = () => undefined,
  ) {
    validateConnectorConfig(config);
    this.#config = config;
    this.#makeSocket = makeSocket;
    this.#fetch = fetcher;
    this.#observer = observer;
  }

  start(): void {
    this.#stopped = false;
    if (this.#edgeSocket !== null) {
      return;
    }
    void this.#connectEdge();
  }

  #observe(event: T3RelayConnectorLifecycleEvent): void {
    try {
      this.#observer(event);
    } catch {
      // Observability must never interrupt transport recovery.
    }
  }

  #scheduleReconnect(reason: string): void {
    if (this.#stopped || this.#reconnectTimer !== null) return;
    const baseDelay = Math.min(30_000, 500 * 2 ** this.#reconnectAttempt);
    this.#reconnectAttempt += 1;
    const delay = Math.round(baseDelay * (0.8 + Math.random() * 0.4));
    this.#observe({
      type: "retry_scheduled",
      attempt: this.#reconnectAttempt,
      delayMillis: delay,
      reason,
    });
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      if (!this.#stopped && this.#edgeSocket === null) void this.#connectEdge();
    }, delay);
  }

  async #connectEdge(): Promise<void> {
    if (this.#connecting || this.#stopped) return;
    this.#connecting = true;
    this.#observe({ type: "connecting" });
    const connectAbortController = new AbortController();
    this.#connectAbortController = connectAbortController;
    const ticketTimeout = setTimeout(
      () => connectAbortController.abort(new Error("Relay connector ticket request timed out.")),
      CONNECT_ATTEMPT_TIMEOUT_MILLIS,
    );
    let failureReason = "ticket_exchange_failed";
    try {
      const ticketUrl = new URL(this.#config.connectorUrl);
      ticketUrl.protocol = "https:";
      const ticketResponse = await this.#fetch(ticketUrl, {
        method: "POST",
        headers: { authorization: `Bearer ${this.#config.connectorToken}` },
        redirect: "error",
        signal: connectAbortController.signal,
      });
      clearTimeout(ticketTimeout);
      if (!ticketResponse.ok) {
        failureReason = `ticket_http_${ticketResponse.status}`;
        throw new Error(`Relay connector ticket request failed with ${ticketResponse.status}.`);
      }
      failureReason = "ticket_response_invalid";
      const { ticket } = decodeConnectorTicketResponse(await ticketResponse.json());
      if (this.#stopped) return;
      failureReason = "edge_socket_creation_failed";
      const connectorUrl = new URL(this.#config.connectorUrl);
      connectorUrl.searchParams.set("ticket", ticket);
      const edge = this.#makeSocket(connectorUrl.toString());
      const handshakeTimeout = setTimeout(() => {
        this.#handshakeTimers.delete(handshakeTimeout);
        if (this.#edgeSocket !== edge || this.#edgeReady) return;
        this.#edgeSocket = null;
        this.#edgeReady = false;
        closeSocket(edge, 1013, "Relay edge handshake timed out");
        this.#scheduleReconnect("edge_handshake_timeout");
      }, CONNECT_ATTEMPT_TIMEOUT_MILLIS);
      this.#handshakeTimers.add(handshakeTimeout);
      const clearHandshakeTimeout = () => {
        clearTimeout(handshakeTimeout);
        this.#handshakeTimers.delete(handshakeTimeout);
      };
      edge.binaryType = "arraybuffer";
      edge.addEventListener("message", (event) => {
        if (!this.#onEdgeMessage(edge, event.data) || this.#edgeReady) return;
        this.#edgeReady = true;
        clearHandshakeTimeout();
        this.#reconnectAttempt = 0;
        this.#observe({ type: "connected" });
      });
      edge.addEventListener("close", (event) => {
        clearHandshakeTimeout();
        if (this.#edgeSocket !== edge) return;
        this.#edgeSocket = null;
        this.#edgeReady = false;
        for (const local of this.#localSockets.values()) {
          closeSocket(local, 1012, "Relay edge disconnected");
        }
        this.#localSockets.clear();
        this.#clearPendingLocalMessages();
        this.#edgeMessages.clear();
        this.#httpRequests.clear();
        for (const controller of this.#httpAbortControllers.values()) controller.abort();
        this.#httpAbortControllers.clear();
        this.#clearResponseWindows();
        this.#observe({ type: "disconnected", code: event.code, reason: event.reason });
        this.#scheduleReconnect("edge_disconnected");
      });
      this.#edgeSocket = edge;
      this.#edgeReady = false;
    } catch {
      this.#scheduleReconnect(failureReason);
    } finally {
      clearTimeout(ticketTimeout);
      if (this.#connectAbortController === connectAbortController) {
        this.#connectAbortController = null;
      }
      this.#connecting = false;
    }
  }

  close(): void {
    this.#stopped = true;
    this.#connectAbortController?.abort(new Error("Connector stopped"));
    this.#connectAbortController = null;
    for (const timer of this.#handshakeTimers) clearTimeout(timer);
    this.#handshakeTimers.clear();
    if (this.#reconnectTimer !== null) {
      clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = null;
    }
    closeSocket(this.#edgeSocket, 1000, "Connector stopped");
    this.#edgeSocket = null;
    this.#edgeReady = false;
    for (const local of this.#localSockets.values()) {
      closeSocket(local, 1001, "Connector stopped");
    }
    this.#localSockets.clear();
    this.#clearPendingLocalMessages();
    this.#edgeMessages.clear();
    this.#httpRequests.clear();
    for (const controller of this.#httpAbortControllers.values()) controller.abort();
    this.#httpAbortControllers.clear();
    this.#clearResponseWindows();
  }

  #sendEdge(data: Uint8Array): void {
    if (this.#edgeSocket?.readyState === OPEN) {
      this.#edgeSocket.send(data);
    }
  }

  #clearResponseWindows(): void {
    for (const window of this.#responseWindows.values()) {
      for (const wake of window.waiters) wake();
    }
    this.#responseWindows.clear();
  }

  #deletePendingLocalMessages(streamId: number): void {
    const messages = this.#pendingLocalMessages.get(streamId);
    if (messages === undefined) return;
    for (const message of messages) this.#pendingLocalMessageBytes -= message.payload.byteLength;
    this.#pendingLocalMessageCount -= messages.length;
    this.#pendingLocalMessages.delete(streamId);
  }

  #clearPendingLocalMessages(): void {
    this.#pendingLocalMessages.clear();
    this.#pendingLocalMessageBytes = 0;
    this.#pendingLocalMessageCount = 0;
  }

  #bufferPendingLocalMessage(streamId: number, message: PendingLocalWebSocketMessage): boolean {
    if (
      this.#pendingLocalMessageBytes + message.payload.byteLength >
        RELAY_TRANSPORT_MAX_BUFFERED_MESSAGE_BYTES ||
      this.#pendingLocalMessageCount >= MAX_PENDING_LOCAL_WEBSOCKET_MESSAGES
    ) {
      return false;
    }
    const messages = this.#pendingLocalMessages.get(streamId) ?? [];
    messages.push(message);
    this.#pendingLocalMessages.set(streamId, messages);
    this.#pendingLocalMessageBytes += message.payload.byteLength;
    this.#pendingLocalMessageCount += 1;
    return true;
  }

  #sendLocalMessage(local: RelayConnectorSocket, message: PendingLocalWebSocketMessage): void {
    local.send(message.text ? new TextDecoder().decode(message.payload) : message.payload);
  }

  #flushPendingLocalMessages(streamId: number, local: RelayConnectorSocket): void {
    const messages = this.#pendingLocalMessages.get(streamId) ?? [];
    this.#deletePendingLocalMessages(streamId);
    try {
      for (const message of messages) this.#sendLocalMessage(local, message);
    } catch {
      closeSocket(local, 1011, "Failed to forward buffered WebSocket messages");
    }
  }

  async #takeResponseCredit(
    streamId: number,
    byteLength: number,
    signal: AbortSignal,
  ): Promise<void> {
    for (;;) {
      if (signal.aborted) throw signal.reason;
      const window = this.#responseWindows.get(streamId);
      if (window === undefined) throw new Error("Relay response window closed.");
      if (window.creditBytes >= byteLength) {
        window.creditBytes -= byteLength;
        return;
      }
      await new Promise<void>((resolve, reject) => {
        const wake = () => {
          signal.removeEventListener("abort", abort);
          window.waiters.delete(wake);
          resolve();
        };
        const abort = () => {
          window.waiters.delete(wake);
          reject(signal.reason);
        };
        window.waiters.add(wake);
        signal.addEventListener("abort", abort, { once: true });
      });
    }
  }

  #openLocal(streamId: number, publicUrl: string): void {
    if (this.#localSockets.has(streamId)) {
      return;
    }
    let local: RelayConnectorSocket;
    try {
      local = this.#makeSocket(localWebSocketUrl(this.#config.originUrl, publicUrl));
    } catch (cause) {
      this.#sendEdge(
        encodeRelayTransportControlFrame(streamId, {
          type: "websocket_reject",
          status: 502,
          reason: cause instanceof Error ? cause.message : "Invalid local WebSocket URL",
        }),
      );
      return;
    }
    local.binaryType = "arraybuffer";
    this.#localSockets.set(streamId, local);
    local.addEventListener("open", () => {
      if (this.#localSockets.get(streamId) !== local) return;
      this.#sendEdge(encodeRelayTransportControlFrame(streamId, { type: "websocket_accept" }));
      this.#flushPendingLocalMessages(streamId, local);
    });
    local.addEventListener("message", (event) => {
      const text = typeof event.data === "string";
      const payload = text ? new TextEncoder().encode(event.data) : asBytes(event.data);
      try {
        for (const frame of encodeRelayTransportMessageFrames({
          kind: text
            ? RelayTransportFrameKind.websocketText
            : RelayTransportFrameKind.websocketBinary,
          streamId,
          payload,
        })) {
          this.#sendEdge(frame);
        }
      } catch {
        closeSocket(local, 1009, "WebSocket message exceeds the relay limit");
      }
    });
    local.addEventListener("close", (event) => {
      if (this.#localSockets.get(streamId) !== local) return;
      this.#localSockets.delete(streamId);
      this.#deletePendingLocalMessages(streamId);
      this.#edgeMessages.delete(streamId);
      this.#sendEdge(
        encodeRelayTransportControlFrame(streamId, {
          type: "websocket_close",
          code: normalizeRelayWebSocketCloseCode(event.code),
          reason: event.reason,
        }),
      );
    });
  }

  async #dispatchHttp(streamId: number, request: PendingHttpRequest): Promise<void> {
    this.#httpRequests.delete(streamId);
    const abortController = new AbortController();
    this.#httpAbortControllers.set(streamId, abortController);
    this.#responseWindows.set(streamId, { creditBytes: 0, waiters: new Set() });
    try {
      const localUrl = new URL(this.#config.originUrl);
      const publicUrl = new URL(request.url);
      localUrl.pathname = publicUrl.pathname;
      localUrl.search = publicUrl.search;
      const headers = new Headers();
      for (const [name, value] of request.headers) {
        headers.append(name, value);
      }
      for (const name of [
        "connection",
        "content-length",
        "host",
        "keep-alive",
        "proxy-connection",
        "transfer-encoding",
        "upgrade",
        "x-t3-relay-connection-role",
      ]) {
        headers.delete(name);
      }
      const body = request.body.length === 0 ? undefined : new Blob(request.body);
      const response = await this.#fetch(localUrl, {
        method: request.method,
        headers,
        ...(body === undefined ? {} : { body }),
        redirect: "manual",
        signal: abortController.signal,
      });
      if (this.#httpAbortControllers.get(streamId) !== abortController) return;
      const responseHeaders = relayResponseHeaders(response.headers);
      this.#sendEdge(
        encodeRelayTransportControlFrame(streamId, {
          type: "http_response_start",
          status: response.status,
          headers: responseHeaders,
        }),
      );
      if (response.body !== null) {
        const reader = response.body.getReader();
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          if (this.#httpAbortControllers.get(streamId) !== abortController) return;
          for (
            let offset = 0;
            offset < chunk.value.byteLength;
            offset += RELAY_TRANSPORT_MAX_FRAME_PAYLOAD_BYTES
          ) {
            const payload = chunk.value.subarray(
              offset,
              offset + RELAY_TRANSPORT_MAX_FRAME_PAYLOAD_BYTES,
            );
            await this.#takeResponseCredit(streamId, payload.byteLength, abortController.signal);
            this.#sendEdge(
              encodeRelayTransportFrame({
                kind: RelayTransportFrameKind.httpResponseBody,
                streamId,
                endOfMessage: false,
                payload,
              }),
            );
          }
        }
      }
      if (this.#httpAbortControllers.get(streamId) !== abortController) return;
      this.#sendEdge(encodeRelayTransportControlFrame(streamId, { type: "http_response_end" }));
    } catch (cause) {
      if (this.#httpAbortControllers.get(streamId) === abortController) {
        this.#sendEdge(
          encodeRelayTransportControlFrame(streamId, {
            type: "http_response_abort",
            reason: cause instanceof Error ? cause.message : "Local HTTP request failed",
          }),
        );
      }
    } finally {
      if (this.#httpAbortControllers.get(streamId) === abortController) {
        this.#httpAbortControllers.delete(streamId);
      }
      const window = this.#responseWindows.get(streamId);
      this.#responseWindows.delete(streamId);
      if (window !== undefined) for (const wake of window.waiters) wake();
    }
  }

  #onEdgeMessage(edge: RelayConnectorSocket, message: string | ArrayBuffer | Uint8Array): boolean {
    if (this.#edgeSocket !== edge) return false;
    if (typeof message === "string") {
      return false;
    }
    const decoded = decodeRelayTransportFrame(asBytes(message));
    if (Result.isFailure(decoded)) {
      return false;
    }
    const frame = decoded.success;
    if (frame.kind === RelayTransportFrameKind.control) {
      const control = decodeRelayTransportControlFrame(frame);
      if (Result.isFailure(control)) {
        return false;
      }
      if (frame.streamId === 0) return control.success.type === "connector_ready";
      if (!this.#edgeReady) return false;
      if (control.success.type === "websocket_open") {
        this.#openLocal(frame.streamId, control.success.url);
      } else if (control.success.type === "websocket_close") {
        const local = this.#localSockets.get(frame.streamId);
        this.#localSockets.delete(frame.streamId);
        this.#deletePendingLocalMessages(frame.streamId);
        this.#edgeMessages.delete(frame.streamId);
        closeSocket(local ?? null, control.success.code, control.success.reason);
      } else if (control.success.type === "http_request_start") {
        this.#httpRequests.set(frame.streamId, {
          method: control.success.method,
          url: control.success.url,
          headers: control.success.headers,
          body: [],
          bodyBytes: 0,
        });
      } else if (control.success.type === "http_request_end") {
        const request = this.#httpRequests.get(frame.streamId);
        if (request !== undefined) {
          void this.#dispatchHttp(frame.streamId, request);
        }
      } else if (control.success.type === "http_request_abort") {
        this.#httpRequests.delete(frame.streamId);
        this.#httpAbortControllers.get(frame.streamId)?.abort();
        this.#httpAbortControllers.delete(frame.streamId);
      } else if (control.success.type === "window_update") {
        const window = this.#responseWindows.get(frame.streamId);
        if (window !== undefined) {
          window.creditBytes = Math.min(
            RELAY_TRANSPORT_MAX_MESSAGE_BYTES,
            window.creditBytes + control.success.creditBytes,
          );
          for (const wake of window.waiters) wake();
        }
      }
      return false;
    }

    if (!this.#edgeReady) return false;

    if (frame.kind === RelayTransportFrameKind.httpRequestBody) {
      const request = this.#httpRequests.get(frame.streamId);
      if (request !== undefined) {
        if (request.bodyBytes + frame.payload.byteLength > RELAY_TRANSPORT_MAX_HTTP_REQUEST_BYTES) {
          this.#httpRequests.delete(frame.streamId);
          this.#sendEdge(
            encodeRelayTransportControlFrame(frame.streamId, {
              type: "http_response_abort",
              reason: "HTTP request body exceeds the relay limit",
            }),
          );
          return false;
        }
        request.bodyBytes += frame.payload.byteLength;
        request.body.push(frame.payload.slice());
      }
      return false;
    }

    if (
      frame.kind === RelayTransportFrameKind.websocketText ||
      frame.kind === RelayTransportFrameKind.websocketBinary
    ) {
      const local = this.#localSockets.get(frame.streamId);
      if (local === undefined) return false;
      try {
        const message = this.#edgeMessages.append(frame);
        if (message === null) return false;
        const pending = {
          text: message.kind === RelayTransportFrameKind.websocketText,
          payload: message.payload,
        } satisfies PendingLocalWebSocketMessage;
        if (local.readyState === OPEN) {
          this.#sendLocalMessage(local, pending);
        } else if (
          local.readyState === CONNECTING &&
          !this.#bufferPendingLocalMessage(frame.streamId, pending)
        ) {
          this.#deletePendingLocalMessages(frame.streamId);
          closeSocket(local, 1009, "Buffered WebSocket messages exceed the relay limit");
        }
      } catch {
        this.#edgeMessages.delete(frame.streamId);
        this.#deletePendingLocalMessages(frame.streamId);
        closeSocket(local, 1009, "Invalid fragmented relay message");
      }
    }
    return false;
  }
}

export class T3RelayConnectorFactory extends Context.Service<
  T3RelayConnectorFactory,
  {
    readonly make: (
      config: T3RelayConnectorConfig,
      observer?: T3RelayConnectorObserver,
    ) => T3RelayConnectorSession;
  }
>()("t3/cloud/T3RelayConnector/T3RelayConnectorFactory") {}

export const layer = Layer.succeed(
  T3RelayConnectorFactory,
  T3RelayConnectorFactory.of({
    make: (config, observer) => new T3RelayConnectorSession(config, undefined, undefined, observer),
  }),
);
