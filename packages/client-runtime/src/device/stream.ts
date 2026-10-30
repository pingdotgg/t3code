// @effect-diagnostics globalFetch:off globalTimers:off - This browser and WebView transport runs without an Effect runtime.

import {
  createDuoControl,
  type DuoCommand,
  type DuoControlState,
  type DuoPose,
} from "./duoControl.ts";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import { createCanvasFrameSink, type DeviceFrameSink } from "./frame.ts";
import { simulatorAvcConfig } from "./avcConfig.ts";
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
  inputUnavailable: Schema.optionalKey(Schema.Boolean),
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
const iceServerSchema = Schema.Struct({
  urls: Schema.Union([Schema.String, Schema.Array(Schema.String)]),
  username: Schema.optionalKey(Schema.String),
  credential: Schema.optionalKey(Schema.String),
});
const webRtcSettingsSchema = Schema.Struct({
  transport: Schema.Literal("webrtc"),
  iceServers: Schema.optionalKey(Schema.Array(iceServerSchema)),
  iceTransportPolicy: Schema.optionalKey(Schema.Literals(["all", "relay"])),
});
// serve-sim reports its stream settings as `streamSettings` (EAS) or `stream`.
const serveSimApiSchema = Schema.Struct({
  streamSettings: Schema.optionalKey(Schema.Unknown),
  stream: Schema.optionalKey(Schema.Unknown),
});
const decodeServeSimApi = Schema.decodeUnknownOption(serveSimApiSchema);
const decodeWebRtcSettings = Schema.decodeUnknownOption(webRtcSettingsSchema);
type WebRtcSettings = typeof webRtcSettingsSchema.Type;
const decodeTransportLocked = Schema.decodeUnknownOption(
  Schema.Struct({
    error: Schema.Literal("stream_transport_locked"),
    transport: Schema.Literal("webrtc"),
  }),
);
const decodeWebRtcAnswer = Schema.decodeUnknownOption(
  Schema.Struct({ type: Schema.Literal("answer"), sdp: Schema.String }),
);

export interface DuoPanelSinks {
  readonly cover: DeviceFrameSink;
  readonly inner: DeviceFrameSink;
  /** Invalidate captured input synchronously, before React can commit the new layout. */
  readonly onScreen?: (screen: DeviceScreenSize) => void;
}

export interface DeviceStreamEvents {
  readonly onDuoControl?: (state: DuoControlState) => void;
  readonly onDuoUnavailable?: (detail?: string) => void;
  readonly onStatus: (status: DeviceStreamStatus, detail?: string) => void;
  readonly onScreen: (screen: DeviceScreenSize) => void;
  readonly onUnauthorized: () => void;
  /**
   * H.264 cannot be decoded here (no WebCodecs, or the simulator's profile is
   * unsupported); the owner should show an `<img>` instead of the canvas
   * and attach it with `setMjpegImage` so the client can observe real frames.
   */
  readonly onMjpegFallback: (url: string) => void;
  /**
   * The stream moved from MJPEG back to painting the canvas, because the
   * device serves WebRTC only; the owner should show the canvas again.
   */
  readonly onCanvasVideo?: () => void;
  readonly onInputConnected: (connected: boolean, detail?: string) => void;
}

export interface DeviceStreamTarget {
  readonly platform: DevicePlatform;
  readonly deviceId: string;
  readonly access: DeviceHubAccess;
  /** Native iOS WebViews can use MJPEG without cross-origin fetch or secure-context support. */
  readonly preferMjpeg?: boolean;
  readonly panelId?: 1 | 3;
  readonly videoOnly?: boolean;
  /** The host speaks only serve-sim's AVCC stream and input socket, on both platforms (Simlock). */
  readonly serveSimOnly?: boolean;
}

export type DeviceHardwareButton = "home" | "back" | "recents" | "power" | "appSwitcher";

