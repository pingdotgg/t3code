import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  createDeviceStreamClient,
  AvccDemuxer,
  avcCodecString,
  parseSemuPacket,
  scanAccessUnit,
} from "@t3tools/client-runtime/device/stream";

const envelope = (tag: number, payload: number[]) => {
  const length = 1 + payload.length;
  return [
    (length >>> 24) & 0xff,
    (length >>> 16) & 0xff,
    (length >>> 8) & 0xff,
    length & 0xff,
    tag,
    ...payload,
  ];
};

describe("AvccDemuxer", () => {
  it("reassembles envelopes split across reads", () => {
    const demuxer = new AvccDemuxer();
    const bytes = new Uint8Array([
      ...envelope(1, [1, 0x64, 0x00, 0x1f]),
      ...envelope(2, [9, 9, 9]),
      ...envelope(0x7f, [0]),
      ...envelope(3, [4]),
    ]);
    const first = demuxer.push(bytes.subarray(0, 7));
    const rest = demuxer.push(bytes.subarray(7));
    const chunks = [...first, ...rest];
    expect(chunks.map((chunk) => chunk.type)).toEqual(["description", "keyframe", "delta"]);
    expect(Array.from(chunks[0]!.payload)).toEqual([1, 0x64, 0x00, 0x1f]);
    expect(Array.from(chunks[1]!.payload)).toEqual([9, 9, 9]);
  });

  it("derives the WebCodecs codec string from the avcC record", () => {
    expect(avcCodecString(new Uint8Array([1, 0x64, 0x00, 0x1f]))).toBe("avc1.64001f");
    expect(avcCodecString(new Uint8Array([1]))).toBe("avc1.42E01E");
  });
});

