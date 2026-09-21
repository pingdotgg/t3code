// @effect-diagnostics globalFetch:off globalTimers:off - This browser and WebView transport runs without an Effect runtime.
/* oxlint-disable unicorn/prefer-add-event-listener -- Each client owns its sockets and their handlers. */

/**
 * Framework-free client for expo-device-hub's per-device streams, reached
 * through the T3 proxy. One class handles both platforms because the hub
 * vendors two servers with different wire formats:
 *
 * - iOS (serve-sim): video is an HTTP `stream.avcc` body of length-prefixed
 *   envelopes (`u32be length, u8 tag, payload`; tag 1 avcC description,
 *   2 keyframe, 3 delta, 4 JPEG seed) decoded with WebCodecs; input goes over
 *   `helper/ws?device=<udid>` as `[tag][json]` packets. When WebCodecs is
 *   unavailable (plain-http remote origins) the MJPEG endpoint is used as an
 *   `<img>` source instead.
 * - Android (serve-emu): one WebSocket at `ws?device=<serial>&frame-meta=1`
 *   carries H.264 access units prefixed with a 16-byte "SEMU" header
 *   (magic, version, key flag, pts) and accepts JSON gestures upstream.
 *
 * The decoder only runs while frames arrive and the viewer is attached; a
 * hidden panel calls `stop()` so an idle device costs nothing on the GPU.
 */
import {
  createDuoControl,
  type DuoCommand,
  type DuoControlState,
  type DuoPose,
} from "./duoControl.ts";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import { createCanvasFrameSink, type DeviceFrameSink } from "./frame.ts";
import { type DeviceHubAccess, withDeviceHubQuery } from "./hubAccess.ts";
import type { DevicePlatform } from "@t3tools/contracts";

export type DeviceStreamStatus = "connecting" | "streaming" | "error";

export interface DeviceScreenSize {
  readonly width: number;
  readonly height: number;
  readonly orientation: "portrait" | "portrait_upside_down" | "landscape_left" | "landscape_right";
  readonly screenId?: number;
  readonly supportsHingeAngle?: boolean;
  readonly supportsPhysicalOrientation?: boolean;
  readonly hingeAngle?: number;
  readonly hingePose?: DuoPose | null;
  readonly tableMode?: boolean;
  readonly tableModeAvailable?: boolean;
}

const screenConfigSchema = Schema.Struct({
  width: Schema.Finite.check(Schema.isGreaterThan(0)),
  height: Schema.Finite.check(Schema.isGreaterThan(0)),
  orientation: Schema.Literals([
    "portrait",
    "portrait_upside_down",
    "landscape_left",
    "landscape_right",
  ]),
  screenId: Schema.optionalKey(Schema.Number),
  supportsHingeAngle: Schema.optionalKey(Schema.Boolean),
  supportsPhysicalOrientation: Schema.optionalKey(Schema.Boolean),
  hingeAngle: Schema.optionalKey(
    Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 180 })),
  ),
  hingePose: Schema.optionalKey(
    Schema.NullOr(Schema.Literals(["closed", "book", "open", "laptop", "tent"])),
  ),
  tableMode: Schema.optionalKey(Schema.Boolean),
  tableModeAvailable: Schema.optionalKey(Schema.Boolean),
});
const controlReplySchema = Schema.Struct({
  requestId: Schema.Int,
  ok: Schema.Boolean,
  error: Schema.optionalKey(Schema.String),
});
const decodeScreenConfig = Schema.decodeUnknownOption(screenConfigSchema);
const decodeControlReply = Schema.decodeUnknownOption(controlReplySchema);

export interface DuoPanelSinks {
  readonly cover: DeviceFrameSink;
  readonly inner: DeviceFrameSink;
  /** Invalidate captured input synchronously, before React can commit the new layout. */
  readonly onScreen?: (screen: DeviceScreenSize) => void;
}

export interface DeviceStreamEvents {
  readonly onDuoControl?: (state: DuoControlState) => void;
  /** A fixed panel cannot be decoded; the owner should return to the active flat feed. */
  readonly onDuoUnavailable?: (detail?: string) => void;
  readonly onStatus: (status: DeviceStreamStatus, detail?: string) => void;
  readonly onScreen: (screen: DeviceScreenSize) => void;
  /** The proxy rejected the credential; the owner should refresh access and reconnect. */
  readonly onUnauthorized: () => void;
  /**
   * H.264 cannot be decoded here (no WebCodecs, or the simulator's profile is
   * unsupported); the owner should show an `<img>` instead of the canvas
   * and attach it with `setMjpegImage` so the client can observe real frames.
   */
  readonly onMjpegFallback: (url: string) => void;
  /** Whether touches and keys can currently reach the device. */
  readonly onInputConnected: (connected: boolean, detail?: string) => void;
}

