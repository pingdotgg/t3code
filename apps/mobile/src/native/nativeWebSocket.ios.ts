import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Socket from "effect/socket/Socket";
import { requireOptionalNativeModule } from "expo";

type EventType = "open" | "message" | "error" | "close";

interface NativeEvents {
  readonly open: { readonly id: number };
  readonly message: { readonly id: number; readonly text?: string; readonly data?: Uint8Array };
  readonly error: { readonly id: number; readonly message: string };
  readonly close: {
    readonly id: number;
    readonly code: number;
    readonly reason: string;
    readonly wasClean: boolean;
  };
}

export interface NativeModule {
  connect(url: string, protocols: ReadonlyArray<string>): number;
  sendText(id: number, text: string): void;
  sendBinary(id: number, bytes: Uint8Array): void;
  close(id: number, code: number, reason: string): void;
  addListener<K extends keyof NativeEvents>(
    event: K,
    listener: (event: NativeEvents[K]) => void,
  ): { remove(): void };
}

interface Listener {
  readonly listener: (event: Socket.WebSocketEvent) => void;
  readonly once: boolean;
}

/** Subset of the WHATWG WebSocket API that Effect's socket layer touches, over the native module. */
export class Connection implements Socket.WebSocketLike {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readonly url: string;
  readyState: number = Connection.CONNECTING;

  readonly #id: number;
  readonly #sockets: Sockets;
  readonly #listeners = new Map<EventType, Array<Listener>>();

  constructor(sockets: Sockets, url: string, protocols?: string | ReadonlyArray<string>) {
    this.url = url;
    this.#sockets = sockets;
    this.#id = sockets.native.connect(
      url,
      protocols === undefined ? [] : typeof protocols === "string" ? [protocols] : protocols,
    );
    sockets.register(this.#id, this);
  }

  addEventListener(
    type: EventType,
    listener: (event: Socket.WebSocketEvent) => void,
    options?: { readonly once?: boolean },
  ): void {
    const entries = this.#listeners.get(type) ?? [];
    if (entries.some((entry) => entry.listener === listener)) return;
    entries.push({ listener, once: options?.once === true });
    this.#listeners.set(type, entries);
  }

  removeEventListener(type: EventType, listener: (event: Socket.WebSocketEvent) => void): void {
    const entries = this.#listeners.get(type);
    if (entries === undefined) return;
    this.#listeners.set(
      type,
      entries.filter((entry) => entry.listener !== listener),
    );
  }

  send(data: string | Uint8Array<ArrayBuffer>): void {
    if (this.readyState === Connection.CONNECTING) {
      throw new Error("InvalidStateError: WebSocket is still connecting");
    }
    // Browsers drop writes after close instead of throwing.
    if (this.readyState !== Connection.OPEN) return;
    if (typeof data === "string") {
      this.#sockets.native.sendText(this.#id, data);
    } else {
      this.#sockets.native.sendBinary(this.#id, data);
    }
  }

  close(code = 1000, reason = ""): void {
    if (this.readyState >= Connection.CLOSING) return;
    this.readyState = Connection.CLOSING;
    this.#sockets.native.close(this.#id, code, reason);
  }

  handleOpen(_event: NativeEvents["open"]): void {
    if (this.readyState !== Connection.CONNECTING) return;
    this.readyState = Connection.OPEN;
    this.#dispatch("open", { type: "open" });
  }

  handleMessage(event: NativeEvents["message"]): void {
    if (this.readyState !== Connection.OPEN) return;
    this.#dispatch("message", { type: "message", data: event.text ?? event.data });
  }

  handleError(event: NativeEvents["error"]): void {
    if (this.readyState === Connection.CLOSED) return;
    this.#dispatch("error", { type: "error", message: event.message });
  }

  handleClose(event: NativeEvents["close"]): void {
    if (this.readyState === Connection.CLOSED) return;
    this.readyState = Connection.CLOSED;
    this.#sockets.unregister(this.#id);
    this.#dispatch("close", {
      type: "close",
      code: event.code,
      reason: event.reason,
      wasClean: event.wasClean,
    });
  }

  #dispatch(type: EventType, event: Socket.WebSocketEvent & Record<string, unknown>): void {
    const entries = this.#listeners.get(type);
    if (entries === undefined || entries.length === 0) return;
    this.#listeners.set(
      type,
      entries.filter((entry) => !entry.once),
    );
    for (const entry of entries) entry.listener(event);
  }
}

/** Routes the module's per-id events to the sockets that own them. Native assigns the ids, so a reload cannot reuse one. */
export class Sockets {
  readonly native: NativeModule;
  readonly #open = new Map<number, Connection>();
  readonly #subscriptions: ReadonlyArray<{ remove(): void }>;

  constructor(native: NativeModule) {
    this.native = native;
    this.#subscriptions = [
      native.addListener("open", (event) => this.#open.get(event.id)?.handleOpen(event)),
      native.addListener("message", (event) => this.#open.get(event.id)?.handleMessage(event)),
      native.addListener("error", (event) => this.#open.get(event.id)?.handleError(event)),
      native.addListener("close", (event) => this.#open.get(event.id)?.handleClose(event)),
    ];
  }

  register(id: number, socket: Connection): void {
    this.#open.set(id, socket);
  }

  unregister(id: number): void {
    this.#open.delete(id);
  }

  dispose(): void {
    for (const subscription of this.#subscriptions) subscription.remove();
    for (const socket of this.#open.values()) {
      socket.close(1001);
      socket.handleClose({ id: 0, code: 1001, reason: "", wasClean: false });
    }
  }
}

function layerFromModule(native: NativeModule): Layer.Layer<Socket.WebSocketConstructor> {
  return Layer.effect(
    Socket.WebSocketConstructor,
    Effect.map(
      Effect.acquireRelease(
        Effect.sync(() => new Sockets(native)),
        (sockets) => Effect.sync(() => sockets.dispose()),
      ),
      (sockets) => (url, options) => {
        if (options !== undefined && typeof options !== "string" && !Array.isArray(options)) {
          throw new TypeError("WebSocket client options are not supported by the native WebSocket");
        }
        return new Connection(sockets, url, options);
      },
    ),
  );
}

const native = requireOptionalNativeModule<NativeModule>("T3WebSocket");

// A dev client built before this module shipped still has SocketRocket.
export const layer: Layer.Layer<Socket.WebSocketConstructor> =
  native === null ? Socket.layerWebSocketConstructorGlobal : layerFromModule(native);
