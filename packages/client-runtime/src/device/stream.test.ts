import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  createDeviceStreamClient,
  AvccDemuxer,
  avcCodecString,
  parseSemuPacket,
  scanAccessUnit,
} from "./stream.ts";

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
    client.setOrientation("landscape_right");
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
      { tag: 0x07, body: { orientation: "landscape_right" } },
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
    client.setOrientation("landscape_right");
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

class MjpegImage extends EventTarget {
  naturalWidth = 0;
  naturalHeight = 0;
  src = "";
  removeAttribute(name: string) {
    if (name === "src") {
      this.src = "";
      this.naturalWidth = 0;
      this.naturalHeight = 0;
    }
  }
}

function recoveryFixture(platform: "ios" | "android" = "ios", preferMjpeg = true) {
  vi.useFakeTimers();
  const sockets: Socket[] = [];
  class Socket {
    static OPEN = 1;
    readyState = 1;
    binaryType = "";
    onopen: (() => void) | null = null;
    onmessage: ((event: { data: ArrayBuffer | string }) => void) | null = null;
    onclose: ((event: { code: number; reason: string }) => void) | null = null;
    send = vi.fn();
    close = vi.fn();
    constructor() {
      sockets.push(this);
    }
  }
  vi.stubGlobal("WebSocket", Socket);
  const decoders: Decoder[] = [];
  class Decoder {
    static isConfigSupported = vi.fn(async () => ({ supported: true }));
    state = "unconfigured";
    decodeQueueSize = 0;
    configure() {
      this.state = "configured";
    }
    close() {
      this.state = "closed";
    }
    decode() {}
    readonly callbacks: { output: (frame: VideoFrame) => void; error: () => void };
    constructor(callbacks: { output: (frame: VideoFrame) => void; error: () => void }) {
      this.callbacks = callbacks;
      decoders.push(this);
    }
  }
  vi.stubGlobal("VideoDecoder", Decoder);
  vi.stubGlobal("EncodedVideoChunk", vi.fn());
  const videoBodies: ReadableStreamDefaultController<Uint8Array>[] = [];
  const signals: AbortSignal[] = [];
  const fetch = vi.fn((url: string, init: RequestInit) => {
    const signal = init.signal!;
    signals.push(signal);
    if (!url.includes("stream.avcc")) return Promise.resolve(new Response("prime"));
    return Promise.resolve(
      new Response(
        new ReadableStream<Uint8Array>({
          start(body) {
            videoBodies.push(body);
            signal.addEventListener("abort", () => body.error(new Error("aborted")), {
              once: true,
            });
          },
        }),
      ),
    );
  });
  vi.stubGlobal("fetch", fetch);
  const events = {
    onStatus: vi.fn(),
    onScreen: vi.fn(),
    onUnauthorized: vi.fn(),
    onMjpegFallback: vi.fn(),
    onInputConnected: vi.fn(),
  };
  const drawImage = vi.fn();
  const image = new MjpegImage();
  const client = createDeviceStreamClient(
    {
      platform,
      preferMjpeg,
      deviceId: "test-device",
      access: {
        httpBase: "https://test/api/device-hub",
        wsBase: "wss://test/api/device-hub",
        credentials: true,
        query: {},
      },
    },
    { getContext: () => ({ drawImage }) } as unknown as HTMLCanvasElement,
    events,
  );
  client.setMjpegImage(image as unknown as HTMLImageElement);
  const imageReady = () => {
    image.naturalWidth = 400;
    image.naturalHeight = 800;
    image.dispatchEvent(new Event("load"));
  };
  const decodedFrame = (index = decoders.length - 1) => {
    const close = vi.fn();
    decoders[index]!.callbacks.output({
      displayWidth: 400,
      displayHeight: 800,
      close,
    } as unknown as VideoFrame);
    return close;
  };
  const sps = new Uint8Array([0, 0, 0, 1, 0x67, 0x64, 0, 0x1f, 0, 0, 1, 0x65]).buffer;
  return {
    client,
    events,
    image,
    imageReady,
    sockets,
    signals,
    fetch,
    videoBodies,
    decoders,
    Decoder,
    drawImage,
    decodedFrame,
    sps,
  };
}