export interface DeviceStreamTarget {
  readonly platform: DevicePlatform;
  readonly deviceId: string;
  readonly access: DeviceHubAccess;
  /** Native iOS WebViews can use MJPEG without cross-origin fetch or secure-context support. */
  readonly preferMjpeg?: boolean;
  /** Internal fixed-panel feeds share their parent's input session. */
  readonly panelId?: 1 | 3;
  readonly videoOnly?: boolean;
}

export type DeviceHardwareButton = "home" | "back" | "recents" | "power" | "appSwitcher";

const RETRY_DELAY_MS = 1_000;
const FIRST_FRAME_TIMEOUT_MS = 15_000;
const MJPEG_FRAME_CHECK_MS = 250;
const FRAME_DURATION_US = 16_667;
const SEMU_MAGIC = 0x53454d55;
const SEMU_HEADER_BYTES = 16;
const SEMU_FLAG_KEY = 1;
const SOFT_DECODE_QUEUE = 8;

// serve-sim binary WS message tags (browser -> helper).
const IOS_MSG_TOUCH = 0x03;
const IOS_MSG_BUTTON = 0x04;
const IOS_MSG_KEY = 0x06;
const IOS_MSG_ORIENTATION = 0x07;
const IOS_MSG_HARDWARE_KEYBOARD = 0x0d;
// helper -> browser.
const IOS_TAG_SCREEN_CONFIG = 0x82;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const isWebCodecsSupported = (): boolean =>
  typeof globalThis !== "undefined" &&
  "VideoDecoder" in globalThis &&
  "EncodedVideoChunk" in globalThis;

function taggedJson(tag: number, payload: unknown): Uint8Array<ArrayBuffer> {
  const json = encoder.encode(JSON.stringify(payload));
  const out = new Uint8Array(1 + json.length);
  out[0] = tag;
  out.set(json, 1);
  return out;
}

/** Build the WebCodecs `avc1.PPCCLL` string from an avcC record or an SPS NAL. */
export function avcCodecString(bytes: Uint8Array): string {
  if (bytes.length < 4) return "avc1.42E01E";
  const hex = (byte: number) => byte.toString(16).padStart(2, "0");
  return `avc1.${hex(bytes[1]!)}${hex(bytes[2]!)}${hex(bytes[3]!)}`;
}

/** Split serve-emu's SEMU-framed message into metadata and the Annex-B payload. */
export function parseSemuPacket(raw: ArrayBuffer): {
  readonly data: Uint8Array;
  readonly isKey: boolean | null;
  readonly timestamp: number | null;
} {
  const bytes = new Uint8Array(raw);
  if (bytes.byteLength > SEMU_HEADER_BYTES) {
    const view = new DataView(raw, 0, SEMU_HEADER_BYTES);
    if (view.getUint32(0, false) === SEMU_MAGIC && view.getUint8(4) === 1) {
      const pts = view.getBigUint64(8, false);
      return {
        data: bytes.subarray(SEMU_HEADER_BYTES),
        isKey: (view.getUint8(5) & SEMU_FLAG_KEY) !== 0,
        timestamp: pts <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(pts) : null,
      };
    }
  }
  return { data: bytes, isKey: null, timestamp: null };
}

const isVideoSessionMessage = (text: string) => {
  try {
    const message = JSON.parse(text) as { type?: unknown };
    return message.type === "video-session";
  } catch {
    return false;
  }
};

/** Walk an Annex-B access unit for its keyframe flag and SPS bytes. */
export function scanAccessUnit(buf: Uint8Array): { isKey: boolean; sps: Uint8Array | null } {
  let isKey = false;
  let sps: Uint8Array | null = null;
  const len = buf.length;
  let i = 0;
  while (i + 2 < len) {
    if (buf[i] === 0 && buf[i + 1] === 0) {
      let codeLen = 0;
      if (buf[i + 2] === 1) codeLen = 3;
      else if (i + 3 < len && buf[i + 2] === 0 && buf[i + 3] === 1) codeLen = 4;
      if (codeLen) {
        const nalType = buf[i + codeLen]! & 0x1f;
        if (nalType === 7 && !sps) sps = buf.subarray(i + codeLen);
        if (nalType === 5) isKey = true;
        i += codeLen + 1;
        continue;
      }
    }
    i++;
  }
  return { isKey, sps };
}

export type AvccChunk = {
  readonly type: "description" | "keyframe" | "delta" | "seed";
  readonly payload: Uint8Array;
};

const AVCC_TAGS: Record<number, AvccChunk["type"] | undefined> = {
  1: "description",
  2: "keyframe",
  3: "delta",
  4: "seed",
};

/** Turns a fragmented AVCC byte stream into complete envelopes. */
export class AvccDemuxer {
  private buffer = new Uint8Array(64 * 1024);
  private length = 0;

