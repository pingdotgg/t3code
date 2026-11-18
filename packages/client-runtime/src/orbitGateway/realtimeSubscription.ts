// @effect-diagnostics globalTimers:off -- The socket handshake owns a native timeout, covered with fake-time tests.
import type { OrbitGatewayTransport } from "./client.ts";

export function realtimeObject(value: unknown): Record<string, unknown> | null {
  if (typeof value === "string") {
    try {
      return realtimeObject(JSON.parse(value));
    } catch {
      return null;
    }
  }
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export interface OrbitRealtimeSocket {
  send(data: string): void;
  close(): void;
  addEventListener(event: "message", listener: (event: MessageEvent) => void): void;
  addEventListener(event: "close" | "error", listener: () => void): void;
}

/** A single authenticated Reverb subscription. The caller owns when to reconnect and reread. */
export function createOrbitRealtimeSubscription(input: {
  transport: OrbitGatewayTransport;
  discoveryPath: string;
  authPath: string;
  root?: true;
  channel: string;
  onStatus: (status: "live" | "disconnected") => void;
  onEvent: (event: string, data: unknown) => void;
  socket?: (url: string) => OrbitRealtimeSocket;
}) {
  let stopped = false;
  let socket: OrbitRealtimeSocket | null = null;
  let connecting = false;
  let live = false;
  let handshakeTimer: ReturnType<typeof setTimeout> | undefined;

  const closeSocket = () => {
    clearTimeout(handshakeTimer);
    const previous = socket;
    socket = null;
    live = false;
    previous?.close();
  };
  const fallback = () => {
    closeSocket();
    input.onStatus("disconnected");
  };
  const request = async (path: string, body?: Record<string, string>) => {
    const response = await input.transport({
      method: body ? "POST" : "GET",
      path,
      ...(input.root ? { root: input.root } : {}),
      ...(body ? { body } : {}),
      timeoutMs: 10_000,
    });
    if (response.status < 200 || response.status >= 300) throw new Error("Realtime unavailable");
    const envelope = realtimeObject(response.body);
    return realtimeObject(envelope?.data) ?? envelope;
  };
  const connect = async () => {
    if (stopped || connecting || socket !== null) return;
    connecting = true;
    try {
      const config = await request(input.discoveryPath);
      if (stopped) return;
      if (typeof config?.url !== "string" || typeof config.key !== "string")
        throw new Error("Invalid realtime discovery");
      const url = new URL(config.url);
      if (url.protocol !== "wss:" && url.protocol !== "ws:")
        throw new Error("Invalid realtime URL");
      url.pathname = `/app/${encodeURIComponent(config.key)}`;
      url.search = "protocol=7&client=conn&version=1";
      const current: OrbitRealtimeSocket = input.socket
        ? input.socket(url.toString())
        : new WebSocket(url.toString());
      socket = current;
      handshakeTimer = setTimeout(fallback, 15_000);
      current.addEventListener("close", () => {
        if (socket === current) fallback();
      });
      current.addEventListener("error", () => {
        if (socket === current) fallback();
      });
      current.addEventListener("message", (event) => {
        if (stopped || socket !== current) return;
        const message = realtimeObject(event.data);
        const data = realtimeObject(message?.data);
        if (message?.event === "pusher:ping") {
          current.send(JSON.stringify({ event: "pusher:pong", data: {} }));
        } else if (
          message?.event === "pusher:connection_established" &&
          typeof data?.socket_id === "string"
        ) {
          void request(input.authPath, {
            socket_id: data.socket_id,
            channel_name: input.channel,
          })
            .then((auth) => {
              if (stopped || socket !== current) return;
              if (typeof auth?.auth !== "string") {
                fallback();
                return;
              }
              current.send(
                JSON.stringify({
                  event: "pusher:subscribe",
                  data: { channel: input.channel, auth: auth.auth },
                }),
              );
            })
            .catch(() => {
              if (socket === current) fallback();
            });
        } else if (
          message?.channel === input.channel &&
          message.event === "pusher_internal:subscription_succeeded"
        ) {
          clearTimeout(handshakeTimer);
          live = true;
          input.onStatus("live");
        } else if (
          message?.event === "pusher:error" ||
          message?.event === "pusher:subscription_error"
        ) {
          fallback();
        } else if (
          live &&
          message?.channel === input.channel &&
          typeof message.event === "string"
        ) {
          input.onEvent(message.event, message.data);
        }
      });
    } catch {
      if (!stopped) fallback();
    } finally {
      connecting = false;
    }
  };

  return {
    connect,
    stop() {
      stopped = true;
      closeSocket();
    },
  };
}
