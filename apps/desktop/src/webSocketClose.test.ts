import { describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";

import { closeWebSocket, isSendableWebSocketCloseCode } from "./webSocketClose";

type WebSocketReadyState = 0 | 1 | 2 | 3;

function createSocket(readyState: WebSocketReadyState = WebSocket.OPEN) {
  return {
    readyState,
    close: vi.fn(),
    terminate: vi.fn(),
  };
}

describe("isSendableWebSocketCloseCode", () => {
  it("accepts standard and application close codes", () => {
    expect(isSendableWebSocketCloseCode(1000)).toBe(true);
    expect(isSendableWebSocketCloseCode(1011)).toBe(true);
    expect(isSendableWebSocketCloseCode(4001)).toBe(true);
  });

  it("rejects reserved and out-of-range close codes", () => {
    expect(isSendableWebSocketCloseCode(1005)).toBe(false);
    expect(isSendableWebSocketCloseCode(1006)).toBe(false);
    expect(isSendableWebSocketCloseCode(2000)).toBe(false);
  });
});

describe("closeWebSocket", () => {
  it("forwards valid close frames", () => {
    const socket = createSocket();

    closeWebSocket(socket, 1011, "backend failed");

    expect(socket.close).toHaveBeenCalledWith(1011, "backend failed");
    expect(socket.terminate).not.toHaveBeenCalled();
  });

  it("omits empty reasons when forwarding a valid close code", () => {
    const socket = createSocket();

    closeWebSocket(socket, 1000, "");

    expect(socket.close).toHaveBeenCalledWith(1000);
  });

  it("terminates on abnormal close codes that cannot be sent in a close frame", () => {
    const socket = createSocket();

    closeWebSocket(socket, 1006, Buffer.from(""));

    expect(socket.close).not.toHaveBeenCalled();
    expect(socket.terminate).toHaveBeenCalledTimes(1);
  });

  it("falls back to a plain close when no code is provided", () => {
    const socket = createSocket();

    closeWebSocket(socket);

    expect(socket.close).toHaveBeenCalledWith();
    expect(socket.terminate).not.toHaveBeenCalled();
  });

  it("does nothing once the socket is already closing", () => {
    const socket = createSocket(WebSocket.CLOSING);

    closeWebSocket(socket, 1000, "done");

    expect(socket.close).not.toHaveBeenCalled();
    expect(socket.terminate).not.toHaveBeenCalled();
  });
});