  push(bytes: Uint8Array): AvccChunk[] {
    if (this.length + bytes.length > this.buffer.length) {
      let capacity = this.buffer.length;
      while (capacity < this.length + bytes.length) capacity *= 2;
      const grown = new Uint8Array(capacity);
      grown.set(this.buffer.subarray(0, this.length));
      this.buffer = grown;
    }
    this.buffer.set(bytes, this.length);
    this.length += bytes.length;

    const chunks: AvccChunk[] = [];
    let offset = 0;
    while (this.length - offset >= 4) {
      const view = new DataView(this.buffer.buffer, this.buffer.byteOffset + offset, 4);
      const frameLength = view.getUint32(0, false);
      if (this.length - offset - 4 < frameLength) break;
      if (frameLength >= 1) {
        const type = AVCC_TAGS[this.buffer[offset + 4]!];
        if (type) {
          chunks.push({ type, payload: this.buffer.slice(offset + 5, offset + 4 + frameLength) });
        }
      }
      offset += 4 + frameLength;
    }
    if (offset > 0) {
      this.buffer.copyWithin(0, offset, this.length);
      this.length -= offset;
    }
    return chunks;
  }

  reset(): void {
    this.length = 0;
  }
}

export interface DeviceStreamClient {
  readonly start: () => void;
  readonly stop: () => void;
  /**
   * Own the displayed MJPEG image's source and frame/error observation.
   * `stop()` detaches it; attach a fresh image for each restart.
   */
  readonly setMjpegImage: (image: HTMLImageElement | null) => void;
  /** Normalized 0..1 coordinates in the displayed frame. */
  readonly sendTouch: (phase: "begin" | "move" | "end", x: number, y: number) => void;
  readonly sendKey: (event: KeyboardEvent, phase: "down" | "up") => void;
  readonly pressButton: (button: DeviceHardwareButton) => void;
  readonly rotate: () => void;
  readonly setOrientation: (orientation: DeviceScreenSize["orientation"]) => void;
  readonly controlDuo: (command: DuoCommand) => void;
  /** Switch between one active feed and two fixed-panel feeds without replacing HID. */
  readonly setDuoPanels: (panels: DuoPanelSinks | null) => void;
  /** Model UVs already map to the hardware framebuffer. */
  readonly sendRawTouch: (phase: "begin" | "move" | "end", x: number, y: number) => void;
}

const HID_USAGE_BY_CODE: Readonly<Record<string, number>> = {
  Enter: 0x28,
  Escape: 0x29,
  Backspace: 0x2a,
  Tab: 0x2b,
  Space: 0x2c,
  Minus: 0x2d,
  Equal: 0x2e,
  BracketLeft: 0x2f,
  BracketRight: 0x30,
  Backslash: 0x31,
  Semicolon: 0x33,
  Quote: 0x34,
  Backquote: 0x35,
  Comma: 0x36,
  Period: 0x37,
  Slash: 0x38,
  Delete: 0x4c,
  ArrowRight: 0x4f,
  ArrowLeft: 0x50,
  ArrowDown: 0x51,
  ArrowUp: 0x52,
  ControlLeft: 0xe0,
  ShiftLeft: 0xe1,
  AltLeft: 0xe2,
  MetaLeft: 0xe3,
  ControlRight: 0xe4,
  ShiftRight: 0xe5,
  AltRight: 0xe6,
  MetaRight: 0xe7,
};

function hidUsageForCode(code: string): number | null {
  if (/^Key[A-Z]$/.test(code)) return 0x04 + (code.charCodeAt(3) - 65);
  if (/^Digit[1-9]$/.test(code)) return 0x1e + (code.charCodeAt(5) - 49);
  if (code === "Digit0") return 0x27;
  return HID_USAGE_BY_CODE[code] ?? null;
}

const ANDROID_KEYCODE_BY_KEY: Readonly<Record<string, number>> = {
  ArrowUp: 19,
  ArrowDown: 20,
  ArrowLeft: 21,
  ArrowRight: 22,
  Tab: 61,
  Enter: 66,
  Backspace: 67,
  Delete: 112,
  Home: 122,
  End: 123,
  PageUp: 92,
  PageDown: 93,
};

const IOS_ORIENTATIONS: ReadonlyArray<DeviceScreenSize["orientation"]> = [
  "portrait",
  "landscape_left",
  "portrait_upside_down",
  "landscape_right",
];

