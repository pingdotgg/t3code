// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off globalTimersInEffect:off -- Loopback HTTP/WS server at the native socket boundary; expiry deadlines and the geometry poll run as Node timers outside Effect fibers.
/**
 * Loopback browser-frame hub for `t3.browser/frames@1.0.0`.
 *
 * Serves JPEG/MJPEG frames and a JSON input socket for the preview tabs this
 * Electron host owns, mirroring the device-hub shape: bound to 127.0.0.1 on
 * an ephemeral port and authenticated with a per-boot shared `secret` — the
 * only caller is the app's own `BrowserFrameProxy`, which receives the
 * `{origin, secret}` pair through host registration and injects the verified
 * session tuple and lease binding as `x-t3-*` URL params. Everything else
 * about authority (lease minting, revocation, principal binding) lives
 * server-side; the secret is what makes loopback non-authoritative-by-
 * omission rather than non-authoritative-by-accident.
 *
 * Input sockets run the held-input machine: one active socket plus one
 * pending candidate per session. An upgrade while an incumbent is
 * bound/live/closing parks as the pending candidate (latest arrival wins —
 * a parked candidate is closed `superseded` when a newer upgrade lands) and
 * guarded-binds only after the incumbent's held-input cleanup settles,
 * keeping its reservation through the final config read. A same-lease
 * upgrade carrying an `x-t3-ticket-seq` older than the newest accepted
 * ticket — incumbent or pending — never seizes the slot: it binds as a
 * shadow that dispatches and expires but owns nothing.
 *
 * Actions never cross this surface: input packets map onto CDP `Input.*`
 * through the Manager's human lane only.
 */
import * as NodeCrypto from "node:crypto";
import * as NodeHttp from "node:http";
import type * as NodeStream from "node:stream";

import {
  BROWSER_FRAME_INPUT_MAX_EVENTS_PER_SECOND,
  BROWSER_FRAME_INPUT_PACKET_MAX_BYTES,
  BrowserFrameInputPacket,
  type BrowserFrameSessionTuple,
  EnvironmentId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { WebSocket, WebSocketServer } from "ws";

import * as PreviewManager from "./Manager.ts";

const MJPEG_BOUNDARY = "t3frame";
const FRAME_FPS = 12;
const GEOMETRY_POLL_MS = 1_000;
const INPUT_CLOSE_CODE = 4000;
/**
 * A stalled cleanup lane cannot hold the pending slot hostage: the incumbent
 * wait is bounded and a deadline overrun counts as a failed cleanup on the
 * successor's `bound` notice (`cleanupIncomplete`).
 */
const INPUT_CLEANUP_DEADLINE_MS = 5_000;
/** In-flight + queued dispatch work per socket; overflow rejects `backpressured`. */
const INPUT_DISPATCH_QUEUE_MAX = 32;
/** Idle sessions (no viewers, no input, no pending) are dropped after this. */
const ACTIVITY_IDLE_MS = 60_000;
/**
 * Lease lanes outlive idle activity reclamation — tickets remain valid for
 * minutes after the session's frame caches are dropped. Lanes are only ever
 * swept once expired: evicting a live lane would reset its replay high-water
 * and accepted ticket sequence, so the cap bounds expired-entry accumulation
 * while live lanes are retained for their credential's lifetime.
 */
const LEASE_LANE_CAP = 4096;

/**
 * Lease-lane capacity override — a test seam for driving the over-cap sweep
 * without thousands of upgrades; production layers never provide it.
 */
export class BrowserFrameHubLeaseLaneCap extends Context.Reference<number>(
  "t3.browserFrames/BrowserFrameHubLeaseLaneCap",
  { defaultValue: () => LEASE_LANE_CAP },
) {}
/** Config-confirmed geometry-key → viewport memory, FIFO-bounded. */
const GEOMETRY_VIEWPORT_CAP = 128;

const SESSION_PATH = /^\/sessions$/;
const HEALTH_PATH = /^\/health$/;
const SESSION_LEAF_PATH = /^\/sessions\/([^/]+)\/(stream\.mjpeg|snapshot|config)$/;
const SESSION_INPUT_PATH = /^\/sessions\/([^/]+)\/input$/;

interface AssertedSession {
  /** The serialized session tuple — identical to the Manager's runtime tab id. */
  readonly runtimeTabId: string;
  readonly tuple: BrowserFrameSessionTuple;
}

interface HubGeometry {
  seq: number;
  /** Capture/config-derived `generation:cssWxcssH@zoom`; a change bumps `seq`. */
  key: string;
  /**
   * The css viewport a config read DERIVED this key from — null when the key
   * arrived only via frame stamps. Input dispatches against this viewport,
   * never a newer config read's, so the admitted key and the coordinate
   * space can never describe different viewports; null means the hub does
   * not yet know this key's coordinate space and input must be rejected.
   */
  viewportCss: { readonly width: number; readonly height: number } | null;
}

interface SessionActivity {
  viewers: number;
  /**
   * Stream startups past request validation but before viewer registration:
   * the config/capture awaits in between must not look idle to the sweep —
   * reclaiming the activity would leave the startup incrementing a detached
   * object whose later disconnect then issues `stopRemoteCapture` while
   * another viewer still owns the live activity.
   */
  pendingStarts: number;
  /** The owning input socket — the slot a same-or-newer ticket supersedes. */
  input: HubInputSocket | null;
  /**
   * Bound sockets whose ticketSeq is older than the incumbent's for the same
   * lease: they dispatch and expire but never own the slot, run lease
   * cleanup, or receive geometry notices.
   */
  shadows: Set<HubInputSocket>;
  /** The single parked upgrade awaiting the incumbent's `ended`. */
  pending: PendingCandidate | null;
  geometry: HubGeometry | null;
  /** Latest capture-loop frame — seeds newly attached viewers. */
  latestFrame: PreviewManager.RemoteLiveFrame | null;
  lastFrame: { readonly width: number; readonly height: number; readonly seq: number } | null;
  /**
   * Issued-read counter for config fetches: only the newest issued read may
   * apply, so a stale completion cannot move advertised geometry backward.
   */
  configReadSeq: number;
  /** Last time the session had viewers, input, or pending work — idle GC. */
  lastTouchedAt: number;
  /**
   * This session's own sweep: refresh geometry while anything watches or
   * controls it, and reclaim the activity — poller, cached frames, and all —
   * once it has been idle past ACTIVITY_IDLE_MS. Nothing polls a session
   * nobody owns.
   */
  poller: NodeJS.Timeout;
}

interface PendingCandidate {
  readonly ws: WebSocket;
  readonly asserted: AssertedSession;
  readonly leaseId: string;
  readonly ticketSeq: number;
  readonly expiresAt: number;
  /** The `x-t3-engine-generation` pin presented at upgrade, re-checked at bind. */
  readonly engineGeneration: string | null;
  cancelled: boolean;
  readonly expiryTimer: NodeJS.Timeout;
}

interface HubInputSocket {
  readonly runtimeTabId: string;
  readonly leaseId: string;
  readonly ticketSeq: number;
  readonly expiresAt: number;
  readonly engineGeneration: string;
  readonly socket: WebSocket;
  /** Owning sockets hold `activity.input`; shadows never do. */
  readonly owning: boolean;
  state: "bound" | "live" | "closing" | "ended";
  lastSeq: number;
  seqGaps: number;
  rejected: number;
  dispatchFailures: number;
  /** Single-flight cleanup — the first terminal trigger owns it. */
  endPromise: Promise<PreviewManager.RemoteInputReleaseResult> | null;
  /** Serialized dispatch: packets enter the guest lane in arrival order. */
  dispatchTail: Promise<void>;
  queuedDispatch: number;
  readonly expiryTimer: NodeJS.Timeout;
}

export class BrowserFrameHubError extends Schema.TaggedError<BrowserFrameHubError>()(
  "BrowserFrameHubError",
  { message: Schema.String },
) {}

export class BrowserFrameHub extends Context.Service<
  BrowserFrameHub,
  {
    /** Loopback origin like `http://127.0.0.1:49300`. */
    readonly origin: string;
    /**
     * Per-boot shared secret the proxy presents as `x-t3-hub-auth`. It is
     * delivered to the server broker inside host registration, which the
     * broker stores but never exposes to viewers.
     */
    readonly secret: string;
  }
>()("@t3tools/desktop/preview/FrameHub/BrowserFrameHub") {}

const decodePacket = Schema.decodeUnknownSync(BrowserFrameInputPacket);

const parseAssertedSession = (url: URL): AssertedSession | null => {
  const raw = url.searchParams.get("x-t3-session");
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      Array.isArray(parsed) &&
      parsed.length === 4 &&
      typeof parsed[0] === "string" &&
      parsed[0].length > 0 &&
      typeof parsed[1] === "string" &&
      parsed[1].length > 0 &&
      typeof parsed[2] === "string" &&
      parsed[2].length > 0 &&
      typeof parsed[3] === "string" &&
      parsed[3].length > 0
    ) {
      return {
        runtimeTabId: raw,
        tuple: {
          environmentId: EnvironmentId.make(parsed[0]),
          threadId: ThreadId.make(parsed[1]),
          serverEpoch: parsed[2],
          tabId: parsed[3],
        },
      };
    }
  } catch {
    // fall through
  }
  return null;
};

