// @effect-diagnostics globalFetch:off globalTimers:off - This browser and WebView transport runs without an Effect runtime.

import { createDuoControl, type DuoControlState, type DuoPose } from "./duoControl.ts";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import { createCanvasFrameSink, type DeviceFrameSink } from "./frame.ts";
import { makeDeviceStreamPipelines } from "./deviceStreamPipelines.ts";
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
export * from "./streamCodec.ts";
import {
  ANDROID_KEYCODE_BY_KEY,
  avcCodecString,
  hidUsageForCode,
  IOS_ORIENTATIONS,
  isVideoSessionMessage,
  isWebCodecsSupported,
  parseSemuPacket,
  scanAccessUnit,
  taggedJson,
  utf8ByteLength,
  type DeviceStreamClient,
} from "./streamCodec.ts";

export interface DeviceStreamMutableState {
  stopped: boolean;
  socket: WebSocket | null;
  controller: AbortController | null;
  primeController: AbortController | null;
  videoDecoder: VideoDecoder | null;
  decodedVideoGeneration: number | null;
  iosInputAdmitted: boolean;
  iosInputUnavailable: boolean;
  timestamp: number;
  awaitingKeyframe: boolean;
  screen: DeviceScreenSize | null;
  firstFrame: boolean;
  configuring: boolean;
  mjpeg: boolean;
  generation: number;
  decoderEpoch: number;
  frameTimer: ReturnType<typeof setTimeout> | null;
  videoReadTimer: ReturnType<typeof setTimeout> | null;
  mjpegImage: HTMLImageElement | null;
  releaseImage: (() => void) | null;
  videoGeneration: number;
  panelClients: DeviceStreamClient[];
  panelSinks: DuoPanelSinks | null;
  rotationCursor: DeviceScreenSize["orientation"] | null;
  pendingOrientation: { requestId: number } | null;
  iceGatheringDeadlineMs: number;
  peer: { connection: RTCPeerConnection; sessionId: string; video: HTMLVideoElement } | null;
}

