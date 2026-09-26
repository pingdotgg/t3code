// @effect-diagnostics globalFetch:off globalTimers:off globalDate:off - This browser and WebView transport runs without an Effect runtime; lease deadlines compare epoch ms from the wire.
/* oxlint-disable unicorn/prefer-add-event-listener -- Each client owns its sockets and their handlers. */

/**
 * Framework-free client for `t3.browser/frames@1.0.0` remote pixel transport.
 *
 * Frames cross `/api/browser-frames` (the authenticated server proxy) as an
 * MJPEG body; input rides a separate WebSocket at `sessions/<tabId>/input`
 * bound to a minted lease. Two paint paths mirror the device client:
 *
 * - Canvas path: `fetch` the stream, split parts on the MJPEG boundary,
 *   `createImageBitmap` → `drawImage`, latest-wins under load. Part headers
 *   (`X-Frame-Seq`, `X-Engine-Generation`, `X-Geometry-Seq`) carry the
 *   fencing metadata — seq gaps are reported via `onDropped`.
 * - `<img>` path (default for `preferMjpeg` and non-streaming runtimes): the
 *   element's `src` is the stream URL. It sees no part headers, so geometry
 *   fencing for input comes only from `/config` and input-socket notices.
 *
 * A stream is bound to one `(sessionTuple, engineGeneration)`: the response
 * ending means the engine or epoch moved on, and the client re-fetches
 * `config` before reconnecting rather than trusting stale geometry.
 */
import type { BrowserFrameConfig } from "@t3tools/contracts";

import { type BrowserFrameAccess, withBrowserFramesQuery } from "./access.ts";

export type BrowserFrameStreamStatus = "connecting" | "streaming" | "error";

export interface BrowserFrameSessionRef {
  readonly environmentId: string;
  readonly threadId: string;
  readonly serverEpoch: string;
  readonly tabId: string;
}

/** Result of the owner's `browserFrames.openInput` mint (wsRpc or contract). */
export interface BrowserFrameInputLeaseMint {
  readonly leaseId: string;
  readonly inputTicket: string;
  readonly expiresAt: number;
}

export interface BrowserFrameTarget {
  readonly access: BrowserFrameAccess;
  readonly session: BrowserFrameSessionRef;
  /**
   * Lease-bound stream ticket (extension viewers). App sessions authenticate
   * with their own cookie/`wsTicket` and omit it.
   */
  readonly frameTicket?: string | null;
  /**
   * Mint (or renew) an input lease. Called on first `send*` use, before each
   * reconnect, and ahead of `expiresAt`; returning `null` keeps input offline.
   */
  readonly openInput?: () => Promise<BrowserFrameInputLeaseMint | null>;
  /**
   * Force the `<img>` path even where streaming fetch + `createImageBitmap`
   * exist — RN WebViews and plain-http remote origins.
   */
  readonly preferMjpeg?: boolean;
}

export interface BrowserFrameSurface {
  /** Canvas-path target; also where `<img>` frames could be composited later. */
  readonly canvas?: HTMLCanvasElement | null;
  /** `<img>` element for the fallback path. */
  readonly image?: HTMLImageElement | null;
}

export interface BrowserFrameEvents {
  readonly onStatus: (status: BrowserFrameStreamStatus, detail?: string) => void;
  /** Authoritative config — engine generation, CSS viewport, geometry seq. */
  readonly onConfig: (config: BrowserFrameConfig) => void;
  /**
   * Cumulative frames the capture produced but this client never painted,
   * derived from `X-Frame-Seq` gaps. Canvas path only.
   */
  readonly onDropped: (dropped: number) => void;
  /** The credential was rejected; the owner should re-mint and restart. */
  readonly onUnauthorized: () => void;
  readonly onInputConnected: (connected: boolean, detail?: string) => void;
  /** Hub-side input rejections: replay, stale-geometry, rate-limited, … */
  readonly onInputRejected: (seq: number, reason: string) => void;
  /** The client selected the `<img>` path; attach an image element if absent. */
  readonly onMjpegFallback?: (url: string) => void;
}

