import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { createPreviewStreamClient, type PreviewStreamControl } from "./serverBrowserStream.ts";

class FakeSocket extends EventTarget {
  static readonly OPEN = 1;
  static current: FakeSocket;
  readyState = 1;
  binaryType = "";
  readonly sent: string[] = [];
  readonly url: string;
  constructor(url: string) {
    super();
    this.url = url;
    FakeSocket.current = this;
  }
  send(value: string) {
    this.sent.push(value);
  }
  close() {
    this.readyState = 3;
  }
  message(data: unknown) {
    this.dispatchEvent(new MessageEvent("message", { data }));
  }
  control(value: PreviewStreamControl) {
    this.message(JSON.stringify({ type: "control", ...value }));
  }
}

const target = {
  access: {
    httpBase: "http://preview.test/api/preview-stream",
    wsBase: "ws://preview.test/api/preview-stream",
    query: {},
    credentials: true,
  },
  threadId: "thread",
  tabId: "tab",
  maxWidth: 800,
  maxHeight: 600,
};

describe("preview stream control", () => {
  beforeEach(() => vi.stubGlobal("WebSocket", FakeSocket));
  afterEach(() => vi.unstubAllGlobals());
  const connect = () => {
    const onFrame = vi.fn();
    const onControl = vi.fn();
    const client = createPreviewStreamClient(target, {
      onFrame,
      onControl,
      onViewport: vi.fn(),
      onConnectedChange: vi.fn(),
      onUnauthorized: vi.fn(),
    });
    return { client, socket: FakeSocket.current, onFrame, onControl };
  };
  const agent: PreviewStreamControl = {
    canOperate: true,
    controller: "agent",
    generation: 1,
    dialog: null,
  };

  it("does not grant control from malformed dialog metadata", () => {
    const { client, socket, onControl } = connect();
    socket.message(
      JSON.stringify({
        type: "control",
        ...agent,
        controller: "you",
        dialog: { type: "prompt", message: 42, defaultValue: "" },
      }),
    );
    expect(onControl).not.toHaveBeenCalled();
    expect(client.send({ type: "reload" })).toBe(false);
    client.stop();
  });

  it("keeps read-only frames flowing while refusing takeover and every mutation", () => {
    const { client, socket, onFrame } = connect();
    socket.control({ ...agent, canOperate: false });
    const frame = new ArrayBuffer(3);
    socket.message(frame);
    expect(onFrame).toHaveBeenCalledWith(frame);
    expect(client.send({ type: "takeControl" })).toBe(false);
    expect(client.send({ type: "resize", width: 390, height: 844 })).toBe(false);
    expect(client.send({ type: "reload" })).toBe(false);
    expect(socket.sent).toEqual(['{"type":"ack"}']);
    client.stop();
  });

  it("revokes input immediately on release and exposes pending dialog state", () => {
    const { client, socket, onControl } = connect();
    const owned = {
      ...agent,
      controller: "you" as const,
      dialog: { type: "prompt", message: "Name?", defaultValue: "initial" },
    };
    socket.control(owned);
    expect(onControl).toHaveBeenLastCalledWith(owned);
    expect(client.send({ type: "dialog", accept: true, promptText: "answer" })).toBe(true);
    expect(client.send({ type: "releaseControl" })).toBe(true);
    socket.control({ ...agent, generation: 2 });
    expect(client.send({ type: "text", text: "late input" })).toBe(false);
    expect(client.send({ type: "dialog", accept: false })).toBe(false);
    client.stop();
  });
});

describe("preview stream downloads", () => {
  beforeEach(() => vi.stubGlobal("WebSocket", FakeSocket));
  afterEach(() => vi.unstubAllGlobals());

  it("offers a download at a URL carrying the stream's ticket", () => {
    const onDownload = vi.fn();
    createPreviewStreamClient(
      {
        ...target,
        access: { ...target.access, query: { wsTicket: "ticket" }, credentials: false },
      },
      {
        onFrame: vi.fn(),
        onDownload,
        onViewport: vi.fn(),
        onConnectedChange: vi.fn(),
        onUnauthorized: vi.fn(),
      },
    );
    FakeSocket.current.message(
      JSON.stringify({ type: "download", id: "d1", fileName: "a b.csv", sizeBytes: 3 }),
    );
    expect(onDownload).toHaveBeenCalledExactlyOnceWith({
      fileName: "a b.csv",
      sizeBytes: 3,
      url: "http://preview.test/api/preview-stream/download?threadId=thread&tabId=tab&id=d1&wsTicket=ticket",
    });
  });
});