describe("shared device stream readiness and recovery", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("waits for actual MJPEG dimensions without requiring a multipart load event", async () => {
    const { client, events, image } = recoveryFixture();
    client.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(image.src).toContain("stream.mjpeg");
    expect(events.onStatus).not.toHaveBeenCalledWith("streaming", undefined);
    image.naturalWidth = 400;
    image.naturalHeight = 800;
    await vi.advanceTimersByTimeAsync(250);
    expect(events.onStatus).toHaveBeenLastCalledWith("streaming", undefined);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(events.onStatus).toHaveBeenLastCalledWith("streaming", undefined);
    client.stop();
  });

  it("observes a web image attached after MJPEG fallback has already begun", async () => {
    const { client, image, imageReady, events } = recoveryFixture();
    client.setMjpegImage(null);
    client.start();
    expect(image.src).toBe("");
    await vi.advanceTimersByTimeAsync(1000);
    client.setMjpegImage(image as unknown as HTMLImageElement);
    imageReady();
    expect(events.onStatus).toHaveBeenLastCalledWith("streaming", undefined);
    client.stop();
    expect(image.src).toBe("");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops input and video on an image error without treating it as expired credentials", async () => {
    const { client, image, imageReady, sockets, events } = recoveryFixture();
    client.start();
    await vi.advanceTimersByTimeAsync(0);
    sockets[0]!.onopen?.();
    imageReady();
    image.dispatchEvent(new Event("error"));
    expect(events.onStatus).toHaveBeenLastCalledWith("error", expect.stringContaining("Reconnect"));
    expect(events.onInputConnected).toHaveBeenLastCalledWith(false, expect.any(String));
    expect(events.onUnauthorized).not.toHaveBeenCalled();
    expect(sockets[0]!.close).toHaveBeenCalledOnce();
    expect(image.src).toBe("");
    client.pressButton("home");
    expect(sockets[0]!.send).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    ["ios", true],
    ["ios", false],
    ["android", false],
  ] as const)(
    "bounds missing first frames for %s with preferMjpeg=%s",
    async (platform, preferMjpeg) => {
      const { client, events, signals, sockets, image } = recoveryFixture(platform, preferMjpeg);
      client.start();
      await vi.advanceTimersByTimeAsync(14_999);
      expect(events.onStatus.mock.calls.some(([status]) => status === "error")).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(events.onStatus).toHaveBeenLastCalledWith(
        "error",
        expect.stringContaining("No video"),
      );
      expect(events.onInputConnected).toHaveBeenLastCalledWith(false, expect.any(String));
      expect(signals.every((signal) => signal.aborted)).toBe(true);
      expect(sockets[0]!.close).toHaveBeenCalledOnce();
      expect(image.src).toBe("");
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("does not extend the first-frame deadline each time a socket reconnects", async () => {
    const { client, sockets, events } = recoveryFixture("android");
    client.start();
    sockets[0]!.onopen?.();
    sockets[0]!.onclose?.({ code: 1000, reason: "restart" });
    await vi.advanceTimersByTimeAsync(14_999);
    sockets[1]!.onopen?.();
    await vi.advanceTimersByTimeAsync(1);
    expect(events.onStatus).toHaveBeenLastCalledWith("error", expect.stringContaining("No video"));
    expect(sockets[1]!.close).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("gives a manual restart a fresh deadline and ignores queued image events from its old binding", async () => {
    const { client, image, events } = recoveryFixture();
    const listeners: EventListener[] = [];
    const add = image.addEventListener.bind(image);
    vi.spyOn(image, "addEventListener").mockImplementation((name, callback, options) => {
      if (typeof callback === "function") listeners.push(callback);
      add(name, callback, options);
    });
    client.start();
    await vi.advanceTimersByTimeAsync(10_000);
    client.stop();
    client.start();
    events.onStatus.mockClear();
    for (const listener of listeners.slice(0, 2)) listener(new Event("error"));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(events.onStatus).not.toHaveBeenCalled();
    const replacement = new MjpegImage();
    client.setMjpegImage(replacement as unknown as HTMLImageElement);
    replacement.naturalWidth = 400;
    replacement.naturalHeight = 800;
    replacement.dispatchEvent(new Event("load"));
    expect(events.onStatus).toHaveBeenLastCalledWith("streaming", undefined);
    client.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("falls back from unsupported iOS H.264 without publishing a terminal error", async () => {
    const { client, videoBodies, Decoder, events, imageReady } = recoveryFixture("ios", false);
    Decoder.isConfigSupported.mockResolvedValue({ supported: false });
    client.start();
    await vi.advanceTimersByTimeAsync(0);
    videoBodies[0]!.enqueue(new Uint8Array(envelope(1, [1, 0x64, 0, 0x1f])));
    await vi.advanceTimersByTimeAsync(0);
    expect(events.onMjpegFallback).toHaveBeenCalledOnce();
    expect(events.onStatus.mock.calls.some(([status]) => status === "error")).toBe(false);
    imageReady();
    expect(events.onStatus).toHaveBeenLastCalledWith("streaming", undefined);
    client.stop();
  });

  it("publishes a terminal unsupported-profile error for Android and closes its socket", async () => {
    const { client, sockets, sps, Decoder, events } = recoveryFixture("android");
    Decoder.isConfigSupported.mockResolvedValue({ supported: false });
    client.start();
    sockets[0]!.onmessage?.({ data: sps });
    await vi.advanceTimersByTimeAsync(0);
    expect(events.onStatus).toHaveBeenLastCalledWith(
      "error",
      expect.stringContaining("cannot decode"),
    );
    expect(sockets[0]!.close).toHaveBeenCalledOnce();
    expect(events.onMjpegFallback).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("waits for decoded Android output and bounds a rotation that never produces another frame", async () => {
    const { client, sockets, sps, events, decodedFrame, drawImage } = recoveryFixture("android");
    client.start();
    sockets[0]!.onmessage?.({ data: sps });
    await vi.advanceTimersByTimeAsync(0);
    expect(events.onStatus.mock.calls.some(([status]) => status === "streaming")).toBe(false);
    expect(decodedFrame()).toHaveBeenCalledOnce();
    expect(drawImage).toHaveBeenCalledOnce();
    expect(events.onStatus).toHaveBeenLastCalledWith("streaming", undefined);
    sockets[0]!.onmessage?.({ data: JSON.stringify({ type: "video-session" }) });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(events.onStatus).toHaveBeenLastCalledWith("error", expect.stringContaining("No video"));
    expect(vi.getTimerCount()).toBe(0);
  });

  it("discards decoder support results and output from a previous Android socket", async () => {
    const { client, sockets, sps, events, Decoder, decoders, decodedFrame, drawImage } =
      recoveryFixture("android");
    let resolveSupport!: (support: { supported: boolean }) => void;
    Decoder.isConfigSupported.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSupport = resolve;
        }),
    );
    client.start();
    sockets[0]!.onmessage?.({ data: sps });
    client.stop();
    client.start();
    resolveSupport({ supported: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(decoders).toHaveLength(0);
    sockets[1]!.onmessage?.({ data: sps });
    await vi.advanceTimersByTimeAsync(0);
    client.stop();
    client.start();
    events.onStatus.mockClear();
    expect(decodedFrame()).toHaveBeenCalledOnce();
    expect(drawImage).not.toHaveBeenCalled();
    expect(events.onStatus).not.toHaveBeenCalled();
    client.stop();
  });

  it("ignores an old AVCC response rejected after a new attempt is connected", async () => {
    const { client, fetch, events } = recoveryFixture("ios", false);
    let resolveResponse!: (response: Response) => void;
    fetch.mockImplementationOnce(() => Promise.resolve(new Response("prime")));
    fetch.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveResponse = resolve;
        }),
    );
    client.start();
    await vi.advanceTimersByTimeAsync(0);
    client.stop();
    client.start();
    await vi.advanceTimersByTimeAsync(0);
    events.onStatus.mockClear();
    resolveResponse(new Response(null, { status: 401 }));
    await vi.advanceTimersByTimeAsync(0);
    expect(events.onUnauthorized).not.toHaveBeenCalled();
    expect(events.onStatus).not.toHaveBeenCalled();
    client.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("closes a delayed JPEG seed from a stopped AVCC attempt without painting it", async () => {
    const { client, videoBodies, drawImage, events } = recoveryFixture("ios", false);
    let resolveBitmap!: (bitmap: ImageBitmap) => void;
    vi.stubGlobal(
      "createImageBitmap",
      () =>
        new Promise((resolve) => {
          resolveBitmap = resolve;
        }),
    );
    client.start();
    await vi.advanceTimersByTimeAsync(0);
    videoBodies[0]!.enqueue(new Uint8Array(envelope(4, [1])));
    await vi.advanceTimersByTimeAsync(0);
    client.stop();
    client.start();
    events.onStatus.mockClear();
    const close = vi.fn();
    resolveBitmap({ width: 400, height: 800, close } as unknown as ImageBitmap);
    await vi.advanceTimersByTimeAsync(0);
    expect(close).toHaveBeenCalledOnce();
    expect(drawImage).not.toHaveBeenCalled();
    expect(events.onStatus).not.toHaveBeenCalled();
    client.stop();
  });
});

it("reports a stalled AVCC body after its initial image instead of leaving a frozen streaming state", async () => {
  const { client, videoBodies, events, signals } = recoveryFixture("ios", false);
  const close = vi.fn();
  vi.stubGlobal("createImageBitmap", () => Promise.resolve({ width: 400, height: 800, close }));
  try {
    client.start();
    await vi.advanceTimersByTimeAsync(0);
    videoBodies[0]!.enqueue(new Uint8Array(envelope(4, [1])));
    await vi.advanceTimersByTimeAsync(0);
    expect(events.onStatus).toHaveBeenLastCalledWith("streaming", undefined);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(events.onStatus).toHaveBeenLastCalledWith(
      "error",
      expect.stringContaining("stopped receiving video"),
    );
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    client.stop();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }
});