export interface BrowserFrameClientState {
  readonly status: BrowserFrameStreamStatus;
  readonly config: BrowserFrameConfig | null;
  readonly geometrySeq: number;
  readonly droppedFrames: number;
  readonly inputConnected: boolean;
}

export interface BrowserFrameClient {
  readonly start: () => void;
  readonly stop: () => void;
  readonly setSurface: (surface: BrowserFrameSurface) => void;
  readonly state: () => BrowserFrameClientState;
  /** Normalized 0..1 coordinates in the painted frame. */
  readonly sendPointer: (
    phase: "move" | "down" | "up",
    x: number,
    y: number,
    button?: "left" | "middle" | "right",
  ) => void;
  readonly sendWheel: (deltaX: number, deltaY: number, x: number, y: number) => void;
  readonly sendKey: (
    phase: "down" | "up",
    event: {
      readonly key: string;
      readonly code: string;
      readonly text?: string;
      readonly modifiers?: ReadonlyArray<"Alt" | "Control" | "Meta" | "Shift">;
    },
  ) => void;
  readonly sendText: (text: string) => void;
}

const RETRY_DELAY_MS = 1_000;
const FIRST_FRAME_TIMEOUT_MS = 15_000;
const MJPEG_FRAME_CHECK_MS = 250;
/** Re-mint this long before the lease's `expiresAt` so the socket never sees `expired`. */
const INPUT_RENEWAL_MARGIN_MS = 30_000;
const MJPEG_BOUNDARY = "t3frame";

const textDecoder = new TextDecoder();
const HEADER_END = new TextEncoder().encode("\r\n\r\n");

interface MjpegPart {
  readonly headers: Readonly<Record<string, string>>;
  readonly jpeg: Uint8Array;
}

/**
 * Incremental splitter for `multipart/x-mixed-replace`. `Content-Length`
 * carries the payload size so JPEG bytes can never be mistaken for framing.
 *
 * Bounds: the buffer never exceeds `MAX_BUFFER_BYTES` (oldest bytes drop
 * first), a part header that stays unterminated past `MAX_HEADER_BYTES` is
 * resynced past its delimiter, and when no declared part body is in flight
 * the un-consumed tail is kept to `MAX_TAIL_BYTES` — a peer cannot grow the
 * parser state without bound.
 */
export class MjpegDemuxer {
  static readonly MAX_BUFFER_BYTES = 32 * 1024 * 1024;
  static readonly MAX_HEADER_BYTES = 64 * 1024;
  static readonly MAX_TAIL_BYTES = 1024 * 1024;

  private buffer = new Uint8Array(256 * 1024);
  private length = 0;
  private readonly delimiter: Uint8Array;

  constructor(boundary: string = MJPEG_BOUNDARY) {
    this.delimiter = new TextEncoder().encode(`--${boundary}`);
  }

