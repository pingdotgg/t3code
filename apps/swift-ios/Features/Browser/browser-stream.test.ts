import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { createPreviewStreamClient } from "../../../../packages/client-runtime/src/preview/serverBrowserStream";

class BrowserSocket extends EventTarget {
  static readonly OPEN = 1;
  static opened: BrowserSocket[] = [];
  readyState = 1;
  binaryType = "";
  readonly sent: string[] = [];
  constructor(readonly url: string) {
    super();
    BrowserSocket.opened.push(this);
  }
  send(message: string) {
    this.sent.push(message);
  }
  close() {
    this.readyState = 3;
  }
  disconnect(code: number, reason = "") {
    const event = Object.assign(new Event("close"), { code, reason });
    this.dispatchEvent(event);
  }
}

const target = {
  access: {
    httpBase: "https://relay.example/api/preview-stream",
    wsBase: "wss://relay.example/api/preview-stream",
    query: { wsTicket: "short-lived & ticket" },
    credentials: false,
  },
  threadId: "wire/thread",
  tabId: "tab",
  interactive: false,
  maxWidth: 780,
  maxHeight: 1600,
};

// Exercise the exact shared client bundled into Swift, including terminal close
// behavior that the native bridge must preserve on foreground/resize.
describe("Swift browser shared transport", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    BrowserSocket.opened = [];
    vi.stubGlobal("WebSocket", BrowserSocket);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const connect = () => {
    const onHostSetup = vi.fn();
    const client = createPreviewStreamClient(target, {
      onFrame: vi.fn(),
      onViewport: vi.fn(),
      onConnectedChange: vi.fn(),
      onUnauthorized: vi.fn(),
      onHostSetup,
    });
    const socket = BrowserSocket.opened[0]!;
    return { client, socket, onHostSetup };
  };

  it("uses the environment ticket and stops reconnecting after host setup code 4503", () => {
    const { client, socket, onHostSetup } = connect();
    const url = new URL(socket.url);
    expect(url.origin).toBe("wss://relay.example");
    expect(url.searchParams.get("wsTicket")).toBe("short-lived & ticket");
    expect(url.searchParams.get("threadId")).toBe("wire/thread");
    expect(url.searchParams.get("interactive")).toBe("false");
    socket.disconnect(
      4503,
      JSON.stringify({ need: "libraries", command: "sudo npx t3 browser setup" }),
    );
    vi.advanceTimersByTime(60_000);
    expect(onHostSetup).toHaveBeenCalledExactlyOnceWith({
      need: "libraries",
      command: "sudo npx t3 browser setup",
    });
    expect(BrowserSocket.opened).toHaveLength(1);
    client.stop();
  });

  it("cancels pending reconnects when the native view leaves the foreground", () => {
    const { client, socket } = connect();
    socket.disconnect(1001);
    client.stop();
    vi.advanceTimersByTime(60_000);
    expect(BrowserSocket.opened).toHaveLength(1);
    expect(client.send({ type: "takeControl" })).toBe(false);
  });
});
