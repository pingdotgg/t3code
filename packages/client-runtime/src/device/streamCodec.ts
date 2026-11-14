// @effect-diagnostics globalFetch:off globalTimers:off - This browser and WebView transport runs without an Effect runtime.

import { type DuoCommand, type DuoControlState, type DuoPose } from "./duoControl.ts";
import * as Schema from "effect/Schema";
import { type DeviceFrameSink } from "./frame.ts";
import { type DeviceHubAccess } from "./hubAccess.ts";
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

export function webRtcSessionId(): string {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export const isWebCodecsSupported = (): boolean =>
  typeof globalThis !== "undefined" &&
  "VideoDecoder" in globalThis &&
  "EncodedVideoChunk" in globalThis;

export function utf8ByteLength(codePoint: number): number {
  if (codePoint <= 0x7f) return 1;
  if (codePoint <= 0x7ff) return 2;
  if (codePoint <= 0xffff) return 3;
  return 4;
}

export function taggedJson(tag: number, payload: unknown): Uint8Array<ArrayBuffer> {
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

export const isVideoSessionMessage = (text: string) => {
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

export const HID_USAGE_BY_CODE: Readonly<Record<string, number>> = {
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
  NumpadDivide: 0x54,
  NumpadMultiply: 0x55,
  NumpadSubtract: 0x56,
  NumpadAdd: 0x57,
  NumpadEnter: 0x58,
  Numpad1: 0x59,
  Numpad2: 0x5a,
  Numpad3: 0x5b,
  Numpad4: 0x5c,
  Numpad5: 0x5d,
  Numpad6: 0x5e,
  Numpad7: 0x5f,
  Numpad8: 0x60,
  Numpad9: 0x61,
  Numpad0: 0x62,
  NumpadDecimal: 0x63,
  NumpadEqual: 0x67,
  ControlLeft: 0xe0,
  ShiftLeft: 0xe1,
  AltLeft: 0xe2,
  MetaLeft: 0xe3,
  ControlRight: 0xe4,
  ShiftRight: 0xe5,
  AltRight: 0xe6,
  MetaRight: 0xe7,
};

export function hidUsageForCode(code: string): number | null {
  if (/^Key[A-Z]$/.test(code)) return 0x04 + (code.charCodeAt(3) - 65);
  if (/^Digit[1-9]$/.test(code)) return 0x1e + (code.charCodeAt(5) - 49);
  if (code === "Digit0") return 0x27;
  return HID_USAGE_BY_CODE[code] ?? null;
}

export const ANDROID_KEYCODE_BY_KEY: Readonly<Record<string, number>> = {
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

export const IOS_ORIENTATIONS: ReadonlyArray<DeviceScreenSize["orientation"]> = [
  "portrait",
  "landscape_left",
  "portrait_upside_down",
  "landscape_right",
];
