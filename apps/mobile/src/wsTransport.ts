import { WebSocketResponse, WsPush, WsResponse } from "@t3tools/contracts";
import { Cause, Schema } from "effect";

type PushListener = (data: unknown) => void;

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

export interface TransportStatus {
  readonly state: "connecting" | "connected" | "disconnected" | "error";
  readonly detail?: string;
  readonly reconnectInMs?: number;
}

interface WsRequestEnvelope {
  readonly id: string;
  readonly body: {
    readonly _tag: string;
    readonly [key: string]: unknown;
  };
}

const REQUEST_TIMEOUT_MS = 20_000;
const RECONNECT_DELAYS_MS = [500, 1_000, 2_000, 4_000, 8_000];
const decodeWsResponseFromJson = Schema.decodeUnknownExit(Schema.fromJsonString(WsResponse));
const isWsPushEnvelope = Schema.is(WsPush);
const isWebSocketResponseEnvelope = Schema.is(WebSocketResponse);

function websocketRawToString(raw: unknown): string | null {
  if (typeof raw === "string") {
    return raw;
  }

  if (raw instanceof ArrayBuffer) {
    return new TextDecoder().decode(raw);
  }

  if (ArrayBuffer.isView(raw)) {
    return new TextDecoder().decode(raw);
  }

  return null;
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
  private readonly onStatus?: (status: TransportStatus) => void;

  constructor(url: string, onStatus?: (status: TransportStatus) => void) {
    this.url = url;
    this.onStatus = onStatus;
    this.connect();
  }

  async request<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (method.length === 0) {
      throw new Error("Request method is required");
    }

    const id = String(this.nextId++);
    const body = params != null ? { ...params, _tag: method } : { _tag: method };
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
      channelListeners?.delete(listener);
      if (channelListeners && channelListeners.size === 0) {
        this.listeners.delete(channel);
      }
    };
  }

  dispose(): void {
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
    this.emitStatus({ state: "disconnected", detail: "Connection closed" });
  }

  private emitStatus(status: TransportStatus): void {
    this.onStatus?.(status);
  }

  private connect(): void {
    if (this.disposed) return;

    this.emitStatus({ state: "connecting" });

    const ws = new WebSocket(this.url);
    this.ws = ws;

    const handleOpen = () => {
      this.reconnectAttempt = 0;
      this.emitStatus({ state: "connected" });
    };

    const handleMessage = (event: MessageEvent) => {
      this.handleMessage(event.data);
    };

    const handleError = () => {
      this.emitStatus({ state: "error", detail: "WebSocket transport error" });
    };

    const handleClose = (event: CloseEvent) => {
      this.ws = null;
      const detail = event.reason || `Code ${event.code}`;
      this.emitStatus({ state: "disconnected", detail });
      this.scheduleReconnect(detail);
    };

    ws.addEventListener("open", handleOpen);
    ws.addEventListener("message", handleMessage);
    ws.addEventListener("error", handleError);
    ws.addEventListener("close", handleClose);
  }

  private handleMessage(raw: unknown): void {
    const messageText = websocketRawToString(raw);
    if (!messageText) {
      return;
    }

    const decoded = decodeWsResponseFromJson(messageText);
    if (decoded._tag === "Failure") {
      console.warn("Dropped inbound WebSocket envelope", {
        reason: "decode-failed",
        issue: Cause.pretty(decoded.cause),
      });
      return;
    }

    const message = decoded.value;

    if (isWsPushEnvelope(message)) {
      const channelListeners = this.listeners.get(message.channel);
      if (!channelListeners) return;

      for (const listener of channelListeners) {
        try {
          listener(message.data);
        } catch {
          // Swallow listener errors.
        }
      }
      return;
    }

    if (!isWebSocketResponseEnvelope(message)) {
      return;
    }

    const pending = this.pending.get(message.id);
    if (!pending) return;

    clearTimeout(pending.timeout);
    this.pending.delete(message.id);

    if (message.error) {
      pending.reject(new Error(message.error.message));
      return;
    }

    pending.resolve(message.result);
  }

  private send(message: WsRequestEnvelope): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
      return;
    }

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

    setTimeout(() => {
      clearInterval(check);
    }, REQUEST_TIMEOUT_MS);
  }

  private scheduleReconnect(detail: string): void {
    if (this.disposed || this.reconnectTimer !== null) return;

    const reconnectInMs =
      RECONNECT_DELAYS_MS[Math.min(this.reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)] ??
      RECONNECT_DELAYS_MS[0]!;

    this.reconnectAttempt += 1;

    this.emitStatus({
      state: "disconnected",
      detail,
      reconnectInMs,
    });

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, reconnectInMs);
  }
}