const RETRY_DELAY_MS = 1_000;
const FIRST_FRAME_TIMEOUT_MS = 15_000;
// A WebRTC feed that shows no frame for this long is reconnected; checked
// every WEBRTC_STALL_CHECK_MS, so a transient `disconnected` peer that
// recovers is left alone.
const WEBRTC_STALL_TIMEOUT_MS = FIRST_FRAME_TIMEOUT_MS;
const WEBRTC_STALL_CHECK_MS = 5_000;
const TRANSPORT_PROBE_TIMEOUT_MS = 5_000;
// Offers carry every candidate: serve-sim does not accept trickled ICE.
const ICE_GATHERING_TIMEOUT_MS = 2_000;
// A gathering cut short without a reflexive or relay candidate is retried
// with twice the deadline, up to this; then the offer goes as gathered. The
// whole sequence stays inside the first-frame deadline, which retries do
// not extend.
const ICE_GATHERING_MAX_TIMEOUT_MS = 4_000;
const MJPEG_FRAME_CHECK_MS = 250;
const FRAME_DURATION_US = 16_667;
const SEMU_MAGIC = 0x53454d55;
const SEMU_HEADER_BYTES = 16;
const SEMU_FLAG_KEY = 1;
const SOFT_DECODE_QUEUE = 8;
// expo-device-hub 0.15.3 serve-emu input.js MAX_TEXT_BYTES limits packets to 300 UTF-8 bytes.
const ANDROID_MAX_TEXT_BYTES = 300;
// The pinned hub queue depth is 128; the client does not read queue rejections.
const ANDROID_MAX_TEXT_CHUNKS = 64;

