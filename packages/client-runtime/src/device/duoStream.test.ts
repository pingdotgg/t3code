import { afterEach, expect, it, vi } from "vite-plus/test";
import { createDeviceStreamClient, type DeviceScreenSize } from "./stream.ts";
afterEach(() => vi.unstubAllGlobals());

it("switches to fixed authenticated feeds while retaining one HID socket, routes the active panel and rejects superseded decoded output", async () => {
  const feeds: {
    url: string;
    signal: AbortSignal;
    controller: ReadableStreamDefaultController<Uint8Array>;
  }[] = [];
  const outputs: VideoFrameOutputCallback[] = [];
  const errors: VideoDecoderInit["error"][] = [];
  let supported = true;
  let panelHttpStatus = 200;
  let expected = 0;
  let decoderReady = () => {};
  const waitDecoders = (count: number) => {
    expected = count;
    return new Promise<void>((resolve) => {
      decoderReady = resolve;
    });
  };
  class Decoder {
    static isConfigSupported = async () => ({ supported });
    static instances: Decoder[] = [];
    state = "unconfigured";
    constructor(options: VideoDecoderInit) {
      outputs.push(options.output);
      errors.push(options.error);
      Decoder.instances.push(this);
      if (outputs.length === expected) decoderReady();
    }
    configure() {
      this.state = "configured";
    }
    close() {
      this.state = "closed";
    }
  }
  let socketReady = () => {};
  const socketConstructed = new Promise<void>((resolve) => {
    socketReady = resolve;
  });
  class Socket {
    static OPEN = 1;
    static instances: Socket[] = [];
    readyState = 1;
    binaryType = "arraybuffer";
    onopen?: () => void;
    onmessage?: (event: { data: ArrayBuffer }) => void;
    onclose?: (event: { code: number; reason: string }) => void;
    send = vi.fn();
    close = vi.fn();
    constructor() {
      Socket.instances.push(this);
      socketReady();
    }
  }
  vi.stubGlobal("VideoDecoder", Decoder);
  vi.stubGlobal("EncodedVideoChunk", vi.fn());
  vi.stubGlobal("WebSocket", Socket);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, options: { signal: AbortSignal }) => {
      if (!url.includes("avcc")) return new Response("prime");
      if (url.includes("/panel/") && panelHttpStatus !== 200)
        return new Response("unsupported panel", { status: panelHttpStatus });
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          feeds.push({ url, signal: options.signal, controller });
          options.signal.addEventListener("abort", () =>
            controller.error(new DOMException("Aborted", "AbortError")),
          );
        },
      });
      return new Response(stream);
    }),
  );
  const present = vi.fn(),
    cover = vi.fn(),
    inner = vi.fn();
  let panelFailed = () => {};
  const panelFailure = new Promise<void>((resolve) => {
    panelFailed = resolve;
  });
  const onStatus = vi.fn();
  const onDuoControl = vi.fn();
  const onDuoUnavailable = vi.fn((_detail?: string) => panelFailed());
  const client = createDeviceStreamClient(
    {
      platform: "ios",
      deviceId: "duo",
      access: {
        httpBase: "https://t3.test/api/device-hub",
        wsBase: "wss://t3.test/api/device-hub",
        credentials: true,
        query: { hostId: "remote", wsTicket: "ticket" },
      },
    },
    { present },
    {
      onStatus,
      onDuoControl,
      onDuoUnavailable,
      onScreen: vi.fn(),
      onInputConnected: vi.fn(),
      onUnauthorized: vi.fn(),
      onMjpegFallback: vi.fn(),
    },
  );
  client.start();
  await socketConstructed;
  const ws = Socket.instances[0]!;
  const config = (id: number, orientation: DeviceScreenSize["orientation"] = "portrait") => {
    const json = new TextEncoder().encode(
      JSON.stringify({
        width: id === 1 ? 1398 : 2007,
        height: id === 1 ? 2034 : 2853,
        orientation,
        screenId: id,
        supportsHingeAngle: true,
        hingePose: "open",
      }),
    );
    const packet = new Uint8Array(json.length + 1);
    packet[0] = 0x82;
    packet.set(json, 1);
    ws.onmessage?.({ data: packet.buffer });
  };
  config(3);
  const requestedOrientation = () =>
    JSON.parse(new TextDecoder().decode(ws.send.mock.lastCall?.[0].subarray(1))).orientation;
  client.rotate();
  expect(requestedOrientation()).toBe("landscape_left");
  config(3); // An orientation-locked app keeps its framebuffer orientation after the sensor rotates.
  expect(onDuoControl.mock.lastCall?.[0].error).toBeNull();
  client.rotate();
  expect(requestedOrientation()).toBe("portrait_upside_down");
  config(3, "portrait_upside_down");
  client.rotate();
  expect(requestedOrientation()).toBe("landscape_right");
  config(3); // An external native orientation change becomes authoritative again.
  client.rotate();
  expect(requestedOrientation()).toBe("landscape_left");
  config(3, "landscape_left");
  expect(onDuoControl.mock.lastCall?.[0].pending).toBe(false);
  client.controlDuo({ control: "angle", value: 40 });
  const angleRequest = JSON.parse(new TextDecoder().decode(ws.send.mock.lastCall?.[0].subarray(1)));
  const before = ws.send.mock.calls.length;
  client.controlDuo({ control: "orientation", value: "portrait" });
  expect(ws.send.mock.calls.length).toBe(before);
  config(3, "landscape_left"); // The angle's config precedes its receipt; it cannot acknowledge a queued rotation.
  const reply = new TextEncoder().encode(
    JSON.stringify({ requestId: angleRequest.requestId, ok: true }),
  );
  const receipt = new Uint8Array(reply.length + 1);
  receipt[0] = 0x90;
  receipt.set(reply, 1);
  ws.onmessage?.({ data: receipt.buffer });
  expect(requestedOrientation()).toBe("portrait");
  expect(ws.send.mock.lastCall?.[0][0]).toBe(0x07);
  client.controlDuo({ control: "angle", value: 55 });
  const orientationSends = ws.send.mock.calls.length;
  expect(onDuoControl.mock.lastCall?.[0].pending).toBe(true);
  config(3);
  expect(ws.send.mock.calls.length).toBe(orientationSends + 1);
  const after = JSON.parse(new TextDecoder().decode(ws.send.mock.lastCall?.[0].subarray(1)));
  expect(after.command).toEqual({ control: "angle", value: 55 });
  const finalReply = new TextEncoder().encode(
    JSON.stringify({ requestId: after.requestId, ok: true }),
  );
  const finalReceipt = new Uint8Array(finalReply.length + 1);
  finalReceipt[0] = 0x90;
  finalReceipt.set(finalReply, 1);
  ws.onmessage?.({ data: finalReceipt.buffer });
  expect(onDuoControl.mock.lastCall?.[0].pending).toBe(false);
  const description = new Uint8Array([0, 0, 0, 5, 1, 1, 0x64, 0, 0x1f]);
  let ready = waitDecoders(1);
  feeds[0]!.controller.enqueue(description);
  await ready;
  client.setDuoPanels({ cover: { present: cover }, inner: { present: inner } });
  expect(feeds[0]!.signal.aborted).toBe(true);
  expect(Socket.instances).toHaveLength(1);
  for (const [index, id] of [
    [1, 1],
    [2, 3],
  ]) {
    const url = new URL(feeds[index!]!.url);
    expect(url.pathname.endsWith(`/panel/${id}/stream.avcc`)).toBe(true);
    expect(url.searchParams.get("hostId")).toBe("remote");
    expect(url.searchParams.get("wsTicket")).toBe("ticket");
  }
  ready = waitDecoders(3);
  feeds[1]!.controller.enqueue(description);
  feeds[2]!.controller.enqueue(description);
  await ready;
  const frame = {
    displayWidth: 2007,
    displayHeight: 2853,
    close: vi.fn(),
  } as unknown as VideoFrame;
  outputs[0]!(frame);
  expect(present).not.toHaveBeenCalled();
  outputs[1]!(frame);
  expect(cover).not.toHaveBeenCalled();
  outputs[2]!(frame);
  expect(inner).toHaveBeenCalledOnce();
  expect(present).toHaveBeenCalledOnce();
  config(1);
  outputs[2]!(frame);
  expect(inner).toHaveBeenCalledOnce();
  outputs[1]!(frame);
  expect(cover).toHaveBeenCalledOnce();
  client.setDuoPanels(null);
  expect(feeds[1]!.signal.aborted).toBe(true);
  expect(feeds[2]!.signal.aborted).toBe(true);
  expect(feeds[3]!.url).not.toContain("/panel/");
  outputs[1]!(frame);
  expect(cover).toHaveBeenCalledOnce();
  ready = waitDecoders(4);
  feeds[3]!.controller.enqueue(description);
  await ready;
  errors[0]!(new DOMException("Late decoder failure"));
  expect(Decoder.instances[3]!.state).toBe("configured");
  supported = false;
  client.setDuoPanels({ cover: { present: cover }, inner: { present: inner } });
  feeds[4]!.controller.enqueue(description);
  await panelFailure;
  expect(onDuoUnavailable).toHaveBeenCalled();
  expect(onStatus.mock.calls.some(([status]) => status === "error")).toBe(false);
  panelHttpStatus = 404;
  const missingPanel = new Promise<void>((resolve) => {
    panelFailed = resolve;
  });
  client.setDuoPanels({ cover: { present: cover }, inner: { present: inner } });
  await missingPanel;
  expect(onDuoUnavailable.mock.lastCall?.[0]).toContain("does not provide fixed Duo");
  expect(Socket.instances).toHaveLength(1);
  client.stop();
  expect(feeds[3]!.signal.aborted).toBe(true);
  expect(ws.close).toHaveBeenCalledOnce();
  expect(frame.close).toHaveBeenCalledTimes(6);
});