describe("native device stream transport", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function setup(platform: "ios" | "android") {
    vi.useFakeTimers();
    vi.stubGlobal("VideoDecoder", vi.fn());
    vi.stubGlobal("EncodedVideoChunk", vi.fn());
    let resolveOpened!: (socket: FakeSocket) => void;
    const waitForSocket = () =>
      new Promise<FakeSocket>((resolve) => {
        resolveOpened = resolve;
      });
    const opened = waitForSocket();
    class FakeSocket {
      static OPEN = 1;
      readyState = 1;
      binaryType = "";
      onopen: (() => void) | null = null;
      onclose: ((event: { code: number; reason: string }) => void) | null = null;
      send = vi.fn();
      close = vi.fn();
      readonly url: string;
      constructor(url: string) {
        this.url = url;
        resolveOpened(this);
      }
    }
    vi.stubGlobal("WebSocket", FakeSocket);
    const fetch = vi.fn(() => Promise.resolve(new Response("frame")));
    vi.stubGlobal("fetch", fetch);
    const events = {
      onStatus: vi.fn(),
      onScreen: vi.fn(),
      onUnauthorized: vi.fn(),
      onMjpegFallback: vi.fn(),
      onInputConnected: vi.fn(),
    };
    const client = createDeviceStreamClient(
      {
        platform,
        deviceId: "test device",
        preferMjpeg: platform === "ios",
        access: {
          httpBase: "https://environment.test/api/device-hub",
          wsBase: "wss://environment.test/api/device-hub",
          credentials: false,
          query: { wsTicket: "stream-ticket", hostId: "ssh-host" },
        },
      },
      { getContext: () => null } as unknown as HTMLCanvasElement,
      events,
    );
    return { client, opened, waitForSocket, events, fetch };
  }

  it("uses authenticated iOS MJPEG and forwards controls without a cross-origin video fetch", async () => {
    const { client, opened, events, fetch } = setup("ios");
    client.start();
    const socket = await opened;
    const imageUrl = new URL(events.onMjpegFallback.mock.calls[0]![0] as string);
    expect(imageUrl.pathname).toContain("test%20device/stream.mjpeg");
    expect(imageUrl.searchParams.get("wsTicket")).toBe("stream-ticket");
    expect(imageUrl.searchParams.get("hostId")).toBe("ssh-host");
    expect(fetch).toHaveBeenCalledTimes(1);
    socket.onopen?.();
    client.pressButton("home");
    client.sendTouch("begin", 0.25, 0.75);
    const messages = socket.send.mock.calls.slice(1).map(([bytes]) => {
      const packet = bytes as Uint8Array;
      return {
        tag: packet[0],
        body: JSON.parse(new TextDecoder().decode(packet.subarray(1))) as unknown,
      };
    });
    expect(messages).toEqual([
      { tag: 0x04, body: { button: "home" } },
      { tag: 0x03, body: { type: "begin", x: 0.25, y: 0.75 } },
    ]);
    client.stop();
    expect(socket.close).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("forwards Android gestures and device controls through the ticketed host socket", async () => {
    const { client, opened } = setup("android");
    client.start();
    const socket = await opened;
    const url = new URL(socket.url);
    expect(url.searchParams.get("device")).toBe("test device");
    expect(url.searchParams.get("wsTicket")).toBe("stream-ticket");
    expect(url.searchParams.get("hostId")).toBe("ssh-host");
    client.sendTouch("begin", 0.2, 0.8);
    client.sendTouch("move", 0.2, 0.4);
    client.sendTouch("end", 0.2, 0.1);
    client.pressButton("home");
    client.pressButton("appSwitcher");
    expect(
      socket.send.mock.calls.map(([message]) => JSON.parse(message as string) as unknown),
    ).toEqual([
      { type: "touch", action: "down", x: 0.2, y: 0.8 },
      { type: "touch", action: "move", x: 0.2, y: 0.4 },
      { type: "touch", action: "up", x: 0.2, y: 0.1 },
      { type: "home" },
      { type: "recents" },
    ]);
    client.stop();
    expect(socket.close).toHaveBeenCalledTimes(1);
  });

  it("renews an expired Android ticket when the HTTP upgrade is rejected instead of retrying it forever", async () => {
    const { client, opened, events } = setup("android");
    client.start();
    const socket = await opened;
    socket.onclose?.({ code: 1006, reason: "" });
    expect(events.onUnauthorized).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    client.stop();
  });

  it.each(["ios", "android"] as const)(
    "keeps a restarted %s stream connected when the discarded socket closes late",
    async (platform) => {
      const { client, opened, waitForSocket, events } = setup(platform);
      client.start();
      const discarded = await opened;
      client.stop();
      const reopened = waitForSocket();
      client.start();
      const replacement = await reopened;
      replacement.onopen?.();
      replacement.send.mockClear();
      events.onInputConnected.mockClear();

      discarded.onclose?.({ code: 1006, reason: "" });

      expect(events.onUnauthorized).not.toHaveBeenCalled();
      expect(events.onInputConnected).not.toHaveBeenCalled();
      expect(replacement.close).not.toHaveBeenCalled();
      client.pressButton("home");
      expect(replacement.send).toHaveBeenCalledTimes(1);
      client.stop();
      expect(replacement.close).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each(["ios", "android"] as const)(
    "does not renew credentials or reconnect a stopped %s stream",
    async (platform) => {
      const { client, opened, events } = setup(platform);
      client.start();
      const socket = await opened;
      events.onInputConnected.mockClear();
      client.stop();
      socket.onclose?.({ code: 1006, reason: "" });
      expect(events.onUnauthorized).not.toHaveBeenCalled();
      expect(events.onInputConnected).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    },
  );
});

describe("serve-emu frames", () => {
  it("strips the SEMU header and reads the keyframe flag and timestamp", () => {
    const buffer = new ArrayBuffer(16 + 3);
    const view = new DataView(buffer);
    view.setUint32(0, 0x53454d55);
    view.setUint8(4, 1);
    view.setUint8(5, 1);
    view.setBigUint64(8, 123456n);
    new Uint8Array(buffer).set([7, 8, 9], 16);
    const packet = parseSemuPacket(buffer);
    expect(packet.isKey).toBe(true);
    expect(packet.timestamp).toBe(123456);
    expect(Array.from(packet.data)).toEqual([7, 8, 9]);
  });

  it("treats a frame without the header as raw data", () => {
    const packet = parseSemuPacket(new Uint8Array([0, 0, 1, 0x65]).buffer);
    expect(packet.isKey).toBeNull();
    expect(packet.data.length).toBe(4);
  });

  it("finds the SPS and IDR NAL units in an Annex-B access unit", () => {
    const unit = new Uint8Array([0, 0, 0, 1, 0x67, 0x64, 0x00, 0x1f, 0, 0, 1, 0x65, 0xaa]);
    const scanned = scanAccessUnit(unit);
    expect(scanned.isKey).toBe(true);
    expect(scanned.sps && avcCodecString(scanned.sps)).toBe("avc1.64001f");
    expect(scanAccessUnit(new Uint8Array([0, 0, 1, 0x41, 0x00])).isKey).toBe(false);
  });
});

describe("iOS input startup", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const setup = () => {
    vi.useFakeTimers();
    const sockets: FakeSocket[] = [];
    class FakeSocket {
      static OPEN = 1;
      readyState = 1;
      binaryType = "";
      onopen: (() => void) | null = null;
      onmessage: ((event: { data: ArrayBuffer }) => void) | null = null;
      onclose: ((event: { code: number; reason: string }) => void) | null = null;
      send = vi.fn();
      close = vi.fn();
      constructor() {
        sockets.push(this);
      }
    }
    vi.stubGlobal("WebSocket", FakeSocket);
    const signals: AbortSignal[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((_url, init: RequestInit) => {
        const signal = init.signal!;
        signals.push(signal);
        return Promise.resolve(
          new Response(
            new ReadableStream({
              start(controller) {
                signal.addEventListener("abort", () => controller.error(new Error("aborted")));
              },
            }),
          ),
        );
      }),
    );
    const client = createDeviceStreamClient(
      {
        platform: "ios",
        deviceId: "test-device",
        access: {
          httpBase: "http://test/api/device-hub",
          wsBase: "ws://test/api/device-hub",
          credentials: true,
          query: {},
        },
      },
      { getContext: () => null } as unknown as HTMLCanvasElement,
      {
        onStatus: vi.fn(),
        onScreen: vi.fn(),
        onUnauthorized: vi.fn(),
        onMjpegFallback: vi.fn(),
        onInputConnected: vi.fn(),
      },
    );
    return { client, sockets, signals };
  };

  it("connects input when the MJPEG prime never produces a frame", async () => {
    const { client, sockets, signals } = setup();
    client.start();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(signals[0]?.aborted).toBe(true);
    expect(sockets).toHaveLength(1);
    client.stop();
  });

  it("aborts priming immediately when hidden without opening a socket later", async () => {
    const { client, sockets, signals } = setup();
    client.start();
    await vi.advanceTimersByTimeAsync(0);
    client.stop();
    expect(signals[0]?.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(sockets).toHaveLength(0);
  });

  it.each([
    ["landscape_left", 0.7, 1 - 0.2],
    ["landscape_right", 1 - 0.7, 0.2],
  ])("maps %s touches back to the raw iOS framebuffer", async (orientation, x, y) => {
    const { client, sockets } = setup();
    client.start();
    await vi.advanceTimersByTimeAsync(2_000);
    const socket = sockets[0]!;
    const json = new TextEncoder().encode(JSON.stringify({ width: 400, height: 800, orientation }));
    const packet = new Uint8Array(1 + json.length);
    packet[0] = 0x82;
    packet.set(json, 1);
    socket.onmessage?.({ data: packet.buffer });
    client.sendTouch("begin", 0.2, 0.7);
    const sent = socket.send.mock.calls[0]![0] as Uint8Array;
    expect(JSON.parse(new TextDecoder().decode(sent.subarray(1)))).toEqual({
      type: "begin",
      x,
      y,
    });
    client.stop();
  });
});
