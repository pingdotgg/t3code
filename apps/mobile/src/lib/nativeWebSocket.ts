import { requireOptionalNativeModule } from "expo";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Socket from "effect/socket/Socket";
import { Platform } from "react-native";

// React Native's iOS WebSocket (SocketRocket) never offers permessage-deflate,
// so the server sends every frame uncompressed. URLSessionWebSocketTask offers
// it in the handshake. Android's OkHttp socket already negotiates it.

type NativeEventName = "onOpen" | "onMessage" | "onClose" | "onError";

interface NativeEventPayload {
  readonly id: number;
  readonly data?: string;
  readonly binary?: boolean;
  readonly code?: number;
  readonly reason?: string;
  readonly message?: string;
}

interface T3WebSocketNativeModule {
  connect(id: number, url: string, protocols: Array<string>): void;
  sendText(id: number, text: string): void;
  sendBinary(id: number, base64: string): void;
  close(id: number, code: number, reason: string): void;
  addListener(
    eventName: NativeEventName,
    listener: (payload: NativeEventPayload) => void,
  ): { remove(): void };
}

type EventType = "open" | "message" | "close" | "error";

interface ListenerEntry {
  readonly listener: (event: Socket.WebSocketEvent) => void;
  readonly once: boolean;
}

const CONNECTING = 0;
const OPEN = 1;
const CLOSING = 2;
const CLOSED = 3;

function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 8192) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 8192));
  }
  return btoa(binary);
}

class NativeWebSocket implements Socket.WebSocketLike {
  readyState = CONNECTING;
  private readonly listeners = new Map<EventType, Set<ListenerEntry>>();

  constructor(
    private readonly module: T3WebSocketNativeModule,
    private readonly id: number,
    private readonly onClosed: () => void,
  ) {}

  addEventListener(
    type: EventType,
    listener: (event: Socket.WebSocketEvent) => void,
    options?: { readonly once?: boolean },
  ): void {
    let entries = this.listeners.get(type);
    if (!entries) {
      entries = new Set();
      this.listeners.set(type, entries);
    }
    entries.add({ listener, once: options?.once === true });
  }

  removeEventListener(type: EventType, listener: (event: Socket.WebSocketEvent) => void): void {
    const entries = this.listeners.get(type);
    for (const entry of entries ?? []) {
      if (entry.listener === listener) entries?.delete(entry);
    }
  }

  send(data: string | Uint8Array<ArrayBuffer>): void {
    if (typeof data === "string") {
      this.module.sendText(this.id, data);
    } else {
      this.module.sendBinary(this.id, bytesToBase64(data));
    }
  }

  close(code?: number, reason?: string): void {
    if (this.readyState >= CLOSING) return;
    this.readyState = CLOSING;
    this.module.close(this.id, code ?? 1000, reason ?? "");
  }

  handle(eventName: NativeEventName, payload: NativeEventPayload): void {
    switch (eventName) {
      case "onOpen":
        // A close() while connecting leaves the native connect in flight, and
        // its open must not revive a socket the caller already gave up on.
        if (this.readyState !== CONNECTING) return;
        this.readyState = OPEN;
        this.dispatch("open", { type: "open" });
        return;
      case "onMessage": {
        if (this.readyState !== OPEN) return;
        const text = payload.data ?? "";
        const data = payload.binary === true ? base64ToBytes(text) : text;
        this.dispatch("message", { type: "message", data });
        return;
      }
      case "onError":
        this.dispatch("error", { type: "error", reason: payload.message ?? "WebSocket error" });
        return;
      case "onClose":
        if (this.readyState === CLOSED) return;
        this.readyState = CLOSED;
        this.onClosed();
        this.dispatch("close", {
          type: "close",
          code: payload.code ?? 1006,
          reason: payload.reason ?? "",
        });
        return;
    }
  }

  private dispatch(type: EventType, event: Socket.WebSocketEvent): void {
    for (const entry of this.listeners.get(type) ?? []) {
      if (entry.once) this.listeners.get(type)?.delete(entry);
      entry.listener(event);
    }
  }
}

// Fast Refresh can re-evaluate this module while URLSession tasks from the
// previous evaluation still report events, so ids keep counting across it.
const nextIdKey = Symbol.for("t3.mobile.native-websocket-next-id");

type NativeWebSocketGlobal = typeof globalThis & { [nextIdKey]?: number };

function allocateId(): number {
  const runtimeGlobal = globalThis as NativeWebSocketGlobal;
  const id = runtimeGlobal[nextIdKey] ?? 1;
  runtimeGlobal[nextIdKey] = id + 1;
  return id;
}

function layerNativeWebSocketConstructor(
  module: T3WebSocketNativeModule,
): Layer.Layer<Socket.WebSocketConstructor> {
  return Layer.effect(
    Socket.WebSocketConstructor,
    Effect.gen(function* () {
      const sockets = new Map<number, NativeWebSocket>();
      yield* Effect.acquireRelease(
        Effect.sync(() =>
          (["onOpen", "onMessage", "onClose", "onError"] as const).map((eventName) =>
            module.addListener(eventName, (payload) =>
              sockets.get(payload.id)?.handle(eventName, payload),
            ),
          ),
        ),
        (subscriptions) =>
          Effect.sync(() => {
            for (const subscription of subscriptions) subscription.remove();
            // Their native close can no longer reach them, so close them here.
            for (const [id, socket] of sockets) {
              socket.close(1001);
              socket.handle("onClose", { id, code: 1001 });
            }
          }),
      );

      return (url, options) => {
        if (options !== undefined && typeof options !== "string" && !Array.isArray(options)) {
          throw new TypeError("WebSocket client options are not supported by the iOS WebSocket");
        }
        const id = allocateId();
        const socket = new NativeWebSocket(module, id, () => sockets.delete(id));
        sockets.set(id, socket);
        try {
          module.connect(id, url, options === undefined ? [] : [options].flat());
        } catch (error) {
          sockets.delete(id);
          throw error;
        }
        return socket;
      };
    }),
  );
}

const nativeModule =
  Platform.OS === "ios"
    ? requireOptionalNativeModule<T3WebSocketNativeModule>("T3WebSocket")
    : null;

// iOS binaries built before the native module keep the global WebSocket.
export const layerWebSocketConstructor: Layer.Layer<Socket.WebSocketConstructor> =
  nativeModule === null
    ? Socket.layerWebSocketConstructorGlobal
    : layerNativeWebSocketConstructor(nativeModule);
