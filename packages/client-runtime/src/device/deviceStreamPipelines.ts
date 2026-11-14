// @effect-diagnostics globalFetch:off globalTimers:off - This browser and WebView transport runs without an Effect runtime.

import { type DuoControlState, type DuoPose } from "./duoControl.ts";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
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
import { AvccDemuxer, avcCodecString, webRtcSessionId } from "./streamCodec.ts";
import type { DeviceStreamPipelineDeps } from "./stream.ts";

/**
 * The frame, decoder, MJPEG and WebRTC halves of a device stream. They share the
 * client's mutable stream state (`st`) and its helpers, so they are built once per
 * client instead of living inline in the client factory.
 */
export function makeDeviceStreamPipelines(deps: DeviceStreamPipelineDeps) {
  const {
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
    createClient,
    send,
    start,
    stop,
  } = deps;

  const setStatus = (status: DeviceStreamStatus, detail?: string) => {
    if (!st.stopped) events.onStatus(status, detail);
  };

  const clearFrameTimer = () => {
    if (st.frameTimer !== null) clearTimeout(st.frameTimer);
    st.frameTimer = null;
  };

  const fail = (detail: string) => {
    if (st.stopped) return;
    stop();
    events.onInputConnected(false, detail);
    events.onStatus("error", detail);
  };

  const connecting = (detail?: string) => {
    st.firstFrame = false;
    if (st.frameTimer === null) {
      st.frameTimer = setTimeout(
        () => fail("No video received from the device. Reconnect to try again."),
        FIRST_FRAME_TIMEOUT_MS,
      );
    }
    setStatus("connecting", detail);
  };

  const frameReceived = () => {
    if (st.firstFrame) return;
    st.firstFrame = true;
    clearFrameTimer();
    setStatus("streaming");
  };

  const observeMjpegImage = () => {
    st.releaseImage?.();
    st.releaseImage = null;
    const image = st.mjpegImage;
    if (!image || st.stopped || !st.mjpeg) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let released = false;
    const check = () => {
      if (released || st.stopped) return;
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
    st.releaseImage = () => {
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
    if (st.mjpegImage === image) return;
    st.releaseImage?.();
    st.releaseImage = null;
    st.mjpegImage = image;
    observeMjpegImage();
  };

  const fallBackToMjpeg = () => {
    if (st.stopped || st.mjpeg) return;
    st.mjpeg = true;
    st.controller?.abort();
    st.controller = null;
    closeDecoder();
    connecting();
    events.onMjpegFallback(mjpegUrl());
    if (!st.releaseImage) observeMjpegImage();
  };

  const paint = (source: CanvasImageSource, width: number, height: number) => {
    if (st.stopped) return;
    if (!avcc && (st.screen?.width !== width || st.screen.height !== height)) {
      st.screen = { width, height, orientation: width > height ? "landscape_left" : "portrait" };
      events.onScreen(st.screen);
    }
    if (!sink.present(source, width, height)) {
      fail("Could not display the device stream. Reconnect to try again.");
      return;
    }
    frameReceived();
  };

  const closeDecoder = () => {
    st.decoderEpoch++;
    try {
      st.videoDecoder?.close();
    } catch {}
    st.videoDecoder = null;
    st.awaitingKeyframe = true;
  };

  const recoverDecoder = () => {
    if (serveSimOnly) {
      // A new AVCC request starts a fresh capture with a keyframe; there is no MJPEG.
      closeDecoder();
      st.controller?.abort();
    } else if (platform === "ios") fallBackToMjpeg();
    else {
      closeDecoder();
      connecting("Video decoder restarted.");
      requestKeyframe();
    }
  };

  const makeDecoder = () => {
    const feedGeneration = st.videoGeneration;
    const decoder = new VideoDecoder({
      output: (frame) => {
        try {
          if (st.videoDecoder === decoder && (!avcc || feedGeneration === st.videoGeneration)) {
            st.decodedVideoGeneration = feedGeneration;
            paint(frame, frame.displayWidth, frame.displayHeight);
          }
        } finally {
          frame.close();
        }
      },
      error: () => {
        if (
          st.stopped ||
          st.videoDecoder !== decoder ||
          (avcc && feedGeneration !== st.videoGeneration)
        )
          return;
        recoverDecoder();
      },
    });
    return decoder;
  };

  const configureDecoder = async (
    config: VideoDecoderConfig,
    isCurrent = () => !st.stopped,
  ): Promise<boolean> => {
    const epoch = st.decoderEpoch;
    const full: VideoDecoderConfig = { ...config, optimizeForLatency: true };
    const support = await VideoDecoder.isConfigSupported(full).catch(() => ({ supported: false }));
    if (!isCurrent() || epoch !== st.decoderEpoch) return false;
    if (!support.supported) {
      if (platform === "android") fail(`This browser cannot decode ${config.codec}.`);
      return false;
    }
    try {
      if (!st.videoDecoder || st.videoDecoder.state === "closed") st.videoDecoder = makeDecoder();
      st.videoDecoder.configure(full);
      return true;
    } catch (cause) {
      if (platform === "android") fail(`Video decoder: ${(cause as Error).message}`);
      return false;
    }
  };

  const decode = (isKey: boolean, data: Uint8Array, pts?: number | null) => {
    if (!st.videoDecoder || st.videoDecoder.state !== "configured") return;
    if (st.awaitingKeyframe) {
      if (!isKey) return;
      st.awaitingKeyframe = false;
    }
    if (st.videoDecoder.decodeQueueSize > SOFT_DECODE_QUEUE) {
      if (!avcc) {
        recoverDecoder();
        return;
      }
      // Native IDRs are spaced by frame count, so an idle simulator may take
      // minutes to produce one. A new AVCC subscription forces a fresh IDR.
      st.controller?.abort();
      closeDecoder();
      return;
    }
    try {
      st.videoDecoder.decode(
        new EncodedVideoChunk({
          type: isKey ? "key" : "delta",
          timestamp: pts ?? st.timestamp,
          data,
        }),
      );
      st.timestamp += FRAME_DURATION_US;
    } catch {
      recoverDecoder();
    }
  };

  const requestKeyframe = () => {
    if (platform === "android" && st.socket?.readyState === WebSocket.OPEN) {
      st.socket.send(JSON.stringify({ type: "reset-video", ack: false }));
    }
  };

  const scheduleRetry = (channel: "video" | "input", run: () => void) => {
    if (st.stopped || retryTimers.has(channel)) return;
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
    const lifecycle = st.generation;
    const feedGeneration = ++st.videoGeneration;
    const demuxer = new AvccDemuxer();
    const videoController = new AbortController();
    st.controller = videoController;
    const isCurrent = () =>
      !st.stopped &&
      st.generation === lifecycle &&
      st.videoGeneration === feedGeneration &&
      st.controller === videoController;
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
          st.controller = null;
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
          retryDetail = "Device stream st.stopped receiving video. Reconnecting…";
          videoController.abort();
        }, FIRST_FRAME_TIMEOUT_MS);
        st.videoReadTimer = timer;
        let result: ReadableStreamReadResult<Uint8Array>;
        try {
          result = await reader.read();
        } finally {
          clearTimeout(timer);
          if (st.videoReadTimer === timer) st.videoReadTimer = null;
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
                    if (isCurrent() && st.decodedVideoGeneration !== feedGeneration)
                      paint(bitmap, bitmap.width, bitmap.height);
                  } finally {
                    bitmap.close();
                  }
                })
                .catch(() => {});
              break;
            case "description": {
              st.awaitingKeyframe = true;
              const configured = await configureDecoder(
                {
                  codec: avcCodecString(chunk.payload),
                  description: chunk.payload,
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
      st.controller = null;
      videoController.abort();
      closeDecoder();
      connecting(retryDetail);
      scheduleRetry("video", () => void readIosVideo());
    }
  };

  /**
   * serve-sim's helper only accepts HID and pushes its st.screen config once
   * st.screen capture is running, and the AVCC stream does not reliably start
   * it. Touching the MJPEG endpoint does; one aborted request is enough.
   */
  const primeIosHelper = async (session: number) => {
    const primeAbort = new AbortController();
    st.primeController = primeAbort;
    const timeout = setTimeout(() => primeAbort.abort(), 2_000);
    try {
      const response = await fetch(httpUrl(`/helper/${device}/stream.mjpeg`), {
        signal: primeAbort.signal,
        credentials: access.credentials ? "include" : "same-origin",
      });
      if (st.stopped || st.generation !== session) return;
      if (response.status === 401 || response.status === 403) return handleUnauthorized();
      await response.body?.getReader().read();
    } catch {
    } finally {
      clearTimeout(timeout);
      primeAbort.abort();
      if (st.primeController === primeAbort) st.primeController = null;
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
    const current = st.peer;
    if (!current) return;
    st.peer = null;
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
    const lifecycle = st.generation;
    const feedGeneration = ++st.videoGeneration;
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
    st.peer = current;
    const isCurrent = () =>
      !st.stopped &&
      st.generation === lifecycle &&
      st.videoGeneration === feedGeneration &&
      st.peer === current;
    // After the first frame nothing else bounds a feed that stops: the st.peer
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
      st.iceGatheringDeadlineMs = ICE_GATHERING_TIMEOUT_MS;
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
        const timer = setTimeout(() => done(false), st.iceGatheringDeadlineMs);
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
        st.iceGatheringDeadlineMs < ICE_GATHERING_MAX_TIMEOUT_MS
      ) {
        st.iceGatheringDeadlineMs = Math.min(
          st.iceGatheringDeadlineMs * 2,
          ICE_GATHERING_MAX_TIMEOUT_MS,
        );
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
    const session = st.generation;
    if (typeof RTCPeerConnection === "undefined") return fail(failure);
    const settings = (await probeWebRtc()) ?? (locked ? { transport: "webrtc" as const } : null);
    if (st.stopped || st.generation !== session) return;
    if (!settings) return fail(failure);
    if (st.mjpeg) {
      st.mjpeg = false;
      st.releaseImage?.();
      st.releaseImage = null;
      events.onCanvasVideo?.();
    }
    // MJPEG may have shown frames already: say the stream is connecting again
    // rather than leave a blank canvas until the first WebRTC frame.
    connecting("Switching to WebRTC.");
    void readWebRtc(settings);
  };

  return {
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
  };
}
