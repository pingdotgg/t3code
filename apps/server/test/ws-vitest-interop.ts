import * as NodeModule from "node:module";

type WsInterop = {
  readonly CONNECTING?: unknown;
  readonly OPEN?: unknown;
  readonly CLOSING?: unknown;
  readonly CLOSED?: unknown;
  readonly Receiver?: unknown;
  readonly Sender?: unknown;
  readonly WebSocket?: unknown;
  readonly WebSocketServer?: unknown;
  readonly Server?: unknown;
  readonly createWebSocketStream?: unknown;
  readonly default?: unknown;
};

const requireFromPackage = NodeModule.createRequire(import.meta.url);
const requireFromPlatformNodeShared = NodeModule.createRequire(
  requireFromPackage.resolve("@effect/platform-node-shared/package.json"),
);
const ws = requireFromPlatformNodeShared("ws") as WsInterop;
const WebSocket = ws.WebSocket ?? ws.default ?? ws;
const WebSocketServer = ws.WebSocketServer ?? ws.Server;

export const CONNECTING = ws.CONNECTING;
export const OPEN = ws.OPEN;
export const CLOSING = ws.CLOSING;
export const CLOSED = ws.CLOSED;
export const Receiver = ws.Receiver;
export const Sender = ws.Sender;
export const Server = WebSocketServer;
export const createWebSocketStream = ws.createWebSocketStream;
export { WebSocket, WebSocketServer };
export default WebSocket;