describe("preview stream agent pointer", () => {
  beforeEach(() => vi.stubGlobal("WebSocket", FakeSocket));
  afterEach(() => vi.unstubAllGlobals());

  it("reports where the agent moves and clicks, ignoring malformed points", () => {
    const onPointer = vi.fn();
    createPreviewStreamClient(target, {
      onFrame: vi.fn(),
      onPointer,
      onViewport: vi.fn(),
      onConnectedChange: vi.fn(),
      onUnauthorized: vi.fn(),
    });
    FakeSocket.current.message(
      JSON.stringify({ type: "pointer", phase: "drag", x: 1, y: 2, sequence: 1 }),
    );
    FakeSocket.current.message(
      JSON.stringify({ type: "pointer", phase: "click", x: 140, y: 50, sequence: 2 }),
    );
    expect(onPointer).toHaveBeenCalledExactlyOnceWith({
      phase: "click",
      x: 140,
      y: 50,
      sequence: 2,
    });
  });
});

describe("preview stream accessible view", () => {
  beforeEach(() => vi.stubGlobal("WebSocket", FakeSocket));
  afterEach(() => vi.unstubAllGlobals());
  const document = {
    document: "1:loader",
    version: 3,
    truncated: false,
    root: { id: "0.1", role: "document", children: [{ id: "0.2", role: "button", name: "Go" }] },
  };
  const connect = () => {
    const onAccessibility = vi.fn();
    const onAccessibilityNotice = vi.fn();
    const onConnectedChange = vi.fn();
    const client = createPreviewStreamClient(target, {
      onFrame: vi.fn(),
      onAccessibility,
      onAccessibilityNotice,
      onViewport: vi.fn(),
      onConnectedChange,
      onUnauthorized: vi.fn(),
    });
    const socket = FakeSocket.current;
    socket.dispatchEvent(new Event("open"));
    return { client, socket, onAccessibility, onAccessibilityNotice };
  };

  it("lets a read-only viewer subscribe without granting it page actions", () => {
    const { client, socket, onAccessibility } = connect();
    socket.control({ canOperate: false, controller: "agent", generation: 1, dialog: null });
    socket.message(JSON.stringify({ type: "accessibility", document }));
    expect(onAccessibility).not.toHaveBeenCalled();
    client.accessibility(true);
    expect(socket.sent).toEqual(['{"type":"accessibility","enabled":true}']);
    socket.message(JSON.stringify({ type: "accessibility", document }));
    expect(onAccessibility).toHaveBeenLastCalledWith(document);
    expect(
      client.send({
        type: "accessibilityAction",
        document: document.document,
        node: "0.2",
        action: "activate",
      }),
    ).toBe(false);
    expect(socket.sent).toHaveLength(1);
    client.stop();
  });

  it("drops documents that break the contract and clears on off, reset and disconnect", () => {
    const { client, socket, onAccessibility, onAccessibilityNotice } = connect();
    client.accessibility(true);
    socket.message(
      JSON.stringify({ type: "accessibility", document: { ...document, root: { role: "x" } } }),
    );
    socket.message(
      JSON.stringify({ type: "accessibility", document: { ...document, version: -1 } }),
    );
    expect(onAccessibility).not.toHaveBeenCalled();
    socket.message(JSON.stringify({ type: "accessibility", document }));
    socket.message(JSON.stringify({ type: "accessibilityNotice", message: "The page changed." }));
    expect(onAccessibilityNotice).toHaveBeenCalledWith("The page changed.");
    socket.message(JSON.stringify({ type: "accessibility", document: null }));
    expect(onAccessibility).toHaveBeenLastCalledWith(null);

    socket.message(JSON.stringify({ type: "accessibility", document }));
    client.accessibility(false);
    expect(onAccessibility).toHaveBeenLastCalledWith(null);
    expect(socket.sent.at(-1)).toBe('{"type":"accessibility","enabled":false}');

    client.accessibility(true);
    socket.message(JSON.stringify({ type: "accessibility", document }));
    onAccessibility.mockClear();
    socket.dispatchEvent(new CloseEvent("close", { code: 1012 }));
    expect(onAccessibility).toHaveBeenCalledExactlyOnceWith(null);
    client.stop();
  });

  it("resubscribes after a reconnect", () => {
    vi.useFakeTimers();
    try {
      const { client, socket } = connect();
      client.accessibility(true);
      socket.dispatchEvent(new CloseEvent("close", { code: 1012 }));
      vi.advanceTimersByTime(500);
      const next = FakeSocket.current;
      expect(next).not.toBe(socket);
      next.dispatchEvent(new Event("open"));
      expect(next.sent).toEqual(['{"type":"accessibility","enabled":true}']);
      client.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