export interface DeviceStreamPipelineDeps {
  readonly st: DeviceStreamMutableState;
  readonly target: DeviceStreamTarget;
  readonly events: DeviceStreamEvents;
  readonly access: DeviceStreamTarget["access"];
  readonly platform: DeviceStreamTarget["platform"];
  readonly device: string;
  readonly avcc: boolean;
  readonly serveSimOnly: boolean;
  readonly videoPath: string;
  readonly httpUrl: (path: string) => string;
  readonly mjpegUrl: () => string;
  readonly sink: DeviceFrameSink;
  readonly retryTimers: Map<"video" | "input", ReturnType<typeof setTimeout>>;
  readonly createClient: typeof createDeviceStreamClient;
  readonly send: (payload: Uint8Array<ArrayBuffer> | string) => unknown;
  readonly start: () => unknown;
  readonly stop: () => unknown;
}

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

  const st: DeviceStreamMutableState = {
    stopped: true,
    socket: null,
    controller: null,
    primeController: null,
    videoDecoder: null,
    decodedVideoGeneration: null,
    iosInputAdmitted: false,
    iosInputUnavailable: false,
    timestamp: 0,
    awaitingKeyframe: true,
    screen: null,
    firstFrame: false,
    configuring: false,
    mjpeg: false,
    generation: 0,
    decoderEpoch: 0,
    frameTimer: null,
    videoReadTimer: null,
    mjpegImage: null,
    releaseImage: null,
    videoGeneration: 0,
    panelClients: [],
    panelSinks: null,
    rotationCursor: null,
    pendingOrientation: null,
    iceGatheringDeadlineMs: ICE_GATHERING_TIMEOUT_MS,
    peer: null,
  };
  const retryTimers = new Map<"video" | "input", ReturnType<typeof setTimeout>>();
  const duoControl = createDuoControl({
    send(request) {
      if (
        !st.iosInputAdmitted ||
        st.iosInputUnavailable ||
        st.socket?.readyState !== WebSocket.OPEN ||
        !st.screen?.supportsHingeAngle
      )
        return false;
      if (request.command.control === "physical" && !st.screen.supportsPhysicalOrientation)
        return false;
      try {
        st.pendingOrientation = null;
        if (request.command.control === "orientation") {
          const value = request.command.value;
          st.pendingOrientation = { requestId: request.requestId };
          st.rotationCursor = value;
          // Upstream serializes orientation with hinge commands, then broadcasts config.
          // An orientation-locked app can keep its framebuffer orientation after the sensor rotates.
          st.socket.send(taggedJson(IOS_MSG_ORIENTATION, { orientation: value }));
        } else st.socket.send(taggedJson(0x10, request));
        return true;
      } catch {
        return false;
      }
    },
    onChange(state) {
      if (!state.pending) st.pendingOrientation = null;
      events.onDuoControl?.(state);
    },
  });
  const videoPath = `/helper/${device}${target.panelId ? `/panel/${target.panelId}` : ""}/stream.avcc`;

  const mjpegUrl = () => httpUrl(`/helper/${device}/stream.mjpeg`);

  const {
    clearFrameTimer,
    closeDecoder,
    closePeer,
    configureDecoder,
    connecting,
    decode,
    fail,
    fallBackToMjpeg,
    frameReceived,
    handleUnauthorized,
    makeDecoder,
    observeMjpegImage,
    paint,
    primeIosHelper,
    probeWebRtc,
    readIosVideo,
    readWebRtc,
    recoverDecoder,
    requestKeyframe,
    scheduleRetry,
    setMjpegImage,
    setStatus,
    switchToWebRtc,
    webRtcUrl,
  } = makeDeviceStreamPipelines({
    access,
    avcc,
    device,
    httpUrl,
    mjpegUrl,
    platform,
    retryTimers,
    serveSimOnly,
    sink,
    st,
    videoPath,
    target,
    events,
    createClient: createDeviceStreamClient,
    send: (payload: Uint8Array<ArrayBuffer> | string) => send(payload),
    start: () => start(),
    stop: () => stop(),
  });

  const startDuoVideo = (panels: DuoPanelSinks) => {
    for (const panel of st.panelClients) panel.stop();
    // Physical handoff elects a native surface. Fixed-panel encoders can keep
    // an inactive shutdown frame after election, so this build uses one active
    // feed instead of decoding a third stream alongside the two fixed feeds.
    const ids = st.screen?.supportsPhysicalOrientation ? ([null] as const) : ([1, 3] as const);
    st.panelClients = ids.map((id) => {
      const output = id === 1 ? panels.cover : panels.inner;
      return createDeviceStreamClient(
        { ...target, ...(id === null ? {} : { panelId: id }), videoOnly: true },
        {
          present(source, width, height) {
            if (id === null) {
              return sink.present(source, width, height);
            }
            // An inactive native LCD can emit its shutdown black frame. Retain its last useful image.
            if (st.screen?.screenId !== id) return true;
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
    for (const panel of st.panelClients) panel.start();
  };

  const connectIosInput = async () => {
    if (st.stopped) return;
    const session = st.generation;
    if (!serveSimOnly) await primeIosHelper(session);
    if (st.stopped || st.generation !== session) return;
    const ws = new WebSocket(wsUrl(`/helper/ws?device=${device}`));
    ws.binaryType = "arraybuffer";
    st.socket = ws;
    st.iosInputAdmitted = false;
    st.iosInputUnavailable = false;
    ws.onmessage = (event) => {
      if (st.stopped || st.socket !== ws) return;
      if (!(event.data instanceof ArrayBuffer)) return;
      const bytes = new Uint8Array(event.data);
      if (st.socket !== ws || st.stopped || bytes.length < 1) return;
      if (bytes[0] === IOS_TAG_INPUT_ADMITTED) {
        st.iosInputAdmitted = true;
        events.onInputConnected(!st.iosInputUnavailable);
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
            st.iosInputUnavailable = config.value.inputUnavailable === true;
            events.onInputConnected(
              st.iosInputAdmitted && !st.iosInputUnavailable,
              st.iosInputUnavailable ? "Simulator input is unavailable" : undefined,
            );
            const previous = st.screen;
            st.screen = config.value;
            if (st.screen.hingePose && st.screen.hingePose !== previous?.hingePose)
              st.rotationCursor = st.screen.hingePose === "laptop" ? "landscape_left" : "portrait";
            else if (st.screen.orientation !== previous?.orientation)
              st.rotationCursor = st.screen.orientation;
            st.panelSinks?.onScreen?.(st.screen);
            events.onScreen(st.screen);
            // A surface election can leave an existing decoder on the former
            // encoder description. Reopen only video to acquire the elected
            // surface's seed and codec configuration; HID and the viewer stay.
            if (
              st.panelSinks &&
              st.screen.supportsPhysicalOrientation &&
              previous &&
              st.screen.screenId !== previous.screenId
            )
              startDuoVideo(st.panelSinks);
            if (st.pendingOrientation) {
              const receipt = st.pendingOrientation;
              st.pendingOrientation = null;
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
      if (st.socket !== ws) return;
      st.socket = null;
      st.iosInputAdmitted = false;
      duoControl.clear();
      st.rotationCursor = null;
      if (st.stopped) return;
      events.onInputConnected(
        false,
        event.reason || (event.code === 1006 ? "input st.socket refused" : `closed ${event.code}`),
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

  /** `inputOnly` keeps a st.socket for input beside a WebRTC feed, so its reconnects leave video alone. */
  const connectAndroid = (inputOnly = false) => {
    if (st.stopped) return;
    const ws = new WebSocket(
      wsUrl(`/ws?device=${device}&${inputOnly ? "video=0" : "frame-meta=1"}`),
    );
    ws.binaryType = "arraybuffer";
    st.socket = ws;
    ws.onopen = () => {
      if (st.stopped || st.socket !== ws) return;
      if (!inputOnly) connecting();
      events.onInputConnected(true);
    };
    ws.onmessage = (event) => {
      if (st.stopped || st.socket !== ws || inputOnly) return;
      if (typeof event.data === "string") {
        // The encoder restarts at a new size when the device rotates; the
        // next keyframe carries a fresh SPS, so the decoder is rebuilt from it.
        if (isVideoSessionMessage(event.data)) {
          closeDecoder();
          st.configuring = false;
          connecting();
          requestKeyframe();
        }
        return;
      }
      if (!(event.data instanceof ArrayBuffer)) return;
      const packet = parseSemuPacket(event.data);
      const needsScan =
        packet.isKey === null ||
        (packet.isKey && (!st.videoDecoder || st.videoDecoder.state !== "configured"));
      const scanned = needsScan ? scanAccessUnit(packet.data) : null;
      const isKey = packet.isKey ?? scanned?.isKey ?? false;
      if (scanned?.sps && (!st.videoDecoder || st.videoDecoder.state !== "configured")) {
        if (st.configuring) return;
        st.configuring = true;
        const epoch = st.decoderEpoch;
        const isCurrent = () => !st.stopped && st.socket === ws;
        void configureDecoder({ codec: avcCodecString(scanned.sps) }, isCurrent).then(
          (configured) => {
            if (!isCurrent() || epoch !== st.decoderEpoch) return;
            st.configuring = false;
            st.awaitingKeyframe = true;
            if (configured) requestKeyframe();
          },
        );
        return;
      }
      if (!st.videoDecoder || st.videoDecoder.state !== "configured") {
        if (!isKey) requestKeyframe();
        return;
      }
      decode(isKey, packet.data, packet.timestamp);
    };
    ws.onclose = (event) => {
      if (st.socket !== ws) return;
      st.socket = null;
      closeDecoder();
      if (st.stopped) return;
      events.onInputConnected(false, event.reason || `closed ${event.code}`);
      if (
        event.code === 1008 ||
        event.code === 4401 ||
        (event.code === 1006 && access.query.wsTicket)
      )
        return handleUnauthorized();
      if (!inputOnly) {
        st.configuring = false;
        connecting(event.reason || undefined);
      }
      // A full st.socket re-probes, so one failed /api read does not pin SEMU on a WebRTC host.
      scheduleRetry("input", () => (inputOnly ? connectAndroid(true) : void startAndroid()));
    };
    ws.onerror = () => ws.close();
  };

  const startAndroid = async () => {
    const session = st.generation;
    const settings = await probeWebRtc();
    if (st.stopped || st.generation !== session) return;
    if (settings) {
      if (typeof RTCPeerConnection === "undefined")
        return fail("This browser cannot receive the device's WebRTC stream.");
      if (!target.videoOnly) connectAndroid(true);
      void readWebRtc(settings);
    } else if (useWebCodecs) connectAndroid();
    else fail("This browser cannot decode the Android stream (WebCodecs unavailable).");
  };

  const start = () => {
    if (!st.stopped) return;
    st.stopped = false;
    st.generation++;
    st.configuring = false;
    st.iosInputAdmitted = false;
    st.iosInputUnavailable = false;
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
    if (st.stopped) return;
    st.stopped = true;
    st.generation++;
    st.videoGeneration++;
    duoControl.clear();
    st.rotationCursor = null;
    for (const panel of st.panelClients) panel.stop();
    st.panelClients = [];
    st.panelSinks = null;
    st.mjpeg = false;
    clearFrameTimer();
    if (st.videoReadTimer !== null) clearTimeout(st.videoReadTimer);
    st.videoReadTimer = null;
    st.releaseImage?.();
    st.releaseImage = null;
    st.mjpegImage = null;
    for (const timer of retryTimers.values()) clearTimeout(timer);
    retryTimers.clear();
    st.primeController?.abort();
    st.primeController = null;
    st.controller?.abort();
    st.controller = null;
    closePeer();
    const discarded = st.socket;
    st.socket = null;
    discarded?.close();
    closeDecoder();
  };

  const send = (payload: Uint8Array<ArrayBuffer> | string) => {
    if (
      !st.stopped &&
      (!avcc || (st.iosInputAdmitted && !st.iosInputUnavailable)) &&
      st.socket?.readyState === WebSocket.OPEN
    )
      st.socket.send(payload);
  };

  const rawPoint = (x: number, y: number) => {
    // serve-sim streams the raw framebuffer; rotated devices need input
    // remapped into that raw space.
    if (platform !== "ios" || !st.screen || st.screen.width > st.screen.height) return { x, y };
    switch (st.screen.orientation) {
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
      if (platform !== "ios" || target.videoOnly || st.stopped || st.panelSinks === panels) return;
      if (panels && !st.screen?.supportsHingeAngle) return;
      st.panelSinks = panels;
      st.videoGeneration++;
      st.controller?.abort();
      st.controller = null;
      closePeer();
      closeDecoder();
      const retry = retryTimers.get("video");
      if (retry) clearTimeout(retry);
      retryTimers.delete("video");
      for (const panel of st.panelClients) panel.stop();
      st.panelClients = [];
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
      const current = st.screen?.supportsHingeAngle
        ? (st.rotationCursor ?? st.screen.orientation)
        : (st.screen?.orientation ?? "portrait");
      const next =
        IOS_ORIENTATIONS[(IOS_ORIENTATIONS.indexOf(current) + 1) % IOS_ORIENTATIONS.length]!;
      if (st.screen?.supportsHingeAngle) {
        st.rotationCursor = next;
        duoControl.enqueue({ control: "orientation", value: next });
      } else send(taggedJson(IOS_MSG_ORIENTATION, { orientation: next }));
    },
    setOrientation: (orientation) => {
      if (platform === "ios") send(taggedJson(IOS_MSG_ORIENTATION, { orientation }));
    },
  };
}