export function createDeviceStreamClient(
  target: DeviceStreamTarget,
  output: HTMLCanvasElement | DeviceFrameSink,
  events: DeviceStreamEvents,
): DeviceStreamClient {
  const { access, platform, deviceId } = target;
  const sink = "present" in output ? output : createCanvasFrameSink(output);
  const vendor = platform === "ios" ? "/vendor/serve-sim" : "/vendor/serve-emu";
  const device = encodeURIComponent(deviceId);
  const httpUrl = (path: string) =>
    withDeviceHubQuery(`${access.httpBase}${vendor}${path}`, access);
  const wsUrl = (path: string) => withDeviceHubQuery(`${access.wsBase}${vendor}${path}`, access);
  const useWebCodecs = isWebCodecsSupported() && !(platform === "ios" && target.preferMjpeg);

  let stopped = true;
  let socket: WebSocket | null = null;
  let controller: AbortController | null = null;
  const retryTimers = new Map<"video" | "input", ReturnType<typeof setTimeout>>();
  let primeController: AbortController | null = null;
  let videoDecoder: VideoDecoder | null = null;
  let timestamp = 0;
  let awaitingKeyframe = true;
  let screen: DeviceScreenSize | null = null;
  let firstFrame = false;
  let configuring = false;
  let mjpeg = false;
  let generation = 0;
  let decoderEpoch = 0;
  let frameTimer: ReturnType<typeof setTimeout> | null = null;
  let videoReadTimer: ReturnType<typeof setTimeout> | null = null;
  let mjpegImage: HTMLImageElement | null = null;
  let releaseImage: (() => void) | null = null;
  let videoGeneration = 0;
  let panelClients: DeviceStreamClient[] = [];
  let panelSinks: DuoPanelSinks | null = null;
  let rotationCursor: DeviceScreenSize["orientation"] | null = null;
  let pendingOrientation: { requestId: number } | null = null;
  const duoControl = createDuoControl({
    send(request) {
      if (socket?.readyState !== WebSocket.OPEN || !screen?.supportsHingeAngle) return false;
      if (request.command.control === "physical" && !screen.supportsPhysicalOrientation)
        return false;
      try {
        pendingOrientation = null;
        if (request.command.control === "orientation") {
          const value = request.command.value;
          pendingOrientation = { requestId: request.requestId };
          rotationCursor = value;
          // Upstream serializes orientation with hinge commands, then broadcasts config.
          // An orientation-locked app can keep its framebuffer orientation after the sensor rotates.
          socket.send(taggedJson(IOS_MSG_ORIENTATION, { orientation: value }));
        } else socket.send(taggedJson(0x10, request));
        return true;
      } catch {
        return false;
      }
    },
    onChange(state) {
      if (!state.pending) pendingOrientation = null;
      events.onDuoControl?.(state);
    },
  });
  const videoPath = `/helper/${device}${target.panelId ? `/panel/${target.panelId}` : ""}/stream.avcc`;

  const mjpegUrl = () => httpUrl(`/helper/${device}/stream.mjpeg`);

  const setStatus = (status: DeviceStreamStatus, detail?: string) => {
    if (!stopped) events.onStatus(status, detail);
  };

  const clearFrameTimer = () => {
    if (frameTimer !== null) clearTimeout(frameTimer);
    frameTimer = null;
  };

  const fail = (detail: string) => {
    if (stopped) return;
    stop();
    events.onInputConnected(false, detail);
    events.onStatus("error", detail);
  };

  const connecting = (detail?: string) => {
    firstFrame = false;
    if (frameTimer === null) {
      frameTimer = setTimeout(
        () => fail("No video received from the device. Reconnect to try again."),
        FIRST_FRAME_TIMEOUT_MS,
      );
    }
    setStatus("connecting", detail);
  };

  const frameReceived = () => {
    if (firstFrame) return;
    firstFrame = true;
    clearFrameTimer();
    setStatus("streaming");
  };

  const observeMjpegImage = () => {
    releaseImage?.();
    releaseImage = null;
    const image = mjpegImage;
    if (!image || stopped || !mjpeg) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let released = false;
    const check = () => {
      if (released || stopped) return;
      if (timer !== null) clearTimeout(timer);
      timer = null;
      if (image.naturalWidth > 0 && image.naturalHeight > 0) frameReceived();
      else {
        // Multipart images may not emit load until the response ends. Stop checking after the first frame.
        timer = setTimeout(check, MJPEG_FRAME_CHECK_MS);
      }
    };
    const error = () => {
      if (!released) fail("Could not receive the device stream. Reconnect to try again.");
    };
    image.addEventListener("load", check);
    image.addEventListener("error", error);
    releaseImage = () => {
      released = true;
      if (timer !== null) clearTimeout(timer);
      image.removeEventListener("load", check);
      image.removeEventListener("error", error);
      image.removeAttribute("src");
    };
    image.src = mjpegUrl();
    check();
  };

  const setMjpegImage = (image: HTMLImageElement | null) => {
    if (mjpegImage === image) return;
    releaseImage?.();
    releaseImage = null;
    mjpegImage = image;
    observeMjpegImage();
  };

  const fallBackToMjpeg = () => {
    if (stopped || mjpeg) return;
    mjpeg = true;
    controller?.abort();
    controller = null;
    closeDecoder();
    connecting();
    events.onMjpegFallback(mjpegUrl());
    if (!releaseImage) observeMjpegImage();
  };

  const paint = (source: CanvasImageSource, width: number, height: number) => {
    if (stopped) return;
    if (platform === "android" && (screen?.width !== width || screen.height !== height)) {
      screen = { width, height, orientation: width > height ? "landscape_left" : "portrait" };
      events.onScreen(screen);
    }
    if (!sink.present(source, width, height)) {
      fail("Could not display the device stream. Reconnect to try again.");
      return;
    }
    frameReceived();
  };

  const closeDecoder = () => {
    decoderEpoch++;
    try {
      videoDecoder?.close();
    } catch {
      // Already closed.
    }
    videoDecoder = null;
    awaitingKeyframe = true;
  };

  const recoverDecoder = () => {
    if (platform === "ios") fallBackToMjpeg();
    else {
      closeDecoder();
      connecting("Video decoder restarted.");
      requestKeyframe();
    }
  };

  const makeDecoder = () => {
    const feedGeneration = videoGeneration;
    const decoder = new VideoDecoder({
      output: (frame) => {
        try {
          if (
            videoDecoder === decoder &&
            (platform !== "ios" || feedGeneration === videoGeneration)
          )
            paint(frame, frame.displayWidth, frame.displayHeight);
        } finally {
          frame.close();
        }
      },
      error: () => {
        if (
          stopped ||
          videoDecoder !== decoder ||
          (platform === "ios" && feedGeneration !== videoGeneration)
        )
          return;
        recoverDecoder();
      },
    });
    return decoder;
  };

  /** iOS can fall back to MJPEG when the stream's H.264 profile is unsupported. */
  const configureDecoder = async (
    config: VideoDecoderConfig,
    isCurrent = () => !stopped,
  ): Promise<boolean> => {
    const epoch = decoderEpoch;
    const full: VideoDecoderConfig = { ...config, optimizeForLatency: true };
    const support = await VideoDecoder.isConfigSupported(full).catch(() => ({ supported: false }));
    if (!isCurrent() || epoch !== decoderEpoch) return false;
    if (!support.supported) {
      if (platform === "android") fail(`This browser cannot decode ${config.codec}.`);
      return false;
    }
    try {
      if (!videoDecoder || videoDecoder.state === "closed") videoDecoder = makeDecoder();
      videoDecoder.configure(full);
      return true;
    } catch (cause) {
      if (platform === "android") fail(`Video decoder: ${(cause as Error).message}`);
      return false;
    }
  };

  const decode = (isKey: boolean, data: Uint8Array, pts?: number | null) => {
    if (!videoDecoder || videoDecoder.state !== "configured") return;
    if (awaitingKeyframe) {
      if (!isKey) return;
      awaitingKeyframe = false;
    }
    if (videoDecoder.decodeQueueSize > SOFT_DECODE_QUEUE) {
      recoverDecoder();
      return;
    }
    try {
      videoDecoder.decode(
        new EncodedVideoChunk({
          type: isKey ? "key" : "delta",
          timestamp: pts ?? timestamp,
          data,
        }),
      );
      timestamp += FRAME_DURATION_US;
    } catch {
      recoverDecoder();
    }
  };

  const requestKeyframe = () => {
    if (platform === "android" && socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: "reset-video", ack: false }));
    }
  };

  const scheduleRetry = (channel: "video" | "input", run: () => void) => {
    if (stopped || retryTimers.has(channel)) return;
    retryTimers.set(
      channel,
      setTimeout(() => {
        retryTimers.delete(channel);
        run();
      }, RETRY_DELAY_MS),
    );
  };

  const handleUnauthorized = () => {
    stop();
    events.onInputConnected(false);
    events.onUnauthorized();
  };

  // iOS video: fetch the AVCC body and demux into the decoder.
  const readIosVideo = async () => {
    const lifecycle = generation;
    const feedGeneration = ++videoGeneration;
    const demuxer = new AvccDemuxer();
    const videoController = new AbortController();
    controller = videoController;
    const isCurrent = () =>
      !stopped &&
      generation === lifecycle &&
      videoGeneration === feedGeneration &&
      controller === videoController;
    let retryDetail: string | undefined;
    try {
      const response = await fetch(httpUrl(videoPath), {
        signal: videoController.signal,
        credentials: access.credentials ? "include" : "same-origin",
      });
      if (!isCurrent()) {
        await response.body?.cancel();
        return;
      }
      if (response.status === 401 || response.status === 403) return handleUnauthorized();
      if (target.panelId && [400, 404, 405, 410].includes(response.status)) {
        await response.body?.cancel();
        setStatus("error", "This Device Hub does not provide fixed Duo display feeds.");
        return;
      }
      if (!response.ok || !response.body) throw new Error(`stream ${response.status}`);
      const reader = response.body.getReader();
      for (;;) {
        // An AVCC body can stay open after its helper stops producing frames.
        const timer = setTimeout(() => {
          if (isCurrent()) fail("Device stream stopped receiving video. Reconnect to try again.");
        }, FIRST_FRAME_TIMEOUT_MS);
        videoReadTimer = timer;
        let result: ReadableStreamReadResult<Uint8Array>;
        try {
          result = await reader.read();
        } finally {
          clearTimeout(timer);
          if (videoReadTimer === timer) videoReadTimer = null;
        }
        const { done, value } = result;
        if (!isCurrent()) return;
        if (done) break;
        for (const chunk of demuxer.push(value)) {
          switch (chunk.type) {
            case "seed":
              void createImageBitmap(new Blob([chunk.payload as BlobPart], { type: "image/jpeg" }))
                .then((bitmap) => {
                  try {
                    if (isCurrent()) paint(bitmap, bitmap.width, bitmap.height);
                  } finally {
                    bitmap.close();
                  }
                })
                .catch(() => {});
              break;
            case "description": {
              awaitingKeyframe = true;
              const configured = await configureDecoder(
                { codec: avcCodecString(chunk.payload), description: chunk.payload },
                isCurrent,
              );
              if (!isCurrent()) return;
              if (!configured) {
                await reader.cancel().catch(() => {});
                if (!isCurrent()) return;
                if (target.videoOnly)
                  setStatus(
                    "error",
                    `This browser cannot decode the Duo panel's ${avcCodecString(chunk.payload)} stream.`,
                  );
                else fallBackToMjpeg();
                return;
              }
              break;
            }
            case "keyframe":
            case "delta":
              decode(chunk.type === "keyframe", chunk.payload);
              break;
          }
        }
      }
    } catch (cause) {
      if (!isCurrent()) return;
      retryDetail = (cause as Error).message;
    }
    if (isCurrent()) {
      controller = null;
      videoController.abort();
      closeDecoder();
      connecting(retryDetail);
      scheduleRetry("video", () => void readIosVideo());
    }
  };

  /**
   * serve-sim's helper only accepts HID and pushes its screen config once
   * screen capture is running, and the AVCC stream does not reliably start
   * it. Touching the MJPEG endpoint does; one aborted request is enough.
   */
  const primeIosHelper = async (session: number) => {
    const controller = new AbortController();
    primeController = controller;
    const timeout = setTimeout(() => controller.abort(), 2_000);
    try {
      const response = await fetch(httpUrl(`/helper/${device}/stream.mjpeg`), {
        signal: controller.signal,
        credentials: access.credentials ? "include" : "same-origin",
      });
      if (stopped || generation !== session) return;
      if (response.status === 401 || response.status === 403) return handleUnauthorized();
      await response.body?.getReader().read();
    } catch {
      // A failed prime just means the socket may take a retry to come up.
    } finally {
      clearTimeout(timeout);
      controller.abort();
      if (primeController === controller) primeController = null;
    }
  };

  const startDuoVideo = (panels: DuoPanelSinks) => {
    for (const panel of panelClients) panel.stop();
    // Physical handoff elects a native surface. Fixed-panel encoders can keep
    // an inactive shutdown frame after election, so this build uses one active
    // feed instead of decoding a third stream alongside the two fixed feeds.
    const ids = screen?.supportsPhysicalOrientation ? ([null] as const) : ([1, 3] as const);
    panelClients = ids.map((id) => {
      const output = id === 1 ? panels.cover : panels.inner;
      return createDeviceStreamClient(
        { ...target, ...(id === null ? {} : { panelId: id }), videoOnly: true },
        {
          present(source, width, height) {
            if (id === null) {
              sink.present(source, width, height);
              return;
            }
            // An inactive native LCD can emit its shutdown black frame. Retain its last useful image.
            if (screen?.screenId !== id) return;
            output.present(source, width, height);
            sink.present(source, width, height);
          },
        },
        {
          onStatus: (status, detail) => {
            if (status === "error") events.onDuoUnavailable?.(detail);
          },
          onScreen: () => {},
          onInputConnected: () => {},
          onMjpegFallback: () => {},
          onUnauthorized: handleUnauthorized,
        },
      );
    });
    for (const panel of panelClients) panel.start();
  };

  // iOS input socket; also carries the screen config the helper pushes.
  const connectIosInput = async () => {
    if (stopped) return;
    const session = generation;
    await primeIosHelper(session);
    if (stopped || generation !== session) return;
    const ws = new WebSocket(wsUrl(`/helper/ws?device=${device}`));
    ws.binaryType = "arraybuffer";
    socket = ws;
    ws.onopen = () => {
      if (stopped || socket !== ws) return;
      ws.send(taggedJson(IOS_MSG_HARDWARE_KEYBOARD, { enabled: false }));
      events.onInputConnected(true);
    };
    ws.onmessage = (event) => {
      if (stopped || socket !== ws) return;
      if (!(event.data instanceof ArrayBuffer)) return;
      const bytes = new Uint8Array(event.data);
      if (socket !== ws || stopped || bytes.length < 1) return;
      try {
        const payload: unknown = JSON.parse(decoder.decode(bytes.subarray(1)));
        if (bytes[0] === 0x90) {
          const reply = decodeControlReply(payload);
          if (Option.isSome(reply)) duoControl.receive(reply.value);
        } else if (bytes[0] === IOS_TAG_SCREEN_CONFIG) {
          const config = decodeScreenConfig(payload);
          if (Option.isSome(config)) {
            const previous = screen;
            screen = config.value;
            if (screen.hingePose && screen.hingePose !== previous?.hingePose)
              rotationCursor = screen.hingePose === "laptop" ? "landscape_left" : "portrait";
            else if (screen.orientation !== previous?.orientation)
              rotationCursor = screen.orientation;
            panelSinks?.onScreen?.(screen);
            events.onScreen(screen);
            // A surface election can leave an existing decoder on the former
            // encoder description. Reopen only video to acquire the elected
            // surface's seed and codec configuration; HID and the viewer stay.
            if (
              panelSinks &&
              screen.supportsPhysicalOrientation &&
              previous &&
              screen.screenId !== previous.screenId
            )
              startDuoVideo(panelSinks);
            if (pendingOrientation) {
              const receipt = pendingOrientation;
              pendingOrientation = null;
              duoControl.receive({
                requestId: receipt.requestId,
                ok: true,
              });
            }
          }
        }
      } catch {
        // Ignore malformed config frames.
      }
    };
    ws.onclose = (event) => {
      if (socket !== ws) return;
      socket = null;
      duoControl.clear();
      rotationCursor = null;
      if (stopped) return;
      events.onInputConnected(
        false,
        event.reason || (event.code === 1006 ? "input socket refused" : `closed ${event.code}`),
      );
      // A rejected HTTP upgrade surfaces as 1006, including an expired stream ticket.
      if (
        event.code === 1008 ||
        event.code === 4401 ||
        (event.code === 1006 && access.query.wsTicket)
      )
        return handleUnauthorized();
      scheduleRetry("input", () => void connectIosInput());
    };
    ws.onerror = () => ws.close();
  };

  // Android: one socket for video and input.
  const connectAndroid = () => {
    if (stopped) return;
    const ws = new WebSocket(wsUrl(`/ws?device=${device}&frame-meta=1`));
    ws.binaryType = "arraybuffer";
    socket = ws;
    ws.onopen = () => {
      if (stopped || socket !== ws) return;
      connecting();
      events.onInputConnected(true);
    };
    ws.onmessage = (event) => {
      if (stopped || socket !== ws) return;
      if (typeof event.data === "string") {
        // The encoder restarts at a new size when the device rotates; the
        // next keyframe carries a fresh SPS, so the decoder is rebuilt from it.
        if (isVideoSessionMessage(event.data)) {
          closeDecoder();
          configuring = false;
          connecting();
          requestKeyframe();
        }
        return;
      }
      if (!(event.data instanceof ArrayBuffer)) return;
      const packet = parseSemuPacket(event.data);
      const needsScan =
        packet.isKey === null ||
        (packet.isKey && (!videoDecoder || videoDecoder.state !== "configured"));
      const scanned = needsScan ? scanAccessUnit(packet.data) : null;
      const isKey = packet.isKey ?? scanned?.isKey ?? false;
      if (scanned?.sps && (!videoDecoder || videoDecoder.state !== "configured")) {
        if (configuring) return;
        configuring = true;
        const epoch = decoderEpoch;
        const isCurrent = () => !stopped && socket === ws;
        void configureDecoder({ codec: avcCodecString(scanned.sps) }, isCurrent).then(
          (configured) => {
            if (!isCurrent() || epoch !== decoderEpoch) return;
            configuring = false;
            awaitingKeyframe = true;
            if (configured) requestKeyframe();
          },
        );
        return;
      }
      if (!videoDecoder || videoDecoder.state !== "configured") {
        if (!isKey) requestKeyframe();
        return;
      }
      decode(isKey, packet.data, packet.timestamp);
    };
    ws.onclose = (event) => {
      if (socket !== ws) return;
      socket = null;
      closeDecoder();
      if (stopped) return;
      events.onInputConnected(false, event.reason || `closed ${event.code}`);
      if (
        event.code === 1008 ||
        event.code === 4401 ||
        (event.code === 1006 && access.query.wsTicket)
      )
        return handleUnauthorized();
      configuring = false;
      connecting(event.reason || undefined);
      scheduleRetry("input", connectAndroid);
    };
    ws.onerror = () => ws.close();
  };

  const start = () => {
    if (!stopped) return;
    stopped = false;
    generation++;
    configuring = false;
    connecting();
    if (platform === "ios") {
      if (!target.videoOnly) void connectIosInput();
      if (useWebCodecs) void readIosVideo();
      else fallBackToMjpeg();
    } else if (useWebCodecs) {
      connectAndroid();
    } else {
      fail("This browser cannot decode the Android stream (WebCodecs unavailable).");
    }
  };

  const stop = () => {
    if (stopped) return;
    stopped = true;
    generation++;
    videoGeneration++;
    duoControl.clear();
    rotationCursor = null;
    for (const panel of panelClients) panel.stop();
    panelClients = [];
    panelSinks = null;
    mjpeg = false;
    clearFrameTimer();
    if (videoReadTimer !== null) clearTimeout(videoReadTimer);
    videoReadTimer = null;
    releaseImage?.();
    releaseImage = null;
    mjpegImage = null;
    for (const timer of retryTimers.values()) clearTimeout(timer);
    retryTimers.clear();
    primeController?.abort();
    primeController = null;
    controller?.abort();
    controller = null;
    const discarded = socket;
    socket = null;
    discarded?.close();
    closeDecoder();
  };

  const send = (payload: Uint8Array<ArrayBuffer> | string) => {
    if (!stopped && socket?.readyState === WebSocket.OPEN) socket.send(payload);
  };

  const rawPoint = (x: number, y: number) => {
    // serve-sim streams the raw framebuffer; rotated devices need input
    // remapped into that raw space.
    if (platform !== "ios" || !screen || screen.width > screen.height) return { x, y };
    switch (screen.orientation) {
      case "landscape_left":
        return { x: y, y: 1 - x };
      case "landscape_right":
        return { x: 1 - y, y: x };
      case "portrait_upside_down":
        return { x: 1 - x, y: 1 - y };
      default:
        return { x, y };
    }
  };

  return {
    start,
    stop,
    setMjpegImage,
    controlDuo: duoControl.enqueue,
    sendRawTouch: (phase, x, y) => {
      if (platform === "ios") send(taggedJson(IOS_MSG_TOUCH, { type: phase, x, y }));
    },
    setDuoPanels(panels) {
      if (platform !== "ios" || target.videoOnly || stopped || panelSinks === panels) return;
      if (panels && !screen?.supportsHingeAngle) return;
      panelSinks = panels;
      videoGeneration++;
      controller?.abort();
      controller = null;
      closeDecoder();
      const retry = retryTimers.get("video");
      if (retry) clearTimeout(retry);
      retryTimers.delete("video");
      for (const panel of panelClients) panel.stop();
      panelClients = [];
      if (!panels) {
        if (useWebCodecs) void readIosVideo();
        return;
      }
      startDuoVideo(panels);
    },
    sendTouch: (phase, x, y) => {
      if (platform === "ios") {
        send(taggedJson(IOS_MSG_TOUCH, { type: phase, ...rawPoint(x, y) }));
        return;
      }
      const action = phase === "begin" ? "down" : phase === "move" ? "move" : "up";
      send(JSON.stringify({ type: "touch", action, x, y }));
    },
    sendKey: (event, phase) => {
      if (platform === "ios") {
        const usage = hidUsageForCode(event.code);
        if (usage !== null) send(taggedJson(IOS_MSG_KEY, { type: phase, usage }));
        return;
      }
      if (phase !== "down") return;
      if (event.key === "Escape") return send(JSON.stringify({ type: "back" }));
      const keycode = ANDROID_KEYCODE_BY_KEY[event.key];
      if (keycode !== undefined) return send(JSON.stringify({ type: "key", keycode }));
      if (event.key.length === 1 && !event.metaKey && !event.ctrlKey) {
        send(JSON.stringify({ type: "text", text: event.key }));
      }
    },
    pressButton: (button) => {
      if (platform === "ios") {
        const name =
          button === "home"
            ? "home"
            : button === "appSwitcher"
              ? "app_switcher"
              : button === "power"
                ? "lock"
                : null;
        if (name) send(taggedJson(IOS_MSG_BUTTON, { button: name }));
        return;
      }
      const type = button === "appSwitcher" ? "recents" : button;
      if (type === "home" || type === "back" || type === "recents" || type === "power") {
        send(JSON.stringify({ type }));
      }
    },
    rotate: () => {
      if (platform !== "ios") return;
      const current = screen?.supportsHingeAngle
        ? (rotationCursor ?? screen.orientation)
        : (screen?.orientation ?? "portrait");
      const next =
        IOS_ORIENTATIONS[(IOS_ORIENTATIONS.indexOf(current) + 1) % IOS_ORIENTATIONS.length]!;
      if (screen?.supportsHingeAngle) {
        rotationCursor = next;
        duoControl.enqueue({ control: "orientation", value: next });
      } else send(taggedJson(IOS_MSG_ORIENTATION, { orientation: next }));
    },
    setOrientation: (orientation) => {
      if (platform === "ios") send(taggedJson(IOS_MSG_ORIENTATION, { orientation }));
    },
  };
}