/**
 * Over-cap lane sweep. A live lane is never evicted — dropping it would
 * reset its replay high-water and accepted ticket sequence, re-authorizing
 * packets the lease already rejected — so only expired entries die and the
 * map may exceed the cap while every lane is still valid.
 */
export const sweepExpiredLeaseLanes = (
  lanes: Map<string, { expiresAt: number }>,
  now: number,
  cap: number = LEASE_LANE_CAP,
): void => {
  if (lanes.size <= cap) return;
  for (const [key, entry] of lanes) {
    if (entry.expiresAt <= now) lanes.delete(key);
  }
};

const writeJson = (res: NodeHttp.ServerResponse, status: number, body: unknown): void => {
  if (res.headersSent || res.destroyed) {
    res.destroy();
    return;
  }
  res.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store, no-transform",
  });
  res.end(JSON.stringify(body));
};

const make = Effect.gen(function* () {
  const manager = yield* PreviewManager.PreviewManager;
  const context = yield* Effect.context<never>();
  const leaseLaneCap = Context.get(context, BrowserFrameHubLeaseLaneCap);
  const runFork = Effect.runForkWith(context);
  const runPromise = <A, E>(effect: Effect.Effect<A, E>): Promise<A> =>
    new Promise<A>((resolve, reject) =>
      runFork(
        Effect.matchEffect(effect, {
          onFailure: (error: E) => Effect.sync(() => reject(error)),
          onSuccess: (value: A) => Effect.sync(() => resolve(value)),
        }),
      ),
    );

  const secret = NodeCrypto.randomBytes(32).toString("hex");
  const secretDigest = NodeCrypto.createHash("sha256").update(secret).digest();
  /** Constant-time check via a digest so header length never leaks the secret. */
  const authorized = (req: NodeHttp.IncomingMessage): boolean => {
    const presented = req.headers["x-t3-hub-auth"];
    let value = Array.isArray(presented) ? presented[0] : presented;
    // Node's WebSocket cannot set upgrade headers, so the proxy's input
    // socket authenticates via query — loopback only, same threat class.
    if (typeof value !== "string" || value.length === 0) {
      value =
        req.url !== undefined
          ? (new URL(req.url, "http://127.0.0.1").searchParams.get("x-t3-hub-auth") ?? undefined)
          : undefined;
    }
    if (typeof value !== "string" || value.length === 0) return false;
    return NodeCrypto.timingSafeEqual(
      NodeCrypto.createHash("sha256").update(value).digest(),
      secretDigest,
    );
  };

  const activities = new Map<string, SessionActivity>();
  const activityFor = (runtimeTabId: string): SessionActivity => {
    const existing = activities.get(runtimeTabId);
    if (existing) {
      existing.lastTouchedAt = Date.now();
      return existing;
    }
    const created: SessionActivity = {
      viewers: 0,
      pendingStarts: 0,
      input: null,
      shadows: new Set(),
      pending: null,
      geometry: null,
      latestFrame: null,
      lastFrame: null,
      configReadSeq: 0,
      lastTouchedAt: Date.now(),
      poller: setInterval(() => pollActivity(runtimeTabId), GEOMETRY_POLL_MS),
    };
    created.poller.unref();
    activities.set(runtimeTabId, created);
    return created;
  };

  /**
   * Per-lease ordering/replay state — rate tokens, the replay high-water
   * mark, the newest accepted ticket seq, and the lease deadline seen so
   * far. This lives outside `SessionActivity` on purpose: idle GC drops an
   * activity after a minute while its tickets stay valid far longer, and an
   * already-upgraded socket whose config read outlives the sweep must still
   * find the ordering its lease established. Entries die only with their
   * lease — a lane cannot authorize a connection past its own expiry.
   */
  interface LeaseLane {
    tokens: number;
    tokensAt: number;
    highSeq: number;
    ticketSeq: number;
    /** Latest deadline presented for this lease; renewals extend it. */
    expiresAt: number;
  }
  const leaseLanes = new Map<string, LeaseLane>();
  const laneKey = (runtimeTabId: string, leaseId: string): string => `${runtimeTabId}${leaseId}`;
  const leaseLane = (runtimeTabId: string, leaseId: string, expiresAt: number): LeaseLane => {
    const key = laneKey(runtimeTabId, leaseId);
    const existing = leaseLanes.get(key);
    if (existing !== undefined) {
      if (expiresAt > existing.expiresAt) existing.expiresAt = expiresAt;
      return existing;
    }
    const lane: LeaseLane = {
      tokens: BROWSER_FRAME_INPUT_MAX_EVENTS_PER_SECOND,
      tokensAt: Date.now(),
      highSeq: 0,
      ticketSeq: 0,
      expiresAt,
    };
    leaseLanes.set(key, lane);
    sweepExpiredLeaseLanes(leaseLanes, Date.now(), leaseLaneCap);
    return lane;
  };

  /**
   * Geometry key → the css viewport a config read derived it from. The key
   * embeds generation, viewport, and zoom, so the mapping is a pure
   * function: a frame-stamped key the hub has seen confirmed keeps its
   * coordinate space, and an unseen key gets none (input rejects until a
   * config read establishes it).
   */
  const geometryViewports = new Map<string, { width: number; height: number }>();
  const rememberGeometryViewport = (
    key: string,
    viewport: { width: number; height: number },
  ): void => {
    if (geometryViewports.has(key)) geometryViewports.delete(key);
    geometryViewports.set(key, viewport);
    if (geometryViewports.size > GEOMETRY_VIEWPORT_CAP) {
      geometryViewports.delete(geometryViewports.keys().next().value!);
    }
  };

  const sendNotice = (socket: HubInputSocket, notice: unknown): void => {
    if (socket.state === "ended" || socket.state === "closing") return;
    try {
      socket.socket.send(JSON.stringify(notice));
    } catch {
      // A dead socket is handled by its own close path.
    }
  };

  const rejectPacket = (socket: HubInputSocket, seq: number, reason: string): void => {
    socket.rejected += 1;
    sendNotice(socket, { type: "rejected", seq, reason });
  };

  const tryClose = (ws: WebSocket, reason: string): void => {
    try {
      ws.close(INPUT_CLOSE_CODE, reason);
    } catch {
      // already closed
    }
  };

  /**
   * Single-flight terminal transition: the first trigger closes the socket
   * with the named reason and owns the cleanup; later triggers join the same
   * completion. Only the shared completion may mark `ended`, so a successor
   * can never bind before the incumbent's held-input release has settled —
   * or been bounded by the cleanup deadline. Shadow sockets skip the lease
   * release: their packets ran under the owner's lease, whose cleanup is the
   * owner's obligation.
   */
  const endSocket = (
    socket: HubInputSocket,
    reason: string,
  ): Promise<PreviewManager.RemoteInputReleaseResult> => {
    if (socket.endPromise !== null) return socket.endPromise;
    socket.state = "closing";
    tryClose(socket.socket, reason);
    clearTimeout(socket.expiryTimer);
    const cleanup: Promise<PreviewManager.RemoteInputReleaseResult> = socket.owning
      ? runPromise(manager.releaseRemoteInput(socket.runtimeTabId, socket.leaseId))
          .then((result) => result ?? { attempted: 0, failed: 0 })
          .catch(() => ({ attempted: 1, failed: 1 }))
      : Promise.resolve({ attempted: 0, failed: 0 });
    socket.endPromise = Promise.race([
      cleanup,
      new Promise<PreviewManager.RemoteInputReleaseResult>((resolve) => {
        const timer = setTimeout(
          () => resolve({ attempted: 1, failed: 1 }),
          INPUT_CLEANUP_DEADLINE_MS,
        );
        timer.unref();
        cleanup.then(
          () => clearTimeout(timer),
          () => clearTimeout(timer),
        );
      }),
    ]).then((result) => {
      socket.state = "ended";
      const activity = activities.get(socket.runtimeTabId);
      if (activity !== undefined) {
        if (activity.input === socket) activity.input = null;
        activity.shadows.delete(socket);
      }
      if (socket.seqGaps + socket.rejected + socket.dispatchFailures > 0) {
        runFork(
          Effect.logInfo("Browser frame input socket ended with dropped input.", {
            leaseId: socket.leaseId,
            reason,
            seqGaps: socket.seqGaps,
            rejected: socket.rejected,
            dispatchFailures: socket.dispatchFailures,
          }),
        );
      }
      return result;
    });
    return socket.endPromise;
  };

  /**
   * The parked candidate's bind re-runs the upgrade fences: socket still
   * open, its own injected credential deadline still in the future, and the
   * engine-generation pin still matching `remoteFrameConfig`. Pass → `bound`
   * (with `cleanupIncomplete` when the incumbent's release failed or hit the
   * deadline); fail → closed, slot empty.
   *
   * The candidate KEEPS its pending reservation through the whole config
   * read: an upgrade landing mid-read must find and supersede it rather
   * than seeing an empty slot and binding a second owner. Reservation and
   * deadline are revalidated immediately before the synchronous ownership
   * transition, so a superseded or expired candidate never binds.
   */
  const bindPending = (
    runtimeTabId: string,
    cleanup: PreviewManager.RemoteInputReleaseResult | null,
  ): void => {
    const activity = activities.get(runtimeTabId);
    const candidate = activity?.pending ?? null;
    if (activity === undefined || candidate === null) return;
    const drop = (reason: string): void => {
      if (activity.pending === candidate) activity.pending = null;
      clearTimeout(candidate.expiryTimer);
      tryClose(candidate.ws, reason);
    };
    if (
      candidate.cancelled ||
      candidate.ws.readyState !== WebSocket.OPEN ||
      Date.now() >= candidate.expiresAt
    ) {
      drop("expired");
      return;
    }
    void runPromise(manager.remoteFrameConfig(runtimeTabId))
      .then((config) => {
        if (activity.pending !== candidate || candidate.cancelled) return;
        if (candidate.ws.readyState !== WebSocket.OPEN || Date.now() >= candidate.expiresAt) {
          drop("expired");
          return;
        }
        if (
          candidate.engineGeneration !== null &&
          config.engineGeneration !== candidate.engineGeneration
        ) {
          drop("replaced");
          return;
        }
        activity.pending = null;
        clearTimeout(candidate.expiryTimer);
        // A newer same-lease ticket accepted while this candidate awaited
        // its config read demotes this bind to a shadow — it dispatches
        // under the lease but never owns the slot.
        const retainedTicketSeq =
          leaseLanes.get(laneKey(runtimeTabId, candidate.leaseId))?.ticketSeq ?? 0;
        bindInputSocket(
          candidate.ws,
          candidate.asserted,
          candidate.leaseId,
          candidate.ticketSeq,
          candidate.expiresAt,
          config.engineGeneration,
          candidate.ticketSeq >= retainedTicketSeq,
          cleanup !== null && cleanup.failed > 0,
        );
      })
      .catch(() => drop("closing"));
  };

  /**
   * Observe a geometry key (from a frame stamp or a config read) and advance
   * the session's `geometrySeq` when it changed. Ordering matters: on a
   * geometry bump the held-input release runs BEFORE the `geometry` notice
   * is advertised, so no stale up event can strand a key across the bump; on
   * an engine-generation change the input socket ends instead, and the
   * cached seed frame is invalidated — it is the old guest's pixels.
   */
  const observeGeometryKey = (
    runtimeTabId: string,
    key: string,
    configViewport: { readonly width: number; readonly height: number } | null = null,
  ): Promise<number | null> => {
    const activity = activities.get(runtimeTabId);
    if (!activity) return Promise.resolve(null);
    if (activity.geometry !== null && activity.geometry.key === key) {
      // A config read can establish the coordinate space for a key frame
      // stamps introduced earlier — same key, same viewport, no seq bump.
      if (configViewport !== null && activity.geometry.viewportCss === null) {
        activity.geometry = { ...activity.geometry, viewportCss: configViewport };
      }
      return Promise.resolve(activity.geometry.seq);
    }
    const generation = key.slice(0, key.indexOf(":"));
    const priorGeneration =
      activity.geometry !== null
        ? activity.geometry.key.slice(0, activity.geometry.key.indexOf(":"))
        : null;
    const seq = (activity.geometry?.seq ?? -1) + 1;
    activity.geometry = {
      seq,
      key,
      viewportCss: configViewport ?? geometryViewports.get(key) ?? null,
    };
    if (priorGeneration !== null && priorGeneration !== generation) {
      activity.latestFrame = null;
      activity.lastFrame = null;
    }
    const liveSockets = [activity.input, ...activity.shadows].filter(
      (socket): socket is HubInputSocket =>
        socket !== null && (socket.state === "bound" || socket.state === "live"),
    );
    const owning = activity.input;
    if (owning !== null && owning.engineGeneration !== generation) {
      // Guest replacement ends the socket outright — a geometry notice cannot
      // rebase a lease bound to a dead engine generation.
      return endSocket(owning, "replaced").then(() => seq);
    }
    if (liveSockets.length === 0) return Promise.resolve(seq);
    return runPromise(manager.releaseRemoteInputHeld(runtimeTabId))
      .then((result) => {
        if (result.failed > 0) {
          for (const socket of liveSockets) sendNotice(socket, { type: "held-release-failed" });
        }
        for (const socket of liveSockets) {
          sendNotice(socket, { type: "geometry", geometrySeq: seq });
        }
        return seq;
      })
      .catch(() => seq);
  };

  /**
   * Issue a config read that applies only while it is still the newest
   * issued read for the session — a stale completion must not move the
   * advertised geometry or the asserted dispatch viewport backward. The
   * generation check, viewport assertion, and `observeGeometryKey` bump run
   * in the same synchronous stretch so no newer read can interleave
   * mid-apply. Resolves null when superseded; read failures reject.
   */
  const readConfigFenced = (
    runtimeTabId: string,
    activity: SessionActivity,
    engineGeneration: string | null,
  ): Promise<
    | { readonly config: PreviewManager.RemoteFrameConfigInfo; readonly geometrySeq: number | null }
    | "engine-generation-mismatch"
    | null
  > => {
    const readSeq = (activity.configReadSeq += 1);
    return runPromise(manager.remoteFrameConfig(runtimeTabId)).then((config) => {
      if (engineGeneration !== null && config.engineGeneration !== engineGeneration) {
        return "engine-generation-mismatch" as const;
      }
      const current = activities.get(runtimeTabId);
      if (current !== activity || current.configReadSeq !== readSeq) return null;
      // Key and viewport commit atomically: the admitted geometry key always
      // names the coordinate space its input converts against.
      const key = PreviewManager.remoteFrameGeometryKey(
        config.engineGeneration,
        config.viewportCss,
        config.zoomFactor,
      );
      rememberGeometryViewport(key, config.viewportCss);
      return observeGeometryKey(runtimeTabId, key, config.viewportCss).then((geometrySeq) => ({
        config,
        geometrySeq,
      }));
    });
  };

  /**
   * Recompute the session's geometry sequence from authoritative config —
   * the polling path for sessions whose input socket needs geometry without
   * an attached frame stream. Frame stamps drive the same `observeGeometryKey`
   * path so both stay consistent.
   */
  const refreshGeometry = (runtimeTabId: string): Promise<number | null> => {
    const activity = activities.get(runtimeTabId);
    if (activity === undefined) return Promise.resolve(null);
    return readConfigFenced(runtimeTabId, activity, null)
      .then((result) =>
        result === null || result === "engine-generation-mismatch" ? null : result.geometrySeq,
      )
      .catch(() => null);
  };

  // Remote capture start/stop carry a monotonic channel seq: the manager
  // drops a start or stop that lands behind a newer op, so an async stop
  // issued for a disconnected viewer cannot kill a capture a newer viewer
  // already owns.
  let remoteChannelSeq = 0;

  // Geometry changes are infrequent (guest resize, engine swap) but must be
  // fenced promptly: while anything watches or controls a session, its own
  // sweep polls the authoritative geometry once a second. A session nobody
  // watches is reclaimed once it has been idle past ACTIVITY_IDLE_MS — its
  // poller stops with it, so the hub holds no timer for dead sessions.
  const pollActivity = (runtimeTabId: string): void => {
    const activity = activities.get(runtimeTabId);
    if (activity === undefined) return;
    const now = Date.now();
    const inputLive =
      (activity.input !== null && activity.input.state !== "ended") ||
      activity.pending !== null ||
      activity.shadows.size > 0;
    if (activity.viewers > 0 || activity.pendingStarts > 0 || inputLive) {
      activity.lastTouchedAt = now;
      void refreshGeometry(runtimeTabId);
      return;
    }
    if (now - activity.lastTouchedAt > ACTIVITY_IDLE_MS) {
      clearInterval(activity.poller);
      activities.delete(runtimeTabId);
    }
  };

  // One Manager subscription fans frames out to every connected stream. The
  // seq stamped on each part is capture-scoped, so viewers see identical
  // sequences and gaps mean capture-side drops.
  const streamListeners = new Map<string, Set<(frame: PreviewManager.RemoteLiveFrame) => void>>();
  yield* manager.subscribeRemoteFrames((frame) =>
    Effect.sync(() => {
      const activity = activities.get(frame.tabId);
      if (activity) {
        activity.latestFrame = frame;
        activity.lastFrame = { width: frame.width, height: frame.height, seq: frame.seq };
      }
      // Frame geometry stamps drive geometrySeq; the notice (and any held
      // release) is handled inside observeGeometryKey.
      void observeGeometryKey(frame.tabId, frame.geometryKey);
      const listeners = streamListeners.get(frame.tabId);
      if (!listeners) return;
      for (const listener of listeners) {
        try {
          listener(frame);
        } catch {
          // A failing stream is cleaned up by its own close path.
        }
      }
    }),
  );

  const writeFramePart = (
    res: NodeHttp.ServerResponse,
    frame: PreviewManager.RemoteLiveFrame,
    geometrySeq: number,
  ): boolean =>
    res.write(
      Buffer.concat([
        Buffer.from(
          `--${MJPEG_BOUNDARY}\r\n` +
            `Content-Type: image/jpeg\r\n` +
            `Content-Length: ${frame.jpeg.byteLength}\r\n` +
            `X-Frame-Seq: ${frame.seq}\r\n` +
            `X-Engine-Generation: ${frame.engineGeneration}\r\n` +
            `X-Session-Key: ${encodeURIComponent(frame.tabId)}\r\n` +
            `X-Geometry-Seq: ${geometrySeq}\r\n` +
            `X-Frame-Width: ${frame.width}\r\n` +
            `X-Frame-Height: ${frame.height}\r\n\r\n`,
          "utf8",
        ),
        frame.jpeg,
        Buffer.from("\r\n", "utf8"),
      ]),
    );

  const handleStream = (
    req: NodeHttp.IncomingMessage,
    res: NodeHttp.ServerResponse,
    asserted: AssertedSession,
    engineGeneration: string | null,
    expiresAt: number | null,
  ): void => {
    const { runtimeTabId } = asserted;
    const activity = activityFor(runtimeTabId);
    // The generation this stream is bound to — the open-time config value
    // once verified, so a produced frame naming a different generation ends
    // the response instead of emitting replacement-guest pixels.
    let boundGeneration: string | null = null;
    // Frames are stamped with the geometry seq in force when they ARRIVE —
    // never at write time — so a frame drained after a bump keeps the seq its
    // pixels were captured against.
    let headersSent = false;
    let backpressured = false;
    let pending: {
      readonly frame: PreviewManager.RemoteLiveFrame;
      readonly geometrySeq: number;
    } | null = null;
    const geometrySeqFor = (frame: PreviewManager.RemoteLiveFrame): number => {
      const geometry = activities.get(frame.tabId)?.geometry;
      return geometry?.key === frame.geometryKey ? geometry.seq : (geometry?.seq ?? 0);
    };
    const writeStamped = (stamped: {
      readonly frame: PreviewManager.RemoteLiveFrame;
      readonly geometrySeq: number;
    }): boolean => writeFramePart(res, stamped.frame, stamped.geometrySeq);
    const flushPending = (): void => {
      const next = pending;
      pending = null;
      if (next === null) return;
      if (!writeStamped(next)) backpressured = true;
    };
    const listener = (frame: PreviewManager.RemoteLiveFrame): void => {
      if (boundGeneration !== null && frame.engineGeneration !== boundGeneration) {
        res.end();
        return;
      }
      const stamped = { frame, geometrySeq: geometrySeqFor(frame) };
      if (!headersSent || backpressured) {
        pending = stamped;
        return;
      }
      if (!writeStamped(stamped)) backpressured = true;
    };
    // One idempotent teardown for the whole response lifetime, attached
    // BEFORE any async work: `close` and `error` can both fire, and a client
    // that disconnects during startup still owes the viewer decrement and —
    // when it was the last — the capture stop.
    let counted = false;
    let cleanedUp = false;
    let captureStarted = false;
    let expiryTimer: NodeJS.Timeout | null = null;
    const cleanup = (): void => {
      if (cleanedUp) return;
      cleanedUp = true;
      if (expiryTimer !== null) clearTimeout(expiryTimer);
      const listenerSet = streamListeners.get(runtimeTabId);
      if (listenerSet !== undefined) {
        listenerSet.delete(listener);
        // An emptied set must not pin the session's listener entry forever.
        if (listenerSet.size === 0) streamListeners.delete(runtimeTabId);
      }
      pending = null;
      if (!counted) return;
      counted = false;
      activity.viewers = Math.max(0, activity.viewers - 1);
      if (activity.viewers === 0) {
        runFork(manager.stopRemoteCapture(runtimeTabId, ++remoteChannelSeq).pipe(Effect.ignore));
      }
    };
    res.on("close", cleanup);
    res.on("error", cleanup);
    res.on("drain", () => {
      backpressured = false;
      flushPending();
    });

    // Counted BEFORE the first await: the config read below can outlive an
    // idle sweep, and reclaiming the activity mid-startup would orphan this
    // startup onto a detached object.
    activity.pendingStarts += 1;
    void runPromise(
      Effect.gen(function* () {
        const config = yield* manager.remoteFrameConfig(runtimeTabId);
        if (engineGeneration !== null && config.engineGeneration !== engineGeneration) {
          return "engine-generation-mismatch" as const;
        }
        boundGeneration = config.engineGeneration;
        if (res.destroyed || res.closed) return "client-gone" as const;
        // Register the listener and count the viewer BEFORE starting capture:
        // the initial frame must reach this subscriber even when its bytes
        // dedupe against the capture session's lastDeliveredFrame. Frames
        // arriving before headers buffer into `pending` — no part bytes may
        // precede the 200.
        yield* Effect.sync(() => {
          const listeners = streamListeners.get(runtimeTabId) ?? new Set();
          listeners.add(listener);
          streamListeners.set(runtimeTabId, listeners);
          activity.viewers += 1;
          counted = true;
        });
        yield* manager.startRemoteCapture(runtimeTabId, ++remoteChannelSeq);
        captureStarted = true;
        return null;
      }),
    )
      .finally(() => {
        activity.pendingStarts -= 1;
      })
      .then((mismatch) => {
        if (mismatch === "engine-generation-mismatch") {
          writeJson(res, 409, { error: mismatch });
          return;
        }
        if (mismatch !== null || res.destroyed || res.closed || cleanedUp) {
          cleanup();
          if (captureStarted && (activities.get(runtimeTabId)?.viewers ?? 0) === 0) {
            // The disconnect ran stopRemoteCapture while startRemoteCapture
            // was still in flight; the late-resolved start could resurrect
            // the capture — re-stop now that it has settled, but only when
            // no surviving viewer owns it.
            runFork(
              manager.stopRemoteCapture(runtimeTabId, ++remoteChannelSeq).pipe(Effect.ignore),
            );
          }
          return;
        }
        return refreshGeometry(runtimeTabId).then(() => {
          if (res.destroyed || res.closed || cleanedUp) return;
          // Seed the new viewer immediately: unchanged content is deduped
          // capture-side, so without a seed a joiner waits for the next edit.
          // The seed must carry the bound generation — a cached frame from a
          // replaced guest is never served, and a fresh capture that comes
          // back on the wrong generation fails the open with a 409 the client
          // can retry against.
          const seed = async (): Promise<void> => {
            if (pending === null) {
              let frame = activity.latestFrame;
              if (frame !== null && frame.engineGeneration !== boundGeneration) frame = null;
              if (frame === null) {
                const captured = await runPromise(manager.captureFrameJpeg(runtimeTabId)).catch(
                  () => null,
                );
                if (captured !== null) {
                  if (captured.engineGeneration !== boundGeneration) {
                    writeJson(res, 409, { error: "engine-generation-mismatch" });
                    return;
                  }
                  frame = {
                    tabId: runtimeTabId,
                    seq: activities.get(runtimeTabId)?.lastFrame?.seq ?? 0,
                    jpeg: captured.jpeg,
                    width: captured.width,
                    height: captured.height,
                    engineGeneration: captured.engineGeneration,
                    geometryKey: captured.geometryKey,
                  };
                  await observeGeometryKey(runtimeTabId, frame.geometryKey);
                }
              }
              if (res.destroyed || res.closed || cleanedUp) return;
              if (expiresAt !== null) {
                expiryTimer = setTimeout(() => res.end(), Math.max(0, expiresAt - Date.now()));
                expiryTimer.unref();
              }
              res.writeHead(200, {
                "content-type": `multipart/x-mixed-replace; boundary=${MJPEG_BOUNDARY}`,
                "cache-control": "no-store, no-transform",
                "x-accel-buffering": "no",
              });
              headersSent = true;
              if (frame !== null) listener(frame);
              return;
            }
            if (expiresAt !== null) {
              expiryTimer = setTimeout(() => res.end(), Math.max(0, expiresAt - Date.now()));
              expiryTimer.unref();
            }
            res.writeHead(200, {
              "content-type": `multipart/x-mixed-replace; boundary=${MJPEG_BOUNDARY}`,
              "cache-control": "no-store, no-transform",
              "x-accel-buffering": "no",
            });
            headersSent = true;
            flushPending();
          };
          return seed();
        });
      })
      .catch((error: unknown) => {
        writeJson(res, 404, {
          error: "session-not-found",
          message: error instanceof Error ? error.message : "Session is not streamable.",
        });
      });
  };

  const bindInputSocket = (
    ws: WebSocket,
    asserted: AssertedSession,
    leaseId: string,
    ticketSeq: number,
    expiresAt: number,
    engineGeneration: string,
    owning: boolean,
    cleanupIncomplete = false,
  ): void => {
    const { runtimeTabId } = asserted;
    const activity = activityFor(runtimeTabId);
    const socket: HubInputSocket = {
      runtimeTabId,
      leaseId,
      ticketSeq,
      expiresAt,
      engineGeneration,
      socket: ws,
      owning,
      state: "bound",
      lastSeq: 0,
      seqGaps: 0,
      rejected: 0,
      dispatchFailures: 0,
      endPromise: null,
      dispatchTail: Promise.resolve(),
      queuedDispatch: 0,
      expiryTimer: setTimeout(
        () => void endSocket(socket, "expired"),
        Math.max(0, expiresAt - Date.now()),
      ),
    };
    socket.expiryTimer.unref();
    if (owning) {
      activity.input = socket;
    } else {
      activity.shadows.add(socket);
    }

    void refreshGeometry(runtimeTabId).then((geometrySeq) =>
      sendNotice(socket, {
        // A shadow gets no `bound` ownership: it dispatches under the lease
        // but holds no slot and runs no lease cleanup.
        type: owning ? "bound" : "shadow",
        leaseId,
        geometrySeq: geometrySeq ?? activity.geometry?.seq ?? 0,
        expiresAt,
        // The lease's retained replay high-water mark: a client whose socket
        // reconnects under the same lease resumes its seq numbering above
        // this rather than restarting at zero into replay rejections.
        highSeq: leaseLanes.get(laneKey(runtimeTabId, leaseId))?.highSeq ?? 0,
        ...(cleanupIncomplete ? { cleanupIncomplete: true } : {}),
      }),
    );

    ws.on("message", (data: Buffer) => {
      if (socket.state === "ended" || socket.state === "closing") return;
      const now = Date.now();
      if (data.byteLength > BROWSER_FRAME_INPUT_PACKET_MAX_BYTES) {
        rejectPacket(socket, 0, "oversized");
        return;
      }
      let packet: ReturnType<typeof decodePacket>;
      try {
        packet = decodePacket(JSON.parse(data.toString("utf8")));
      } catch {
        rejectPacket(socket, 0, "malformed");
        return;
      }
      if (now >= socket.expiresAt) {
        void endSocket(socket, "expired");
        return;
      }
      // The lane state is retained per lease across socket replacement, so
      // rebinding (or a shadow socket on the same lease) can reset neither
      // the rate bucket nor the replay high-water mark.
      const bucket = leaseLane(runtimeTabId, leaseId, socket.expiresAt);
      if (packet.seq <= bucket.highSeq) {
        rejectPacket(socket, packet.seq, "replay");
        return;
      }
      if (packet.seq > socket.lastSeq + 1 && socket.lastSeq > 0) {
        socket.seqGaps += packet.seq - socket.lastSeq - 1;
      }
      socket.lastSeq = packet.seq;
      bucket.highSeq = packet.seq;
      // No geometry, no input: before the first authoritative geometry
      // (or while a frame-stamped key still lacks a config-confirmed
      // coordinate space) every packet is rejected — the nullable escape
      // hatch does not exist on this path.
      const geometry = activity.geometry;
      if (geometry === null || geometry.viewportCss === null) {
        rejectPacket(socket, packet.seq, "no-geometry");
        return;
      }
      const geometrySeq = geometry.seq;
      if (packet.geometrySeq !== geometrySeq) {
        rejectPacket(socket, packet.seq, "stale-geometry");
        return;
      }
      // Geometry is frozen at admission: the queued packet dispatches with
      // the viewport its coordinates were authored against — the one the
      // admitted key was derived from, never a later config read's. The
      // admitted geometry key rides along so the Manager can re-fence
      // inside the guest lane — the hub's own re-check before enqueueing
      // stops at the lane's edge.
      const admittedViewport = geometry.viewportCss;
      const admittedGeometryKey = geometry.key;
      bucket.tokens = Math.min(
        BROWSER_FRAME_INPUT_MAX_EVENTS_PER_SECOND,
        bucket.tokens +
          ((now - bucket.tokensAt) / 1000) * BROWSER_FRAME_INPUT_MAX_EVENTS_PER_SECOND,
      );
      bucket.tokensAt = now;
      if (bucket.tokens < 1) {
        rejectPacket(socket, packet.seq, "rate-limited");
        return;
      }
      if (socket.queuedDispatch >= INPUT_DISPATCH_QUEUE_MAX) {
        rejectPacket(socket, packet.seq, "backpressured");
        return;
      }
      bucket.tokens -= 1;
      socket.state = "live";
      // Dispatch is serialized per socket: packets enter the guest ledger's
      // lane in arrival order, and the queue is bounded so a stalled lane
      // rejects new packets instead of accumulating unbounded work.
      socket.queuedDispatch += 1;
      socket.dispatchTail = socket.dispatchTail
        .then(() => {
          if (socket.state === "ended" || socket.state === "closing") return undefined;
          // A geometry bump while this packet queued makes its coordinates
          // meaningless — reject rather than actuate against the
          // replacement geometry.
          if (
            activity.geometry === null ||
            activity.geometry.viewportCss === null ||
            activity.geometry.seq !== geometrySeq
          ) {
            rejectPacket(socket, packet.seq, "stale-geometry");
            return undefined;
          }
          return runPromise(
            manager
              .dispatchRemoteInput(
                runtimeTabId,
                leaseId,
                socket.engineGeneration,
                packet.event,
                admittedViewport,
                admittedGeometryKey,
              )
              .pipe(
                Effect.catch((error) =>
                  Effect.logWarning("Remote input dispatch failed.", {
                    leaseId,
                    error,
                  }),
                ),
              ),
          ).catch(() => {
            socket.dispatchFailures += 1;
          });
        })
        .finally(() => {
          socket.queuedDispatch -= 1;
        });
    });
    ws.on("close", () => void endSocket(socket, "closing"));
    ws.on("error", () => void endSocket(socket, "closing"));
  };

  const handleInputUpgrade = (
    req: NodeHttp.IncomingMessage,
    socket: NodeStream.Duplex,
    head: Buffer,
    wss: WebSocketServer,
  ): void => {
    const reject = (): void => {
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
    };
    if (!authorized(req)) {
      reject();
      return;
    }
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const match = SESSION_INPUT_PATH.exec(url.pathname);
    if (!match) {
      socket.destroy();
      return;
    }
    const pathTabId = match[1] ?? "";
    const asserted = parseAssertedSession(url);
    const leaseId = url.searchParams.get("x-t3-lease");
    const expiresAt = Number(url.searchParams.get("x-t3-lease-expires"));
    if (
      !asserted ||
      asserted.tuple.tabId !== decodeURIComponent(pathTabId) ||
      leaseId === null ||
      !Number.isFinite(expiresAt)
    ) {
      reject();
      return;
    }
    const engineGeneration = url.searchParams.get("x-t3-engine-generation");
    const ticketSeqRaw = url.searchParams.get("x-t3-ticket-seq");
    const ticketSeq = ticketSeqRaw === null ? 0 : Number(ticketSeqRaw);
    if (!Number.isFinite(ticketSeq) || ticketSeq < 0) {
      reject();
      return;
    }
    // The lease lane's deadline is stamped at upgrade admission — before the
    // async config read below. A stalled renewal must not leave the lane
    // sweepable under an already-superseded expiry: eviction would reset the
    // retained replay high-water and accepted ticket ordering.
    leaseLane(asserted.runtimeTabId, leaseId, expiresAt);
    wss.handleUpgrade(req, socket, head, (ws) => {
      // Fence before the machine runs: a stale engine generation or dead tab
      // closes the socket with the named reason rather than parking it.
      void runPromise(manager.remoteFrameConfig(asserted.runtimeTabId))
        .then((config) => {
          if (engineGeneration !== null && config.engineGeneration !== engineGeneration) {
            ws.close(INPUT_CLOSE_CODE, "replaced");
            return;
          }
          const activity = activityFor(asserted.runtimeTabId);
          const incumbent =
            activity.input !== null && activity.input.state !== "ended" ? activity.input : null;
          // A same-lease ticket older than the newest the hub has already
          // accepted is a valid credential but may not seize the slot or
          // evict the newer candidate: it binds immediately as a shadow and
          // never runs lease cleanup. The retained per-lease high-water
          // remembers an accepted ticket even after its socket ended — an
          // older upgrade completing late must not inherit the freed slot.
          let newestSameLeaseSeq: number | null =
            leaseLanes.get(laneKey(asserted.runtimeTabId, leaseId))?.ticketSeq ?? null;
          for (const held of [incumbent, activity.pending] as const) {
            if (held !== null && held.leaseId === leaseId) {
              newestSameLeaseSeq =
                newestSameLeaseSeq === null
                  ? held.ticketSeq
                  : Math.max(newestSameLeaseSeq, held.ticketSeq);
            }
          }
          if (newestSameLeaseSeq !== null && ticketSeq < newestSameLeaseSeq) {
            bindInputSocket(
              ws,
              asserted,
              leaseId,
              ticketSeq,
              expiresAt,
              config.engineGeneration,
              false,
            );
            return;
          }
          // Accepted — retain the ticket seq for the lease's lifetime so a
          // later-ending socket cannot erase the ordering this upgrade
          // established.
          const accepted = leaseLane(asserted.runtimeTabId, leaseId, expiresAt);
          accepted.ticketSeq = Math.max(accepted.ticketSeq, ticketSeq);
          // Latest arrival wins the single pending slot: a parked candidate
          // is closed `superseded` when a newer upgrade lands.
          const prior = activity.pending;
          if (prior !== null) {
            prior.cancelled = true;
            clearTimeout(prior.expiryTimer);
            tryClose(prior.ws, "superseded");
          }
          const candidate: PendingCandidate = {
            ws,
            asserted,
            leaseId,
            ticketSeq,
            expiresAt,
            engineGeneration,
            cancelled: false,
            expiryTimer: setTimeout(
              () => {
                if (activity.pending === candidate) activity.pending = null;
                tryClose(ws, "expired");
              },
              Math.max(0, expiresAt - Date.now()),
            ),
          };
          candidate.expiryTimer.unref();
          activity.pending = candidate;
          ws.once("close", () => {
            if (activity.pending === candidate) activity.pending = null;
          });
          if (incumbent !== null) {
            void endSocket(
              incumbent,
              incumbent.leaseId === leaseId ? "replaced" : "superseded",
            ).then((outcome) => bindPending(asserted.runtimeTabId, outcome));
          } else {
            bindPending(asserted.runtimeTabId, null);
          }
        })
        .catch(() => ws.close(INPUT_CLOSE_CODE, "closing"));
    });
  };

  const handleRequest = (req: NodeHttp.IncomingMessage, res: NodeHttp.ServerResponse): void => {
    if (!authorized(req)) {
      writeJson(res, 403, { error: "unauthorized" });
      return;
    }
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const pathname = url.pathname;
    if (req.method !== "GET") {
      writeJson(res, 405, { error: "method-not-allowed" });
      return;
    }

    if (HEALTH_PATH.test(pathname)) {
      writeJson(res, 200, { service: "t3.browser-frame-hub" });
      return;
    }

    if (SESSION_PATH.test(pathname)) {
      void runPromise(manager.remoteFrameSessions())
        .then((sessions) =>
          writeJson(
            res,
            200,
            sessions.map((session) => {
              const activity = activities.get(session.runtimeTabId);
              return {
                environmentId: session.environmentId,
                threadId: session.threadId,
                serverEpoch: session.serverEpoch,
                tabId: session.tabId,
                engineGeneration: session.engineGeneration,
                viewport:
                  session.viewportCss === null
                    ? null
                    : {
                        cssWidth: session.viewportCss.width,
                        cssHeight: session.viewportCss.height,
                      },
                frame: {
                  width: activity?.lastFrame?.width ?? 0,
                  height: activity?.lastFrame?.height ?? 0,
                  fps: FRAME_FPS,
                },
                geometrySeq: activity?.geometry?.seq ?? 0,
                streaming: session.streaming,
              };
            }),
          ),
        )
        .catch(() => writeJson(res, 500, { error: "sessions-unavailable" }));
      return;
    }

    const leaf = SESSION_LEAF_PATH.exec(pathname);
    if (!leaf) {
      writeJson(res, 404, { error: "not-found" });
      return;
    }
    const asserted = parseAssertedSession(url);
    if (!asserted || asserted.tuple.tabId !== decodeURIComponent(leaf[1] ?? "")) {
      writeJson(res, 403, { error: "session-fence-mismatch" });
      return;
    }
    const engineGeneration = url.searchParams.get("x-t3-engine-generation");
    const expiresAtRaw = url.searchParams.get("x-t3-lease-expires");
    const expiresAt = expiresAtRaw === null ? null : Number(expiresAtRaw);

    if (leaf[2] === "stream.mjpeg") {
      handleStream(
        req,
        res,
        asserted,
        engineGeneration,
        Number.isFinite(expiresAt) ? expiresAt : null,
      );
      return;
    }
    if (leaf[2] === "snapshot") {
      void runPromise(manager.captureFrameJpeg(asserted.runtimeTabId))
        .then(async (frame) => {
          if (engineGeneration !== null && frame.engineGeneration !== engineGeneration) {
            writeJson(res, 409, { error: "engine-generation-mismatch" });
            return;
          }
          const geometrySeq = await observeGeometryKey(asserted.runtimeTabId, frame.geometryKey);
          res.writeHead(200, {
            "content-type": "image/jpeg",
            "content-length": frame.jpeg.byteLength,
            "cache-control": "no-store, no-transform",
            "x-engine-generation": frame.engineGeneration,
            "x-geometry-seq": geometrySeq ?? 0,
            "x-frame-width": frame.width,
            "x-frame-height": frame.height,
          });
          res.end(frame.jpeg);
        })
        .catch((error: unknown) =>
          writeJson(res, 404, {
            error: "session-not-found",
            message: error instanceof Error ? error.message : "Session is not capturable.",
          }),
        );
      return;
    }
    // config — the returned (viewport, geometrySeq) pair must describe one
    // geometry, so the read applies only while it is still the newest issued
    // read; a superseded completion retries rather than publishing stale
    // geometry into the session's advertised state.
    void (async () => {
      const activity = activityFor(asserted.runtimeTabId);
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          const result = await readConfigFenced(asserted.runtimeTabId, activity, engineGeneration);
          if (result === null) {
            if (attempt === 2) writeJson(res, 409, { error: "config-superseded" });
            continue;
          }
          if (result === "engine-generation-mismatch") {
            writeJson(res, 409, { error: result });
            return;
          }
          const { config, geometrySeq } = result;
          writeJson(res, 200, {
            ...asserted.tuple,
            engineGeneration: config.engineGeneration,
            viewport: {
              cssWidth: config.viewportCss.width,
              cssHeight: config.viewportCss.height,
            },
            zoomFactor: config.zoomFactor,
            geometrySeq: geometrySeq ?? 0,
          });
          return;
        } catch (error) {
          writeJson(res, 404, {
            error: "session-not-found",
            message: error instanceof Error ? error.message : "Session is not configurable.",
          });
          return;
        }
      }
    })();
  };

  const wss = new WebSocketServer({
    noServer: true,
    // Enforced inside ws before a fragmented message is reassembled — the
    // assembled-byteLength check below is only the backstop.
    maxPayload: BROWSER_FRAME_INPUT_PACKET_MAX_BYTES,
  });
  const server: NodeHttp.Server = NodeHttp.createServer((req, res) => {
    try {
      handleRequest(req, res);
    } catch {
      if (!res.headersSent) writeJson(res, 500, { error: "internal" });
      else res.destroy();
    }
  });
  server.on("upgrade", (req, socket, head) => {
    try {
      handleInputUpgrade(req, socket, head, wss);
    } catch {
      socket.destroy();
    }
  });

  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      for (const activity of activities.values()) {
        clearInterval(activity.poller);
        if (activity.pending !== null) {
          activity.pending.cancelled = true;
          clearTimeout(activity.pending.expiryTimer);
          tryClose(activity.pending.ws, "closing");
        }
        if (activity.input !== null) {
          void endSocket(activity.input, "closing");
        }
        for (const shadow of activity.shadows) {
          void endSocket(shadow, "closing");
        }
      }
      wss.close();
      server.close();
    }),
  );

  yield* Effect.callback<void, BrowserFrameHubError>((resume) => {
    server.once("error", (error) =>
      resume(Effect.fail(new BrowserFrameHubError({ message: error.message }))),
    );
    server.listen(0, "127.0.0.1", () => resume(Effect.void));
  });

  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return BrowserFrameHub.of({ origin: `http://127.0.0.1:${port}`, secret });
}).pipe(Effect.withSpan("BrowserFrameHub.make"));

export const layer = Layer.effect(BrowserFrameHub, make);
