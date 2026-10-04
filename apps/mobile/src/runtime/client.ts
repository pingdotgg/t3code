import type { ClientRequest, ServerMessage } from "../../../../packages/protocol/src/index.ts";

type WithoutId<T> = T extends { id: string } ? Omit<T, "id"> : never;
export type ConnectionState = "connecting" | "connected" | "disconnected";
export type Socket = Pick<WebSocket, "readyState" | "onopen" | "onmessage" | "onclose" | "onerror" | "send" | "close">;

export function connectionUrl(input: string): string {
  const url = new URL(input.trim());
  if (!['ws:', 'wss:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("Use a ws:// or wss:// address without credentials or query parameters");
  // The backend is local by design. This also prevents leaking the pairing credential.
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) throw new Error("Connect to the backend on this phone using 127.0.0.1");
  url.pathname = "/rpc";
  return url.toString();
}

/** Reconnects for snapshots, but never replays side-effecting requests. */
export class RuntimeClient {
  private options: { url: string; token: string; socket: (url: string, protocols: string[]) => Socket; onMessage: (message: ServerMessage) => void; onState: (state: ConnectionState) => void };
  private socket: Socket | null = null;
  private pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private sequence = 0;
  private stopped = true;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private retries = 0;
  constructor(options: RuntimeClient["options"]) {
    connectionUrl(options.url);
    if (!/^[a-f0-9]{64}$/.test(options.token.trim())) throw new Error("Paste the 64-character pairing credential from Termux");
    this.options = options;
  }
  connect() {
    this.stopped = false;
    if (this.socket) return;
    this.options.onState("connecting");
    const socket = this.options.socket(connectionUrl(this.options.url), ["t3mobile", `token.${this.options.token.trim()}`]);
    this.socket = socket;
    socket.onopen = () => { /* Ready only after the authoritative snapshot arrives. */ };
    socket.onmessage = (event) => {
      if (this.socket !== socket) return;
      try {
        const parsed: unknown = JSON.parse(String(event.data));
        if (!parsed || typeof parsed !== "object") throw new Error("Invalid backend response");
        const message = parsed as ServerMessage;
        if ("id" in message) {
          const p = this.pending.get(message.id);
          if (!p) return;
          clearTimeout(p.timer); this.pending.delete(message.id);
          if ("error" in message) p.reject(new Error(message.error));
          else p.resolve(message.result);
        } else {
          if (message.event === "snapshot") {
            if (!Array.isArray(message.sessions)) throw new Error("Invalid backend snapshot");
            this.retries = 0; this.options.onState("connected");
          }
          this.options.onMessage(message);
        }
      } catch { socket.close(); }
    };
    socket.onerror = () => { socket.close(); };
    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.rejectPending();
      this.options.onState("disconnected");
      if (!this.stopped && this.retries++ < 5) this.retry = setTimeout(() => { this.retry = null; this.connect(); }, 1500);
    };
  }
  request(input: WithoutId<ClientRequest>): Promise<unknown> {
    const socket = this.socket;
    if (!socket || socket.readyState !== 1) return Promise.reject(new Error("Backend is disconnected"));
    const id = String(++this.sequence);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error("Backend request timed out. Reconnect to check its outcome before retrying.")); }, 35_000);
      this.pending.set(id, { resolve, reject, timer });
      try { socket.send(JSON.stringify({ ...input, id })); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  disconnect() {
    this.stopped = true;
    if (this.retry) { clearTimeout(this.retry); this.retry = null; }
    const socket = this.socket; this.socket = null;
    if (socket) { socket.onclose = null; socket.onmessage = null; socket.close(); }
    this.rejectPending(); this.options.onState("disconnected");
  }
  private rejectPending() {
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error("Connection lost. Reconnect to check the request's outcome before retrying.")); }
    this.pending.clear();
  }
}
