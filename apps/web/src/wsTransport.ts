import { WebSocketResponse, WsPush, WsResponse } from "@t3tools/contracts";
import { Cause, Schema } from "effect";

type PushListener = (data: unknown) => void;

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

const REQUEST_TIMEOUT_MS = 60_000;
const RECONNECT_DELAYS_MS = [500, 1_000, 2_000, 4_000, 8_000];
const decodeWsResponseFromJson = Schema.decodeUnknownExit(Schema.fromJsonString(WsResponse));
const isWsPushEnvelope = Schema.is(WsPush);
const isWebSocketResponseEnvelope = Schema.is(WebSocketResponse);

interface WsRequestEnvelope {
  id: string;
  body: {
    _tag: string;
    [key: string]: unknown;
  };
}

export class WsTransport {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly listeners = new Map<string, Set<PushListener>>();
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private readonly url: string;

  constructor(url?: string) {
    const bridgeUrl = window.desktopBridge?.getWsUrl();
    // In dev mode, VITE_WS_URL points to the server's WebSocket endpoint.
    // In production, the page is served by the WS server on the same host:port.
    const envUrl = import.meta.env.VITE_WS_URL as string | undefined;
    this.url =
      url ??
      (bridgeUrl && bridgeUrl.length > 0
        ? bridgeUrl
        : envUrl && envUrl.length > 0
          ? envUrl
          : `ws://${window.location.hostname}:${window.location.port}`);
    this.connect();
  }

  async request<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (typeof method !== "string" || method.length === 0) {
      throw new Error("Request method is required");
    }
    const id = String(this.nextId++);
    const body =
      params !== undefined
        ? { _tag: method, ...(params as Record<string, unknown>) }
        : { _tag: method };
    const message: WsRequestEnvelope = { id, body };

    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Request timed out: ${method}`));
      }, REQUEST_TIMEOUT_MS);

      this.pending.set(id, {
        resolve: resolve as (result: unknown) => void,
        reject,
        timeout,
      });

      this.send(message);
    });
  }

  subscribe(channel: string, listener: PushListener): () => void {
    let channelListeners = this.listeners.get(channel);
    if (!channelListeners) {
      channelListeners = new Set();
      this.listeners.set(channel, channelListeners);
    }
    channelListeners.add(listener);

    return () => {
      channelListeners!.delete(listener);
      if (channelListeners!.size === 0) {
        this.listeners.delete(channel);
      }
    };
  }

  dispose() {
    this.disposed = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("Transport disposed"));
    }
    this.pending.clear();
    this.ws?.close();
    this.ws = null;
  }

  private connect() {
    if (this.disposed) return;

    const ws = new WebSocket(this.url);

    ws.addEventListener("open", () => {
      this.ws = ws;
      this.reconnectAttempt = 0;
    });

    ws.addEventListener("message", (event) => {
      this.handleMessage(event.data);
    });

    ws.addEventListener("close", () => {
      this.ws = null;
      this.scheduleReconnect();
    });

    ws.addEventListener("error", () => {
      // close event will fire after error
    });
  }

  private handleMessage(raw: unknown) {
    const exit = decodeWsResponseFromJson(raw);
    if (exit._tag === "Failure") {
      console.warn("Dropped inbound WebSocket envelope", {
        reason: "decode-failed",
        raw,
        issue: Cause.pretty(exit.cause),
      });
      return;
    }
    const message = exit.value;

    // Push event
    if (isWsPushEnvelope(message)) {
      const channelListeners = this.listeners.get(message.channel);
      if (channelListeners) {
        for (const listener of channelListeners) {
          try {
            listener(message.data);
          } catch {
            // Swallow listener errors
          }
        }
      }
      return;
    }

    // Response to a request
    if (!isWebSocketResponseEnvelope(message)) {
      return;
    }

    const pending = this.pending.get(message.id);
    if (!pending) return;

    clearTimeout(pending.timeout);
    this.pending.delete(message.id);

    if (message.error) {
      pending.reject(new Error(message.error.message));
    } else {
      pending.resolve(message.result);
    }
  }

  private send(message: WsRequestEnvelope) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
      return;
    }

    // If not connected, wait for connection
    const waitForOpen = () => {
      const check = setInterval(() => {
        if (this.disposed) {
          clearInterval(check);
          return;
        }
        if (this.ws?.readyState === WebSocket.OPEN) {
          clearInterval(check);
          this.ws.send(JSON.stringify(message));
        }
      }, 50);

      // Give up after timeout (the pending request will time out on its own)
      setTimeout(() => clearInterval(check), REQUEST_TIMEOUT_MS);
    };
    waitForOpen();
  }

  private scheduleReconnect() {
    if (this.disposed) return;

    const delay =
      RECONNECT_DELAYS_MS[Math.min(this.reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)] ??
      RECONNECT_DELAYS_MS[0]!;

    this.reconnectAttempt++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }
}