const IOS_MSG_TOUCH = 0x03;
const IOS_MSG_BUTTON = 0x04;
const IOS_MSG_KEY = 0x06;
const IOS_MSG_ORIENTATION = 0x07;
const IOS_TAG_SCREEN_CONFIG = 0x82;
const IOS_TAG_INPUT_ADMITTED = 0x83;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** serve-sim requires a v4 UUID; `crypto.randomUUID` is missing over plain-HTTP LAN origins. */
function webRtcSessionId(): string {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const isWebCodecsSupported = (): boolean =>
  typeof globalThis !== "undefined" &&
  "VideoDecoder" in globalThis &&
  "EncodedVideoChunk" in globalThis;

function utf8ByteLength(codePoint: number): number {
  if (codePoint <= 0x7f) return 1;
  if (codePoint <= 0x7ff) return 2;
  if (codePoint <= 0xffff) return 3;
  return 4;
}

function taggedJson(tag: number, payload: unknown): Uint8Array<ArrayBuffer> {
  const json = encoder.encode(JSON.stringify(payload));
  const out = new Uint8Array(1 + json.length);
  out[0] = tag;
  out.set(json, 1);
  return out;
}

export function avcCodecString(bytes: Uint8Array): string {
  if (bytes.length < 4) return "avc1.42E01E";
  const hex = (byte: number) => byte.toString(16).padStart(2, "0");
  return `avc1.${hex(bytes[1]!)}${hex(bytes[2]!)}${hex(bytes[3]!)}`;
}

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
   * `stop()` detaches it; attach a fresh image for each restart.
   */
  readonly setMjpegImage: (image: HTMLImageElement | null) => void;
  /** Normalized 0..1 coordinates in the displayed frame. */
  readonly sendTouch: (phase: "begin" | "move" | "end", x: number, y: number) => void;
  readonly sendKey: (event: KeyboardEvent, phase: "down" | "up") => void;
  /** Android only: iOS input is HID key codes, which cannot carry arbitrary text. */
  readonly sendText: (text: string) => void;
  readonly pressButton: (button: DeviceHardwareButton) => void;
  readonly rotate: () => void;
  readonly setOrientation: (orientation: DeviceScreenSize["orientation"]) => void;
  readonly controlDuo: (command: DuoCommand) => void;
  readonly setDuoPanels: (panels: DuoPanelSinks | null) => void;
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
  // Android normally streams over serve-emu's socket; a serve-sim-only host serves it like iOS.
  const serveSimOnly = target.serveSimOnly === true;
  const avcc = platform === "ios" || serveSimOnly;
  const vendor = avcc ? "/vendor/serve-sim" : "/vendor/serve-emu";
  const device = encodeURIComponent(deviceId);
  const httpUrl = (path: string) =>
    withDeviceHubQuery(`${access.httpBase}${vendor}${path}`, access);
  const wsUrl = (path: string) => withDeviceHubQuery(`${access.wsBase}${vendor}${path}`, access);
  const useWebCodecs =
    isWebCodecsSupported() && !(platform === "ios" && target.preferMjpeg && !serveSimOnly);

  let stopped = true;
  let socket: WebSocket | null = null;
  let controller: AbortController | null = null;
  const retryTimers = new Map<"video" | "input", ReturnType<typeof setTimeout>>();
  let primeController: AbortController | null = null;
  let videoDecoder: VideoDecoder | null = null;
  let decodedVideoGeneration: number | null = null;
  let iosInputAdmitted = false;
  let iosInputUnavailable = false;
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
  let iceGatheringDeadlineMs = ICE_GATHERING_TIMEOUT_MS;
  let peer: { connection: RTCPeerConnection; sessionId: string; video: HTMLVideoElement } | null =
    null;
  const duoControl = createDuoControl({
    send(request) {
      if (
        !iosInputAdmitted ||
        iosInputUnavailable ||
        socket?.readyState !== WebSocket.OPEN ||
        !screen?.supportsHingeAngle
      )
        return false;
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
        // Multipart images may not emit load until the response ends.
        timer = setTimeout(check, MJPEG_FRAME_CHECK_MS);
      }
    };
    const error = () => {
      if (released) return;
      const failure = "Could not receive the device stream. Reconnect to try again.";
      // An <img> cannot read the 409 that a WebRTC-only serve-sim answers with.
      if (typeof RTCPeerConnection === "undefined") fail(failure);
      else void switchToWebRtc(failure, false);
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
    if (!avcc && (screen?.width !== width || screen.height !== height)) {
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
    } catch {}
    videoDecoder = null;
    awaitingKeyframe = true;
  };

  const recoverDecoder = () => {
    if (serveSimOnly) {
      // A new AVCC request starts a fresh capture with a keyframe; there is no MJPEG.
      closeDecoder();
      controller?.abort();
    } else if (platform === "ios") fallBackToMjpeg();
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
          if (videoDecoder === decoder && (!avcc || feedGeneration === videoGeneration)) {
            decodedVideoGeneration = feedGeneration;
            paint(frame, frame.displayWidth, frame.displayHeight);
          }
        } finally {
          frame.close();
        }
      },
      error: () => {
        if (stopped || videoDecoder !== decoder || (avcc && feedGeneration !== videoGeneration))
          return;
        recoverDecoder();
      },
    });
    return decoder;
  };

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
      if (!avcc) {
        recoverDecoder();
        return;
      }
      // Native IDRs are spaced by frame count, so an idle simulator may take
      // minutes to produce one. A new AVCC subscription forces a fresh IDR.
      controller?.abort();
      closeDecoder();
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
      if (response.status === 409 && !target.panelId) {
        const locked = decodeTransportLocked(await response.json().catch(() => null));
        if (Option.isSome(locked)) {
          if (!isCurrent()) return;
          controller = null;
          void switchToWebRtc("This browser cannot play this device's WebRTC stream.", true);
          return;
        }
      }
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
          if (!isCurrent()) return;
          retryDetail = "Device stream stopped receiving video. Reconnecting…";
          videoController.abort();
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
          if (videoController.signal.aborted) break;
          switch (chunk.type) {
            case "seed":
              void createImageBitmap(new Blob([chunk.payload as BlobPart], { type: "image/jpeg" }))
                .then((bitmap) => {
                  try {
                    if (isCurrent() && decodedVideoGeneration !== feedGeneration)
                      paint(bitmap, bitmap.width, bitmap.height);
                  } finally {
                    bitmap.close();
                  }
                })
                .catch(() => {});
              break;
            case "description": {
              awaitingKeyframe = true;
              const configured = await configureDecoder(
                {
                  codec: avcCodecString(chunk.payload),
                  description: simulatorAvcConfig(chunk.payload),
                },
                isCurrent,
              );
              if (!isCurrent()) return;
              if (!configured) {
                await reader.cancel().catch(() => {});
                if (!isCurrent()) return;
                if (serveSimOnly)
                  setStatus(
                    "error",
                    `This browser cannot decode this device's ${avcCodecString(chunk.payload)} stream.`,
                  );
                else if (target.videoOnly)
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
      retryDetail ??= videoController.signal.aborted
        ? "Video decoder fell behind. Reconnecting…"
        : (cause as Error).message;
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
    } finally {
      clearTimeout(timeout);
      controller.abort();
      if (primeController === controller) primeController = null;
    }
  };

  /**
   * serve-sim can be locked to WebRTC (EAS Simulator always is), and then
   * refuses AVCC and MJPEG; serve-emu advertises WebRTC the same way. An
   * unreadable answer keeps the default path.
   */
  const probeWebRtc = async (): Promise<WebRtcSettings | null> => {
    const probe = new AbortController();
    const timeout = setTimeout(() => probe.abort(), TRANSPORT_PROBE_TIMEOUT_MS);
    try {
      const response = await fetch(httpUrl(`/api?device=${device}`), {
        signal: probe.signal,
        credentials: access.credentials ? "include" : "same-origin",
      });
      if (!response.ok) return null;
      const api = decodeServeSimApi(await response.json());
      if (Option.isNone(api)) return null;
      const settings = decodeWebRtcSettings(api.value.streamSettings ?? api.value.stream);
      return Option.isSome(settings) ? settings.value : null;
    } catch {
      return null;
    } finally {
      clearTimeout(timeout);
    }
  };

  const webRtcUrl = (action: "offer" | "close") =>
    httpUrl(avcc ? `/helper/${device}/webrtc/${action}` : `/webrtc/${action}?device=${device}`);

  const closePeer = () => {
    const current = peer;
    if (!current) return;
    peer = null;
    current.connection.close();
    current.video.srcObject = null;
    current.video.remove();
    // Releases the capture session; best effort because the page may be unloading.
    void fetch(webRtcUrl("close"), {
      method: "POST",
      keepalive: true,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: current.sessionId }),
      credentials: access.credentials ? "include" : "same-origin",
    }).catch(() => {});
  };

  const readWebRtc = async (settings: WebRtcSettings) => {
    const lifecycle = generation;
    const feedGeneration = ++videoGeneration;
    closePeer();
    const connection = new RTCPeerConnection({
      ...(settings.iceServers
        ? {
            iceServers: settings.iceServers.map((server) => ({
              ...server,
              urls: typeof server.urls === "string" ? server.urls : [...server.urls],
            })),
          }
        : {}),
      iceTransportPolicy: settings.iceTransportPolicy ?? "all",
    });
    // Frames only reach requestVideoFrameCallback from a video that is in the
    // document; it stays invisible because the sink paints them.
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.setAttribute("aria-hidden", "true");
    video.style.cssText =
      "position:fixed;width:1px;height:1px;opacity:0;pointer-events:none;left:0;top:0";
    document.body.append(video);
    const current = { connection, sessionId: webRtcSessionId(), video };
    peer = current;
    const isCurrent = () =>
      !stopped &&
      generation === lifecycle &&
      videoGeneration === feedGeneration &&
      peer === current;
    // After the first frame nothing else bounds a feed that stops: the peer
    // can sit `disconnected` with the last frame on the canvas. A long gap
    // between frames reconnects through the same path as a failed connection.
    let checksWithoutFrame = 0;
    let watchdog: ReturnType<typeof setInterval> | null = null;
    const clearWatchdog = () => {
      if (watchdog !== null) clearInterval(watchdog);
      watchdog = null;
    };
    const retry = (detail: string) => {
      clearWatchdog();
      if (!isCurrent()) return;
      closePeer();
      connecting(detail);
      scheduleRetry("video", () => void readWebRtc(settings));
    };
    const presentFrame = () => {
      if (!isCurrent()) {
        clearWatchdog();
        return;
      }
      if (video.videoWidth > 0 && video.videoHeight > 0) {
        paint(video, video.videoWidth, video.videoHeight);
        checksWithoutFrame = 0;
        watchdog ??= setInterval(() => {
          if (!isCurrent()) return clearWatchdog();
          checksWithoutFrame++;
          if (checksWithoutFrame * WEBRTC_STALL_CHECK_MS >= WEBRTC_STALL_TIMEOUT_MS) {
            retry("Device stream stalled. Reconnecting…");
          }
        }, WEBRTC_STALL_CHECK_MS);
      }
      video.requestVideoFrameCallback(presentFrame);
    };
    const transceiver = connection.addTransceiver("video", { direction: "recvonly" });
    const codecs = RTCRtpReceiver.getCapabilities("video")?.codecs ?? [];
    if (codecs.length > 0) {
      // serve-sim encodes H.264; other codecs stay as fallbacks it may refuse.
      transceiver.setCodecPreferences([
        ...codecs.filter((codec) => codec.mimeType.toLowerCase() === "video/h264"),
        ...codecs.filter((codec) => codec.mimeType.toLowerCase() !== "video/h264"),
      ]);
    }
    connection.ontrack = (event) => {
      if (!isCurrent()) return;
      iceGatheringDeadlineMs = ICE_GATHERING_TIMEOUT_MS;
      video.srcObject = event.streams[0] ?? new MediaStream([event.track]);
      void video.play().catch(() => {});
      video.requestVideoFrameCallback(presentFrame);
    };
    connection.onconnectionstatechange = () => {
      if (connection.connectionState === "failed")
        retry("Device stream connection failed. Reconnecting…");
    };
    try {
      await connection.setLocalDescription(await connection.createOffer());
      const gathered = await new Promise<boolean>((resolve) => {
        if (connection.iceGatheringState === "complete") return resolve(true);
        const timer = setTimeout(() => done(false), iceGatheringDeadlineMs);
        function done(complete: boolean) {
          clearTimeout(timer);
          connection.removeEventListener("icegatheringstatechange", changed);
          resolve(complete);
        }
        function changed() {
          if (connection.iceGatheringState === "complete") done(true);
        }
        connection.addEventListener("icegatheringstatechange", changed);
      });
      if (!isCurrent()) return;
      // serve-sim takes all candidates in the offer; later candidates never trickle.
      // Cloud simulators need a reflexive or relay candidate, so retry incomplete offers with
      // longer deadlines up to the bound, then send what was gathered.
      const sdp = connection.localDescription?.sdp ?? "";
      if (
        !gathered &&
        !/^a=candidate:.* typ (?:srflx|relay)\b/m.test(sdp) &&
        iceGatheringDeadlineMs < ICE_GATHERING_MAX_TIMEOUT_MS
      ) {
        iceGatheringDeadlineMs = Math.min(iceGatheringDeadlineMs * 2, ICE_GATHERING_MAX_TIMEOUT_MS);
        return retry("Device stream found no network candidates yet. Retrying…");
      }
      const response = await fetch(webRtcUrl("offer"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          type: "offer",
          sdp: connection.localDescription?.sdp,
          sessionId: current.sessionId,
          codec: "h264",
        }),
        credentials: access.credentials ? "include" : "same-origin",
      });
      if (!isCurrent()) {
        await response.body?.cancel();
        return;
      }
      if (response.status === 401 || response.status === 403) return handleUnauthorized();
      // 409: another viewer is still negotiating with this simulator.
      if (!response.ok) return retry(`Device stream offer failed (${response.status}). Retrying…`);
      const answer = decodeWebRtcAnswer(await response.json());
      if (!isCurrent()) return;
      if (Option.isNone(answer))
        return retry("Device stream returned an invalid answer. Retrying…");
      await connection.setRemoteDescription(answer.value);
    } catch (cause) {
      retry((cause as Error).message);
    }
  };

  /**
   * Called once AVCC or MJPEG was refused. `locked` means serve-sim already
   * said it streams WebRTC only, so a missing /api answer still switches.
   */
  const switchToWebRtc = async (failure: string, locked: boolean) => {
    const session = generation;
    if (typeof RTCPeerConnection === "undefined") return fail(failure);
    const settings = (await probeWebRtc()) ?? (locked ? { transport: "webrtc" as const } : null);
    if (stopped || generation !== session) return;
    if (!settings) return fail(failure);
    if (mjpeg) {
      mjpeg = false;
      releaseImage?.();
      releaseImage = null;
      events.onCanvasVideo?.();
    }
    // MJPEG may have shown frames already: say the stream is connecting again
    // rather than leave a blank canvas until the first WebRTC frame.
    connecting("Switching to WebRTC.");
    void readWebRtc(settings);
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
              return sink.present(source, width, height);
            }
            // An inactive native LCD can emit its shutdown black frame. Retain its last useful image.
            if (screen?.screenId !== id) return true;
            const retained = output.present(source, width, height);
            const primary = sink.present(source, width, height);
            return retained && primary;
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

  const connectIosInput = async () => {
    if (stopped) return;
    const session = generation;
    if (!serveSimOnly) await primeIosHelper(session);
    if (stopped || generation !== session) return;
    const ws = new WebSocket(wsUrl(`/helper/ws?device=${device}`));
    ws.binaryType = "arraybuffer";
    socket = ws;
    iosInputAdmitted = false;
    iosInputUnavailable = false;
    ws.onmessage = (event) => {
      if (stopped || socket !== ws) return;
      if (!(event.data instanceof ArrayBuffer)) return;
      const bytes = new Uint8Array(event.data);
      if (socket !== ws || stopped || bytes.length < 1) return;
      if (bytes[0] === IOS_TAG_INPUT_ADMITTED) {
        iosInputAdmitted = true;
        events.onInputConnected(!iosInputUnavailable);
        return;
      }
      try {
        const payload: unknown = JSON.parse(decoder.decode(bytes.subarray(1)));
        if (bytes[0] === 0x90) {
          const reply = decodeControlReply(payload);
          if (Option.isSome(reply)) duoControl.receive(reply.value);
        } else if (bytes[0] === IOS_TAG_SCREEN_CONFIG) {
          const config = decodeScreenConfig(payload);
          if (Option.isSome(config)) {
            iosInputUnavailable = config.value.inputUnavailable === true;
            events.onInputConnected(
              iosInputAdmitted && !iosInputUnavailable,
              iosInputUnavailable ? "Simulator input is unavailable" : undefined,
            );
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
      } catch {}
    };
    ws.onclose = (event) => {
      if (socket !== ws) return;
      socket = null;
      iosInputAdmitted = false;
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

  /** `inputOnly` keeps a socket for input beside a WebRTC feed, so its reconnects leave video alone. */
  const connectAndroid = (inputOnly = false) => {
    if (stopped) return;
    const ws = new WebSocket(
      wsUrl(`/ws?device=${device}&${inputOnly ? "video=0" : "frame-meta=1"}`),
    );
    ws.binaryType = "arraybuffer";
    socket = ws;
    ws.onopen = () => {
      if (stopped || socket !== ws) return;
      if (!inputOnly) connecting();
      events.onInputConnected(true);
    };
    ws.onmessage = (event) => {
      if (stopped || socket !== ws || inputOnly) return;
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
      if (!inputOnly) {
        configuring = false;
        connecting(event.reason || undefined);
      }
      // A full socket re-probes, so one failed /api read does not pin SEMU on a WebRTC host.
      scheduleRetry("input", () => (inputOnly ? connectAndroid(true) : void startAndroid()));
    };
    ws.onerror = () => ws.close();
  };

  const startAndroid = async () => {
    const session = generation;
    const settings = await probeWebRtc();
    if (stopped || generation !== session) return;
    if (settings) {
      if (typeof RTCPeerConnection === "undefined")
        return fail("This browser cannot receive the device's WebRTC stream.");
      if (!target.videoOnly) connectAndroid(true);
      void readWebRtc(settings);
    } else if (useWebCodecs) connectAndroid();
    else fail("This browser cannot decode the Android stream (WebCodecs unavailable).");
  };

  const start = () => {
    if (!stopped) return;
    stopped = false;
    generation++;
    configuring = false;
    iosInputAdmitted = false;
    iosInputUnavailable = false;
    connecting();
    if (serveSimOnly) {
      if (!target.videoOnly) void connectIosInput();
      if (useWebCodecs) void readIosVideo();
      else fail("This browser cannot decode this device's stream (WebCodecs unavailable).");
    } else if (platform === "ios") {
      if (!target.videoOnly) void connectIosInput();
      if (useWebCodecs) void readIosVideo();
      else fallBackToMjpeg();
    } else void startAndroid();
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
    closePeer();
    const discarded = socket;
    socket = null;
    discarded?.close();
    closeDecoder();
  };

  const send = (payload: Uint8Array<ArrayBuffer> | string) => {
    if (
      !stopped &&
      (!avcc || (iosInputAdmitted && !iosInputUnavailable)) &&
      socket?.readyState === WebSocket.OPEN
    )
      socket.send(payload);
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
      closePeer();
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
      if (avcc) {
        send(taggedJson(IOS_MSG_TOUCH, { type: phase, ...rawPoint(x, y) }));
        return;
      }
      const action = phase === "begin" ? "down" : phase === "move" ? "move" : "up";
      send(JSON.stringify({ type: "touch", action, x, y }));
    },
    sendKey: (event, phase) => {
      if (avcc) {
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
    sendText: (text) => {
      if (avcc) return;
      let chunk = "";
      let chunkBytes = 0;
      let sentChunks = 0;
      for (const character of text) {
        const characterBytes = utf8ByteLength(character.codePointAt(0)!);
        if (chunkBytes + characterBytes > ANDROID_MAX_TEXT_BYTES) {
          send(JSON.stringify({ type: "text", text: chunk }));
          if (++sentChunks >= ANDROID_MAX_TEXT_CHUNKS) return;
          chunk = "";
          chunkBytes = 0;
        }
        chunk += character;
        chunkBytes += characterBytes;
      }
      if (chunk.length > 0) send(JSON.stringify({ type: "text", text: chunk }));
    },
    pressButton: (button) => {
      if (avcc) {
        const name =
          button === "home"
            ? "home"
            : button === "appSwitcher" || button === "recents"
              ? "app_switcher"
              : button === "power"
                ? "lock"
                : button === "back" && platform === "android"
                  ? "back"
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
