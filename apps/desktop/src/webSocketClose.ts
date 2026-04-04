import { WebSocket } from "ws";

type ClosableWebSocket = Pick<WebSocket, "close" | "terminate" | "readyState">;

export type WebSocketCloseReason = Buffer | string;

export function isSendableWebSocketCloseCode(code: number): boolean {
  return (
    Number.isInteger(code) &&
    ((code >= 1000 && code <= 1014 && code !== 1004 && code !== 1005 && code !== 1006) ||
      (code >= 3000 && code <= 4999))
  );
}

export function closeWebSocket(
  socket: ClosableWebSocket,
  code?: number,
  reason?: WebSocketCloseReason,
): void {
  if (socket.readyState === WebSocket.CLOSED || socket.readyState === WebSocket.CLOSING) {
    return;
  }

  if (code === undefined) {
    socket.close();
    return;
  }

  if (!isSendableWebSocketCloseCode(code)) {
    socket.terminate();
    return;
  }

  if (reason === undefined || reason.length === 0) {
    socket.close(code);
    return;
  }

  socket.close(code, reason);
}
