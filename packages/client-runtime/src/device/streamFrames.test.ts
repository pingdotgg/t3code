import { afterEach, expect, it, vi } from "vite-plus/test";
import { createDeviceStreamClient } from "./stream.ts";

afterEach(() => vi.unstubAllGlobals());

it("delivers borrowed decoded frames to a sink, closes them even on failure, and discards late output after stop", async () => {
  let decoderOutput: VideoFrameOutputCallback | undefined;
  let resolveOutput!: () => void;
  const outputReady = new Promise<void>((resolve) => {
    resolveOutput = resolve;
  });
  class Decoder {
    static isConfigSupported = async () => ({ supported: true });
    state = "unconfigured";
    constructor(options: VideoDecoderInit) {
      decoderOutput = options.output;
      resolveOutput();
    }
    configure() {
      this.state = "configured";
    }
    close() {
      this.state = "closed";
    }
  }
  vi.stubGlobal("VideoDecoder", Decoder);
  vi.stubGlobal("EncodedVideoChunk", vi.fn());
  vi.stubGlobal(
    "WebSocket",
    class {
      close() {}
    },
  );
  const envelope = new Uint8Array([0, 0, 0, 5, 1, 1, 0x64, 0, 0x1f]);
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async (url: string) =>
        new Response(
          url.includes("avcc")
            ? new ReadableStream({
                start(controller) {
                  controller.enqueue(envelope);
                },
              })
            : "seed",
        ),
    ),
  );
  const present = vi.fn();
  const events = {
    onStatus: vi.fn(),
    onScreen: vi.fn(),
    onUnauthorized: vi.fn(),
    onMjpegFallback: vi.fn(),
    onInputConnected: vi.fn(),
  };
  const client = createDeviceStreamClient(
    {
      platform: "ios",
      deviceId: "phone",
      access: {
        httpBase: "https://test",
        wsBase: "wss://test",
        credentials: false,
        query: {},
      },
    },
    { present },
    events,
  );
  client.start();
  await outputReady;
  const frame = {
    displayWidth: 1170,
    displayHeight: 2532,
    close: vi.fn(),
  } as unknown as VideoFrame;
  decoderOutput?.(frame);
  expect(present).toHaveBeenCalledExactlyOnceWith(frame, 1170, 2532);
  expect(frame.close).toHaveBeenCalledOnce();
  present.mockImplementationOnce(() => {
    throw new Error("renderer failed");
  });
  expect(() => decoderOutput?.(frame)).toThrow("renderer failed");
  expect(frame.close).toHaveBeenCalledTimes(2);
  client.stop();
  decoderOutput?.(frame);
  expect(present).toHaveBeenCalledTimes(2);
  expect(frame.close).toHaveBeenCalledTimes(3);
});