  push(bytes: Uint8Array): MjpegPart[] {
    const incoming =
      bytes.length > MjpegDemuxer.MAX_BUFFER_BYTES
        ? bytes.subarray(bytes.length - MjpegDemuxer.MAX_BUFFER_BYTES)
        : bytes;
    const overflow = this.length + incoming.length - MjpegDemuxer.MAX_BUFFER_BYTES;
    if (overflow > 0) {
      this.buffer.copyWithin(0, overflow, this.length);
      this.length -= overflow;
    }
    if (this.length + incoming.length > this.buffer.length) {
      let capacity = this.buffer.length;
      while (capacity < this.length + incoming.length) capacity *= 2;
      const grown = new Uint8Array(Math.min(capacity, MjpegDemuxer.MAX_BUFFER_BYTES));
      grown.set(this.buffer.subarray(0, this.length));
      this.buffer = grown;
    }
    this.buffer.set(incoming, this.length);
    this.length += incoming.length;

    const parts: MjpegPart[] = [];
    let offset = 0;
    let awaitingBody = false;
    for (;;) {
      const start = this.indexOf(this.delimiter, offset);
      if (start < 0) break;
      let cursor = start + this.delimiter.length;
      // Optional CRLF after the delimiter line.
      if (this.buffer[cursor] === 0x0d && this.buffer[cursor + 1] === 0x0a) cursor += 2;
      const headerEnd = this.indexOf(HEADER_END, cursor);
      if (headerEnd < 0) {
        if (this.length - cursor > MjpegDemuxer.MAX_HEADER_BYTES) {
          // Not a header — resync past the delimiter rather than buffering
          // an unterminated header forever.
          offset = cursor;
          continue;
        }
        break;
      }
      const headers: Record<string, string> = {};
      const headerText = textDecoder.decode(this.buffer.subarray(cursor, headerEnd));
      for (const line of headerText.split("\r\n")) {
        const colon = line.indexOf(":");
        if (colon > 0)
          headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
      }
      const bodyStart = headerEnd + HEADER_END.length;
      const contentLength = Number(headers["content-length"]);
      if (
        !Number.isFinite(contentLength) ||
        contentLength < 0 ||
        contentLength > MjpegDemuxer.MAX_BUFFER_BYTES
      ) {
        // Malformed or oversized part: resync at the next boundary.
        offset = bodyStart;
        continue;
      }
      if (this.length - bodyStart < contentLength) {
        awaitingBody = true;
        break;
      }
      parts.push({ headers, jpeg: this.buffer.slice(bodyStart, bodyStart + contentLength) });
      offset = bodyStart + contentLength;
    }
    if (offset > 0) {
      this.buffer.copyWithin(0, offset, this.length);
      this.length -= offset;
    }
    // Keep the un-consumed tail bounded: a stream that never completes a part
    // drops to the newest slice; a declared body in flight may retain what it
    // still needs (already capped by MAX_BUFFER_BYTES).
    if (!awaitingBody && this.length > MjpegDemuxer.MAX_TAIL_BYTES) {
      const drop = this.length - MjpegDemuxer.MAX_TAIL_BYTES;
      this.buffer.copyWithin(0, drop, this.length);
      this.length = MjpegDemuxer.MAX_TAIL_BYTES;
    }
    return parts;
  }

  reset(): void {
    this.length = 0;
  }

  private indexOf(needle: Uint8Array, from: number): number {
    outer: for (let i = from; i + needle.length <= this.length; i++) {
      for (let j = 0; j < needle.length; j++) {
        if (this.buffer[i + j] !== needle[j]) continue outer;
      }
      return i;
    }
    return -1;
  }
}

const supportsCanvasPath = (): boolean =>
  typeof globalThis !== "undefined" &&
  typeof globalThis.createImageBitmap === "function" &&
  typeof globalThis.ReadableStream === "function";

