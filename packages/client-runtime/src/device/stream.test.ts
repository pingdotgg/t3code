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
      onmessage: ((event: { data: ArrayBuffer }) => void) | null = null;
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
    expect(socket.send).not.toHaveBeenCalled();
    socket.onmessage?.({ data: Uint8Array.of(0x83).buffer });
    client.sendText("hello");
    expect(socket.send).not.toHaveBeenCalled();
    client.setOrientation("landscape_right");
    client.pressButton("home");
    client.sendTouch("begin", 0.25, 0.75);
    const messages = socket.send.mock.calls.map(([bytes]) => {
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
    const prefix = "a".repeat(299);
    client.sendText(`${prefix}ä`);
    expect(
      socket.send.mock.calls.map(([message]) => JSON.parse(message as string) as unknown),
    ).toEqual([
      { type: "touch", action: "down", x: 0.2, y: 0.8 },
      { type: "touch", action: "move", x: 0.2, y: 0.4 },
      { type: "touch", action: "up", x: 0.2, y: 0.1 },
      { type: "home" },
      { type: "recents" },
      { type: "text", text: prefix },
      { type: "text", text: "ä" },
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
      if (platform === "ios") replacement.onmessage?.({ data: Uint8Array.of(0x83).buffer });
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
    socket.onmessage?.({ data: Uint8Array.of(0x83).buffer });
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
    reset = vi.fn(() => {
      this.state = "unconfigured";
      this.decodeQueueSize = 0;
    });
    close() {
      this.state = "closed";
    }
    decode = vi.fn();
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

  it("waits for iOS input admission and respects native input loss and recovery", async () => {
    const { client, sockets, events } = recoveryFixture();
    client.start();
    await vi.advanceTimersByTimeAsync(0);
    const socket = sockets[0]!;
    socket.onopen?.();
    expect(events.onInputConnected).not.toHaveBeenCalledWith(true);
    socket.onmessage?.({ data: new Uint8Array([0x83]).buffer });
    expect(events.onInputConnected).toHaveBeenLastCalledWith(true);
    const config = (inputUnavailable: boolean) => {
      const json = new TextEncoder().encode(
        JSON.stringify({ width: 400, height: 800, orientation: "portrait", inputUnavailable }),
      );
      const packet = new Uint8Array(1 + json.length);
      packet[0] = 0x82;
      packet.set(json, 1);
      socket.onmessage?.({ data: packet.buffer });
    };
    config(true);
    expect(events.onInputConnected).toHaveBeenLastCalledWith(
      false,
      "Simulator input is unavailable",
    );
    socket.send.mockClear();
    client.sendTouch("begin", 0.2, 0.3);
    client.pressButton("home");
    expect(socket.send).not.toHaveBeenCalled();
    config(false);
    expect(events.onInputConnected).toHaveBeenLastCalledWith(true, undefined);
    client.sendTouch("begin", 0.2, 0.3);
    expect(socket.send).toHaveBeenCalledOnce();
    client.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("requires admission on each iOS socket and does not mistake config for admission", async () => {
    const { client, sockets, events, imageReady } = recoveryFixture();
    client.start();
    await vi.advanceTimersByTimeAsync(0);
    imageReady();
    const config = (socket: (typeof sockets)[number], unavailable: boolean) => {
      const json = new TextEncoder().encode(
        JSON.stringify({
          width: 400,
          height: 800,
          orientation: "portrait",
          inputUnavailable: unavailable,
          supportsHingeAngle: true,
        }),
      );
      socket.onmessage?.({ data: Uint8Array.of(0x82, ...json).buffer });
    };
    const controls = () => {
      client.sendTouch("begin", 0.2, 0.3);
      client.pressButton("home");
      client.sendKey({ code: "KeyA" } as KeyboardEvent, "down");
      client.setOrientation("landscape_left");
      client.controlDuo({ control: "angle", value: 90 });
    };
    const first = sockets[0]!;
    config(first, false);
    controls();
    expect(first.send).not.toHaveBeenCalled();
    expect(events.onInputConnected).not.toHaveBeenCalledWith(true, undefined);
    config(first, true);
    first.onmessage?.({ data: Uint8Array.of(0x83).buffer });
    controls();
    expect(first.send).not.toHaveBeenCalled();
    expect(events.onInputConnected).toHaveBeenLastCalledWith(false);
    config(first, false);
    client.pressButton("home");
    expect(first.send).toHaveBeenCalled();
    first.onclose?.({ code: 1013, reason: "retry" });
    await vi.advanceTimersByTimeAsync(1_000);
    const replacement = sockets[1]!;
    config(replacement, false);
    controls();
    expect(replacement.send).not.toHaveBeenCalled();
    first.onmessage?.({ data: Uint8Array.of(0x83).buffer });
    expect(events.onInputConnected).toHaveBeenLastCalledWith(false, undefined);
    replacement.onmessage?.({ data: Uint8Array.of(0x83).buffer });
    client.pressButton("home");
    expect(replacement.send).toHaveBeenCalledOnce();
    client.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reopens a backlogged iOS feed for a fresh keyframe while keeping input connected", async () => {
    const { client, videoBodies, decoders, events, decodedFrame, signals, sockets, drawImage } =
      recoveryFixture("ios", false);
    client.start();
    await vi.advanceTimersByTimeAsync(0);
    const socket = sockets[0]!;
    socket.onmessage?.({ data: Uint8Array.of(0x83).buffer });
    const body = videoBodies[0]!;
    body.enqueue(new Uint8Array([...envelope(1, [1, 0x64, 0, 0x1f]), ...envelope(2, [1])]));
    await vi.advanceTimersByTimeAsync(0);
    decodedFrame();
    const decoder = decoders[0]!;
    decoder.decodeQueueSize = 9;
    body.enqueue(new Uint8Array([...envelope(3, [2]), ...envelope(3, [3])]));
    await vi.advanceTimersByTimeAsync(0);
    expect(signals[1]!.aborted).toBe(true);
    expect(decoder.state).toBe("closed");
    expect(events.onStatus).toHaveBeenLastCalledWith(
      "connecting",
      expect.stringContaining("fell behind"),
    );
    expect(socket.close).not.toHaveBeenCalled();
    client.sendTouch("begin", 0.2, 0.3);
    expect(socket.send).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(videoBodies).toHaveLength(2);
    videoBodies[1]!.enqueue(
      new Uint8Array([...envelope(1, [1, 0x64, 0, 0x1f]), ...envelope(2, [4])]),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(decoders[1]!.decode).toHaveBeenCalledOnce();
    drawImage.mockClear();
    decodedFrame(0);
    expect(drawImage).not.toHaveBeenCalled();
    decodedFrame();
    expect(drawImage).toHaveBeenCalledOnce();
    expect(events.onMjpegFallback).not.toHaveBeenCalled();
    expect(events.onStatus).toHaveBeenLastCalledWith("streaming", undefined);
    expect(events.onInputConnected).toHaveBeenLastCalledWith(true);
    client.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not repaint a delayed JPEG seed over newer decoded video", async () => {
    const { client, videoBodies, drawImage, decodedFrame } = recoveryFixture("ios", false);
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
    videoBodies[0]!.enqueue(
      new Uint8Array([
        ...envelope(4, [1]),
        ...envelope(1, [1, 0x64, 0, 0x1f]),
        ...envelope(2, [2]),
      ]),
    );
    await vi.advanceTimersByTimeAsync(0);
    decodedFrame();
    const close = vi.fn();
    resolveBitmap({ width: 400, height: 800, close } as unknown as ImageBitmap);
    await vi.advanceTimersByTimeAsync(0);
    expect(drawImage).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    client.stop();
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
    expect(sockets[0]!.send).not.toHaveBeenCalled();
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

it("reopens a stalled AVCC body without disconnecting input, then receives fresh video", async () => {
  const { client, videoBodies, events, signals, sockets, decodedFrame } = recoveryFixture(
    "ios",
    false,
  );
  const close = vi.fn();
  vi.stubGlobal("createImageBitmap", () => Promise.resolve({ width: 400, height: 800, close }));
  try {
    client.start();
    await vi.advanceTimersByTimeAsync(0);
    sockets[0]!.onmessage?.({ data: new Uint8Array([0x83]).buffer });
    videoBodies[0]!.enqueue(new Uint8Array(envelope(4, [1])));
    await vi.advanceTimersByTimeAsync(0);
    expect(events.onStatus).toHaveBeenLastCalledWith("streaming", undefined);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(events.onStatus).toHaveBeenLastCalledWith(
      "connecting",
      expect.stringContaining("stopped receiving video"),
    );
    expect(signals[1]!.aborted).toBe(true);
    expect(sockets[0]!.close).not.toHaveBeenCalled();
    expect(events.onInputConnected).toHaveBeenLastCalledWith(true);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(videoBodies).toHaveLength(2);
    videoBodies[1]!.enqueue(new Uint8Array(envelope(1, [1, 0x64, 0, 0x1f])));
    await vi.advanceTimersByTimeAsync(0);
    decodedFrame();
    expect(events.onStatus).toHaveBeenLastCalledWith("streaming", undefined);
    client.stop();
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    client.stop();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }
});

describe("WebRTC-only iOS devices", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function webRtcFixture(options: {
    webCodecs: boolean;
    offerStatuses?: number[];
    /** The fake peer's ICE gathering state; `gathering` never completes. */
    iceGatheringState?: "complete" | "gathering";
  }) {
    vi.useFakeTimers();
    if (options.webCodecs) {
      vi.stubGlobal("VideoDecoder", vi.fn());
      vi.stubGlobal("EncodedVideoChunk", vi.fn());
    }
    class FakeSocket {
      static OPEN = 1;
      readyState = 1;
      binaryType = "";
      onmessage: unknown = null;
      onclose: unknown = null;
      onerror: unknown = null;
      send = vi.fn();
      close = vi.fn();
    }
    vi.stubGlobal("WebSocket", FakeSocket);
    const peers: FakePeer[] = [];
    class FakePeer {
      iceGatheringState = options.iceGatheringState ?? "complete";
      connectionState = "new";
      localDescription: { type: string; sdp: string } | null = null;
      remoteDescription: unknown = null;
      ontrack: ((event: { streams: unknown[]; track: unknown }) => void) | null = null;
      onconnectionstatechange: (() => void) | null = null;
      closed = false;
      readonly config: unknown;
      readonly codecPreferences = vi.fn();
      constructor(config: unknown) {
        this.config = config;
        peers.push(this);
      }
      addTransceiver() {
        return { setCodecPreferences: this.codecPreferences };
      }
      async createOffer() {
        return { type: "offer", sdp: "v=0 offer" };
      }
      async setLocalDescription(description: { type: string; sdp: string }) {
        this.localDescription = description;
      }
      async setRemoteDescription(description: unknown) {
        this.remoteDescription = description;
      }
      addEventListener() {}
      removeEventListener() {}
      close() {
        this.closed = true;
      }
    }
    vi.stubGlobal("RTCPeerConnection", FakePeer);
    vi.stubGlobal("RTCRtpReceiver", {
      getCapabilities: () => ({ codecs: [{ mimeType: "video/VP8" }, { mimeType: "video/H264" }] }),
    });
    const frameCallbacks: Array<() => void> = [];
    const video = {
      muted: false,
      playsInline: false,
      srcObject: null as unknown,
      videoWidth: 402,
      videoHeight: 874,
      style: { cssText: "" },
      setAttribute: vi.fn(),
      remove: vi.fn(),
      play: vi.fn(() => Promise.resolve()),
      requestVideoFrameCallback: vi.fn((callback: () => void) => {
        frameCallbacks.push(callback);
      }),
    };
    vi.stubGlobal("document", { createElement: () => video, body: { append: vi.fn() } });
    const offerStatuses = [...(options.offerStatuses ?? [])];
    const fetch = vi.fn((url: string) => {
      const path = new URL(url).pathname;
      if (path.endsWith("/stream.avcc"))
        return Promise.resolve(
          Response.json({ error: "stream_transport_locked", transport: "webrtc" }, { status: 409 }),
        );
      if (path.endsWith("/vendor/serve-sim/api"))
        return Promise.resolve(
          Response.json({
            streamSettings: { transport: "webrtc", iceServers: [{ urls: ["stun:stun.test"] }] },
          }),
        );
      if (path.endsWith("/webrtc/offer")) {
        const status = offerStatuses.shift() ?? 200;
        return Promise.resolve(
          status === 200
            ? Response.json({ type: "answer", sdp: "v=0 answer" })
            : Response.json({ error: "webrtc_session_busy" }, { status }),
        );
      }
      if (path.endsWith("/webrtc/close"))
        return Promise.resolve(new Response(null, { status: 204 }));
      return Promise.resolve(new Response("refused", { status: 409 }));
    });
    vi.stubGlobal("fetch", fetch);
    const presented: Array<[unknown, number, number]> = [];
    const events = {
      onStatus: vi.fn(),
      onScreen: vi.fn(),
      onUnauthorized: vi.fn(),
      onMjpegFallback: vi.fn(),
      onCanvasVideo: vi.fn(),
      onInputConnected: vi.fn(),
    };
    const client = createDeviceStreamClient(
      {
        platform: "ios",
        deviceId: "udid-1",
        preferMjpeg: !options.webCodecs,
        access: {
          httpBase: "https://environment.test/api/device-hub",
          wsBase: "wss://environment.test/api/device-hub",
          credentials: false,
          query: { hostId: "eas" },
        },
      },
      {
        present: (source, width, height) => {
          presented.push([source, width, height]);
          return true;
        },
      },
      events,
    );
    const requests = (suffix: string) =>
      fetch.mock.calls.filter(([url]) => new URL(url).pathname.endsWith(suffix));
    const bodyOf = (call: unknown[]) =>
      JSON.parse(String((call[1] as RequestInit | undefined)?.body)) as Record<string, unknown>;
    const settle = async () => {
      for (let turn = 0; turn < 20; turn++) await vi.advanceTimersByTimeAsync(0);
    };
    return { client, peers, video, frameCallbacks, presented, events, requests, bodyOf, settle };
  }

  it("switches to WebRTC when serve-sim refuses AVCC and releases the session on stop", async () => {
    const fixture = webRtcFixture({ webCodecs: true });
    fixture.client.start();
    await fixture.settle();
    expect(fixture.peers).toHaveLength(1);
    const peer = fixture.peers[0]!;
    expect(peer.config).toEqual({
      iceServers: [{ urls: ["stun:stun.test"] }],
      iceTransportPolicy: "all",
    });
    expect(peer.codecPreferences).toHaveBeenCalledWith([
      { mimeType: "video/H264" },
      { mimeType: "video/VP8" },
    ]);
    const offers = fixture.requests("/helper/udid-1/webrtc/offer");
    expect(offers).toHaveLength(1);
    const offer = fixture.bodyOf(offers[0]!);
    expect(offer).toMatchObject({ type: "offer", sdp: "v=0 offer", codec: "h264" });
    expect(offer.sessionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(peer.remoteDescription).toEqual({ type: "answer", sdp: "v=0 answer" });

    peer.ontrack?.({ streams: [{}], track: {} });
    fixture.frameCallbacks.shift()?.();
    expect(fixture.presented).toEqual([[fixture.video, 402, 874]]);
    expect(fixture.events.onStatus).toHaveBeenLastCalledWith("streaming", undefined);

    fixture.client.stop();
    expect(peer.closed).toBe(true);
    expect(fixture.video.remove).toHaveBeenCalled();
    const closes = fixture.requests("/helper/udid-1/webrtc/close");
    expect(closes.map(fixture.bodyOf)).toEqual([{ sessionId: offer.sessionId }]);
  });

  it("reconnects a WebRTC feed that stops producing frames", async () => {
    const fixture = webRtcFixture({ webCodecs: true });
    fixture.client.start();
    await fixture.settle();
    const peer = fixture.peers[0]!;
    peer.ontrack?.({ streams: [{}], track: {} });
    fixture.frameCallbacks.shift()?.();
    expect(fixture.events.onStatus).toHaveBeenLastCalledWith("streaming", undefined);
    // Frames keep coming: nothing happens.
    await vi.advanceTimersByTimeAsync(10_000);
    fixture.frameCallbacks.shift()?.();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fixture.peers).toHaveLength(1);
    expect(peer.closed).toBe(false);
    // Then none for the first-frame deadline (checked every 5 s): the feed
    // reconnects through the usual retry path.
    await vi.advanceTimersByTimeAsync(15_000);
    expect(peer.closed).toBe(true);
    expect(fixture.events.onStatus).toHaveBeenLastCalledWith(
      "connecting",
      "Device stream stalled. Reconnecting…",
    );
    await vi.advanceTimersByTimeAsync(1_000);
    await fixture.settle();
    expect(fixture.peers).toHaveLength(2);
    expect(fixture.peers[1]!.remoteDescription).toEqual({ type: "answer", sdp: "v=0 answer" });
    fixture.client.stop();
  });

  it("retries instead of offering when ICE gathering times out without a candidate", async () => {
    const fixture = webRtcFixture({ webCodecs: true, iceGatheringState: "gathering" });
    fixture.client.start();
    await fixture.settle();
    expect(fixture.peers).toHaveLength(1);
    expect(fixture.requests("/helper/udid-1/webrtc/offer")).toHaveLength(0);
    // The gathering deadline passes with no reflexive or relay candidate: no
    // offer is sent, the attempt is retried with twice the deadline.
    await vi.advanceTimersByTimeAsync(2_000);
    expect(fixture.peers[0]!.closed).toBe(true);
    expect(fixture.requests("/helper/udid-1/webrtc/offer")).toHaveLength(0);
    expect(fixture.events.onStatus).toHaveBeenLastCalledWith(
      "connecting",
      "Device stream found no network candidates yet. Retrying…",
    );
    await vi.advanceTimersByTimeAsync(1_000);
    await fixture.settle();
    expect(fixture.peers).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(fixture.peers[1]!.closed).toBe(false);
    // The second deadline, 4 s, is the bound: the offer goes as gathered.
    await vi.advanceTimersByTimeAsync(3_000);
    await fixture.settle();
    expect(fixture.peers).toHaveLength(2);
    expect(fixture.peers[1]!.closed).toBe(false);
    expect(fixture.requests("/helper/udid-1/webrtc/offer")).toHaveLength(1);
    fixture.client.stop();
  });

  it("retries a WebRTC offer while another viewer is negotiating", async () => {
    const fixture = webRtcFixture({ webCodecs: true, offerStatuses: [409] });
    fixture.client.start();
    await fixture.settle();
    expect(fixture.peers).toHaveLength(1);
    expect(fixture.peers[0]!.closed).toBe(true);
    await vi.advanceTimersByTimeAsync(1_000);
    await fixture.settle();
    expect(fixture.peers).toHaveLength(2);
    expect(fixture.peers[1]!.remoteDescription).toEqual({ type: "answer", sdp: "v=0 answer" });
    fixture.client.stop();
  });

  it("moves an MJPEG viewer back to the canvas for a WebRTC-only device", async () => {
    const fixture = webRtcFixture({ webCodecs: false });
    const listeners: Record<string, () => void> = {};
    const image = {
      naturalWidth: 0,
      naturalHeight: 0,
      src: "",
      addEventListener: (type: string, listener: () => void) => {
        listeners[type] = listener;
      },
      removeEventListener: vi.fn(),
      removeAttribute: vi.fn(),
    };
    fixture.client.start();
    fixture.client.setMjpegImage(image as unknown as HTMLImageElement);
    expect(fixture.events.onMjpegFallback).toHaveBeenCalledOnce();
    listeners.error?.();
    await fixture.settle();
    expect(fixture.events.onCanvasVideo).toHaveBeenCalledOnce();
    expect(fixture.peers).toHaveLength(1);
    expect(fixture.requests("/helper/udid-1/webrtc/offer")).toHaveLength(1);
    fixture.client.stop();
  });
});