export function createBrowserFrameClient(
  target: BrowserFrameTarget,
  surface: BrowserFrameSurface,
  events: BrowserFrameEvents,
): BrowserFrameClient {
  const { access, session } = target;
  const tabId = encodeURIComponent(session.tabId);
  // The hub stamps each part with the runtime tab id it captured — the same
  // `[environmentId, threadId, serverEpoch, tabId]` serialization the engine
  // host produces — percent-encoded for header transport.
  const expectedSessionKey = JSON.stringify([
    session.environmentId,
    session.threadId,
    session.serverEpoch,
    session.tabId,
  ]);

  const sessionParams = (): Record<string, string> => ({
    environmentId: session.environmentId,
    threadId: session.threadId,
    serverEpoch: session.serverEpoch,
    ...(target.frameTicket ? { frameTicket: target.frameTicket } : {}),
  });
  const httpUrl = (leaf: string) =>
    withBrowserFramesQuery(`${access.httpBase}/sessions/${tabId}/${leaf}`, access, sessionParams());
  const inputUrl = (inputTicket: string) =>
    withBrowserFramesQuery(`${access.wsBase}/sessions/${tabId}/input`, access, {
      inputTicket,
    });

  let stopped = true;
  let generation = 0;
  let status: BrowserFrameStreamStatus = "connecting";
  let config: BrowserFrameConfig | null = null;
  let geometrySeq = 0;
  let droppedFrames = 0;
  let lastFrameSeq: number | null = null;
  let canvas: HTMLCanvasElement | null = surface.canvas ?? null;
  let image: HTMLImageElement | null = surface.image ?? null;
  let releaseImage: (() => void) | null = null;
  let useCanvasPath = false;
  let mjpeg = false;
  let controller: AbortController | null = null;
  let firstFrame = false;
  let frameTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingPart: MjpegPart | null = null;
  let decoding = false;
  const retryTimers = new Map<"stream" | "input", ReturnType<typeof setTimeout>>();

  // Input lane state.
  let inputSocket: WebSocket | null = null;
  let inputBound = false;
  let inputSeq = 0;
  let inputLease: BrowserFrameInputLeaseMint | null = null;
  let inputRenewalTimer: ReturnType<typeof setTimeout> | null = null;
  let inputWanted = false;

  const setStatus = (next: BrowserFrameStreamStatus, detail?: string) => {
    status = next;
    if (!stopped) events.onStatus(next, detail);
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
        () => fail("No frames received from the browser session. Reconnect to try again."),
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

  const scheduleRetry = (channel: "stream" | "input", run: () => void) => {
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

  // ------------------------------------------------------------------ config

  /**
   * `expectedGeneration` fences the whole continuation: a completion that
   * lands after stop/start must not mutate the restarted client's config,
   * geometry, or input state.
   */
  const fetchConfig = async (expectedGeneration: number): Promise<BrowserFrameConfig | null> => {
    try {
      const response = await fetch(httpUrl("config"), {
        credentials: access.credentials ? "include" : "same-origin",
      });
      if (response.status === 401 || response.status === 403) {
        if (!stopped && generation === expectedGeneration) handleUnauthorized();
        return null;
      }
      if (!response.ok) return null;
      const parsed = (await response.json()) as BrowserFrameConfig;
      if (stopped || generation !== expectedGeneration) return null;
      config = parsed;
      geometrySeq = parsed.geometrySeq;
      events.onConfig(parsed);
      return parsed;
    } catch {
      return null;
    }
  };

  // ------------------------------------------------------------ <img> path

  const observeImage = () => {
    releaseImage?.();
    releaseImage = null;
    const attached = image;
    if (!attached || stopped || !mjpeg) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let released = false;
    const check = () => {
      if (released || stopped) return;
      if (timer !== null) clearTimeout(timer);
      timer = null;
      if (attached.naturalWidth > 0 && attached.naturalHeight > 0) frameReceived();
      else timer = setTimeout(check, MJPEG_FRAME_CHECK_MS);
    };
    const error = () => {
      if (!released) {
        // End-of-body is the <img> client's only reset signal: re-fetch config
        // (the engine generation may have moved) and reconnect.
        if (firstFrame) {
          connecting();
          const imageGeneration = generation;
          void fetchConfig(imageGeneration).then((next) => {
            if (next !== null && !stopped && generation === imageGeneration) {
              scheduleRetry("stream", startStream);
            }
          });
        } else {
          fail("Could not receive the browser frame stream. Reconnect to try again.");
        }
      }
    };
    attached.addEventListener("load", check);
    attached.addEventListener("error", error);
    releaseImage = () => {
      released = true;
      if (timer !== null) clearTimeout(timer);
      attached.removeEventListener("load", check);
      attached.removeEventListener("error", error);
      attached.removeAttribute("src");
    };
    attached.src = httpUrl("stream.mjpeg");
    check();
  };

  const startMjpeg = () => {
    mjpeg = true;
    events.onMjpegFallback?.(httpUrl("stream.mjpeg"));
    observeImage();
  };

  // ------------------------------------------------------------ canvas path

  const paint = (bitmap: ImageBitmap, width: number, height: number) => {
    if (stopped) return;
    if (canvas === null) return;
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    const context = canvas.getContext("2d");
    if (!context)
      return fail("Could not display the browser frame stream. Reconnect to try again.");
    context.drawImage(bitmap, 0, 0, width, height);
    frameReceived();
  };

  const notePart = (part: MjpegPart): boolean => {
    const seq = Number(part.headers["x-frame-seq"]);
    const engine = part.headers["x-engine-generation"];
    // A generation or session change mid-stream means the engine was
    // replaced: the hub ends the response, and reconnect must re-read
    // config first.
    if (config !== null && engine !== undefined && engine !== config.engineGeneration) {
      return false;
    }
    const sessionKey = part.headers["x-session-key"];
    if (sessionKey !== undefined && decodeURIComponent(sessionKey) !== expectedSessionKey) {
      return false;
    }
    if (Number.isFinite(seq)) {
      if (lastFrameSeq !== null && seq > lastFrameSeq + 1) {
        droppedFrames += seq - lastFrameSeq - 1;
        events.onDropped(droppedFrames);
      }
      if (lastFrameSeq === null || seq > lastFrameSeq) lastFrameSeq = seq;
    }
    // Geometry is NOT committed here: `geometrySeq` only advances when this
    // part is actually painted (see drainPendingPart). Committing on receipt
    // would let input packets name geometry whose pixels the user never saw.
    return true;
  };

  /**
   * Paint commits geometry atomically with the pixels: `geometrySeq` (what
   * input packets assert) becomes the painted part's stamp only after
   * `drawImage` ran. A queued-but-superseded part cannot advance it.
   */
  const commitPaintedGeometry = (part: MjpegPart): void => {
    const painted = Number(part.headers["x-geometry-seq"]);
    if (!Number.isFinite(painted) || painted === geometrySeq) return;
    geometrySeq = painted;
    if (config !== null) {
      config = { ...config, geometrySeq: painted };
      events.onConfig(config);
    }
  };

  const drainPendingPart = async (isCurrent: () => boolean) => {
    if (decoding) return;
    const part = pendingPart;
    if (part === null) return;
    decoding = true;
    pendingPart = null;
    try {
      const bitmap = await createImageBitmap(
        new Blob([part.jpeg as BlobPart], { type: "image/jpeg" }),
      );
      try {
        if (isCurrent()) {
          const width = Number(part.headers["x-frame-width"]) || bitmap.width;
          const height = Number(part.headers["x-frame-height"]) || bitmap.height;
          paint(bitmap, width, height);
          if (!stopped) commitPaintedGeometry(part);
        }
      } finally {
        bitmap.close();
      }
    } catch {
      // A part that cannot decode is dropped; the next part is self-contained.
    } finally {
      decoding = false;
      if (pendingPart !== null && isCurrent()) void drainPendingPart(isCurrent);
    }
  };

  const readStream = async () => {
    const sessionGeneration = generation;
    const streamController = new AbortController();
    controller = streamController;
    const demuxer = new MjpegDemuxer();
    lastFrameSeq = null;
    const isCurrent = () =>
      !stopped && generation === sessionGeneration && controller === streamController;
    // Retry decisions fence on the stream's lifetime generation, not the
    // controller identity: the EOF path clears `controller` before deciding
    // whether to reconnect, and an already-cleared controller must not
    // disable its own retry.
    const alive = () => !stopped && generation === sessionGeneration;
    let retryDetail: string | undefined;
    try {
      const response = await fetch(httpUrl("stream.mjpeg"), {
        signal: streamController.signal,
        credentials: access.credentials ? "include" : "same-origin",
      });
      if (!isCurrent()) return;
      if (response.status === 401 || response.status === 403) return handleUnauthorized();
      if (!response.ok || !response.body) throw new Error(`stream ${response.status}`);
      const reader = response.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (!isCurrent()) return;
        if (done) break;
        for (const part of demuxer.push(value)) {
          if (!notePart(part)) {
            // Engine generation moved mid-stream: the response is stale, and
            // the input lease bound to that generation is no longer usable.
            await reader.cancel().catch(() => {});
            if (alive()) {
              controller = null;
              streamController.abort();
              // Same boundary as end-of-body: the replaced guest's first-paint
              // eligibility and queued pixels must not carry into the new
              // generation — input waits for a replacement paint.
              connecting();
              resetInput();
              pendingPart = null;
              void fetchConfig(sessionGeneration).then((next) => {
                if (next !== null && alive()) scheduleRetry("stream", startStream);
              });
            }
            return;
          }
          // Latest-wins: keep only the newest unwritten part rather than
          // queueing stale frames behind decode latency.
          pendingPart = part;
          void drainPendingPart(isCurrent);
        }
      }
    } catch (cause) {
      if (!isCurrent()) return;
      retryDetail = (cause as Error).message;
    }
    if (alive()) {
      controller = null;
      streamController.abort();
      // End-of-body: the bound engine or epoch moved on. Re-read config so the
      // next attempt fences against the live generation, then reconnect.
      connecting(retryDetail);
      resetInput();
      void fetchConfig(sessionGeneration).then(() => {
        if (alive()) scheduleRetry("stream", startStream);
      });
    }
  };

  const startStream = () => {
    if (stopped) return;
    controller?.abort();
    controller = null;
    pendingPart = null;
    decoding = false;
    if (useCanvasPath) {
      void readStream();
    } else {
      startMjpeg();
    }
  };

  // ------------------------------------------------------------------ input

  const clearInputRenewal = () => {
    if (inputRenewalTimer !== null) clearTimeout(inputRenewalTimer);
    inputRenewalTimer = null;
  };

  const closeInputSocket = () => {
    inputBound = false;
    const socket = inputSocket;
    inputSocket = null;
    if (socket !== null) {
      try {
        socket.onclose = null;
        socket.onerror = null;
        socket.onmessage = null;
        socket.close();
      } catch {
        // Already closed.
      }
    }
  };

  const scheduleInputRenewal = (expiresAt: number) => {
    clearInputRenewal();
    const delay = expiresAt - Date.now() - INPUT_RENEWAL_MARGIN_MS;
    if (delay <= 0) return;
    inputRenewalTimer = setTimeout(() => {
      inputRenewalTimer = null;
      if (!stopped && inputWanted) void connectInput();
    }, delay);
  };

  /**
   * A stream boundary (generation move, EOF, config restart) invalidates the
   * lease-bound socket state: the socket was bound against the old
   * geometry/generation. Close it, drop the lease, and re-mint through the
   * normal retry path while input is still wanted.
   */
  const resetInput = () => {
    closeInputSocket();
    clearInputRenewal();
    inputLease = null;
    inputBound = false;
    inputSeq = 0;
    if (!stopped && inputWanted) scheduleRetry("input", () => void connectInput());
  };

  const connectInput = async () => {
    if (stopped || !inputWanted || target.openInput === undefined) return;
    closeInputSocket();
    const mintGeneration = generation;
    const mint = await target.openInput().catch(() => null);
    // A mint that completes after a restart must not wire a socket into the
    // new generation's state.
    if (stopped || !inputWanted || generation !== mintGeneration) return;
    if (mint === null) {
      events.onInputConnected(false, "input-lease-unavailable");
      scheduleRetry("input", () => void connectInput());
      return;
    }
    inputLease = mint;
    scheduleInputRenewal(mint.expiresAt);
    const socket = new WebSocket(inputUrl(mint.inputTicket));
    inputSocket = socket;
    socket.onopen = () => {
      // `bound` — not `open` — is the live signal: the socket is bound to the
      // lease only after the hub's fences pass.
    };
    socket.onmessage = (event) => {
      if (inputSocket !== socket) return;
      let notice: {
        type?: string;
        geometrySeq?: number;
        expiresAt?: number;
        seq?: number;
        highSeq?: number;
        reason?: string;
      };
      try {
        notice = JSON.parse(typeof event.data === "string" ? event.data : "") as typeof notice;
      } catch {
        return;
      }
      switch (notice.type) {
        case "bound":
          inputBound = true;
          if (typeof notice.expiresAt === "number") scheduleInputRenewal(notice.expiresAt);
          // The hub retains the lease's replay high-water mark across socket
          // replacement — resume numbering above it so packets after a
          // reconnect continue the lease sequence rather than restarting at
          // zero into `replay` rejections.
          if (
            typeof notice.highSeq === "number" &&
            Number.isInteger(notice.highSeq) &&
            notice.highSeq >= 0
          ) {
            inputSeq = notice.highSeq;
          }
          events.onInputConnected(true);
          break;
        case "geometry":
          // The notice reports the hub's newest geometry for display, but the
          // packet seq stays paint-committed: `geometrySeq` advances only when
          // a frame stamped with it has actually been drawn.
          if (typeof notice.geometrySeq === "number" && config !== null) {
            config = { ...config, geometrySeq: notice.geometrySeq };
            events.onConfig(config);
          }
          break;
        case "rejected":
          if (typeof notice.seq === "number") {
            events.onInputRejected(notice.seq, notice.reason ?? "rejected");
          }
          break;
      }
    };
    const onDead = () => {
      if (inputSocket !== socket) return;
      inputSocket = null;
      inputBound = false;
      events.onInputConnected(false);
      if (!stopped && inputWanted) scheduleRetry("input", () => void connectInput());
    };
    socket.onclose = onDead;
    socket.onerror = onDead;
  };

  const wantInput = () => {
    // The `<img>` path is read-only: it cannot observe part headers, so no
    // paint barrier can prove which geometry the user is looking at. Input
    // only exists on the canvas path where paint commits geometry.
    if (inputWanted || stopped || !useCanvasPath) return;
    inputWanted = true;
    void connectInput();
  };

  const sendPacket = (event: unknown) => {
    const socket = inputSocket;
    if (socket === null || socket.readyState !== WebSocket.OPEN || !inputBound) return;
    // First-paint barrier: until a frame has actually been drawn, `geometrySeq`
    // is only config-asserted and must not authorize input.
    if (!firstFrame) return;
    inputSeq += 1;
    socket.send(JSON.stringify({ seq: inputSeq, geometrySeq, event }));
  };

  const sendPointer: BrowserFrameClient["sendPointer"] = (phase, x, y, button) => {
    wantInput();
    sendPacket({ type: "pointer", phase, x, y, ...(button !== undefined ? { button } : {}) });
  };

  const sendWheel: BrowserFrameClient["sendWheel"] = (deltaX, deltaY, x, y) => {
    wantInput();
    sendPacket({ type: "wheel", deltaX, deltaY, x, y });
  };

  const sendKey: BrowserFrameClient["sendKey"] = (phase, event) => {
    wantInput();
    sendPacket({
      type: "key",
      phase,
      key: event.key,
      code: event.code,
      ...(event.text !== undefined ? { text: event.text } : {}),
      ...(event.modifiers !== undefined ? { modifiers: event.modifiers } : {}),
    });
  };

  const sendText: BrowserFrameClient["sendText"] = (text) => {
    wantInput();
    sendPacket({ type: "text", text });
  };

  // ------------------------------------------------------------------ cycle

  const start = () => {
    if (!stopped) return;
    stopped = false;
    generation += 1;
    droppedFrames = 0;
    lastFrameSeq = null;
    useCanvasPath = supportsCanvasPath() && !target.preferMjpeg;
    mjpeg = !useCanvasPath;
    connecting();
    const startGeneration = generation;
    void fetchConfig(startGeneration).then((next) => {
      if (stopped || generation !== startGeneration) return;
      if (next === null) {
        scheduleRetry("stream", startStream);
        return;
      }
      startStream();
    });
  };

  const stop = () => {
    if (stopped) return;
    stopped = true;
    generation += 1;
    status = "connecting";
    inputWanted = false;
    clearFrameTimer();
    clearInputRenewal();
    for (const timer of retryTimers.values()) clearTimeout(timer);
    retryTimers.clear();
    controller?.abort();
    controller = null;
    closeInputSocket();
    releaseImage?.();
    releaseImage = null;
    pendingPart = null;
    decoding = false;
    firstFrame = false;
  };

  const setSurface = (next: BrowserFrameSurface) => {
    canvas = next.canvas ?? null;
    if (image !== (next.image ?? null)) {
      releaseImage?.();
      releaseImage = null;
      image = next.image ?? null;
      observeImage();
    }
  };

  const state = (): BrowserFrameClientState => ({
    status,
    config,
    geometrySeq,
    droppedFrames,
    inputConnected: inputBound,
  });

  return { start, stop, setSurface, state, sendPointer, sendWheel, sendKey, sendText };
}
