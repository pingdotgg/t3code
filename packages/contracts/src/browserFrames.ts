/**
 * Wire types for `t3.browser/frames@1.0.0` — remote pixel transport for
 * collaborative browser sessions.
 *
 * The frame channel carries JPEG frames plus a validated human-input
 * backchannel. Actions never ride this contract: automation stays on
 * `t3.browser/sessions` and no raw CDP surface is exposed through it.
 */
import * as Schema from "effect/Schema";

import {
  EnvironmentId,
  NonNegativeInt,
  PositiveInt,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { PreviewTabId } from "./preview.ts";

/** The authenticated server-side proxy route root; the hub lives behind it. */
export const BROWSER_FRAMES_ROUTE_PREFIX = "/api/browser-frames";

export const BROWSER_FRAME_TICKET_TTL_MS = 5 * 60 * 1000;
export const BROWSER_FRAME_INPUT_PACKET_MAX_BYTES = 8 * 1024;
/** Per-lease sustained input rate; bursts above are rejected as `rate-limited`. */
export const BROWSER_FRAME_INPUT_MAX_EVENTS_PER_SECOND = 60;

/**
 * Full fencing identity for a browser session: the runtime tab id the engine
 * host knows is the JSON serialization of this tuple. `serverEpoch` and
 * `engineGeneration` fence frames and input against stale or replaced engines.
 */
export const BrowserFrameSessionTuple = Schema.Struct({
  environmentId: EnvironmentId,
  threadId: ThreadId,
  serverEpoch: TrimmedNonEmptyString,
  tabId: PreviewTabId,
});
export type BrowserFrameSessionTuple = typeof BrowserFrameSessionTuple.Type;

/** Engine generation is the host's webContents identity, serialized. */
export const BrowserFrameEngineGeneration = TrimmedNonEmptyString.check(Schema.isMaxLength(64));
export type BrowserFrameEngineGeneration = typeof BrowserFrameEngineGeneration.Type;

export const BrowserFrameInputModifier = Schema.Literals(["Alt", "Control", "Meta", "Shift"]);
export type BrowserFrameInputModifier = typeof BrowserFrameInputModifier.Type;

const UnitInterval = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)).check(
  Schema.isLessThanOrEqualTo(1),
);
const CssLength = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(-100_000)).check(
  Schema.isLessThanOrEqualTo(100_000),
);

/**
 * Client-originated input. Coordinates are normalized to the painted frame
 * (0..1); the engine maps them onto its current CSS viewport. `text` carries
 * committed text only — IME composition is explicitly out of scope for V1.
 */
export const BrowserFrameInputEvent = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("pointer"),
    phase: Schema.Literals(["move", "down", "up"]),
    x: UnitInterval,
    y: UnitInterval,
    button: Schema.optional(Schema.Literals(["left", "middle", "right"])),
  }),
  Schema.Struct({
    type: Schema.Literal("wheel"),
    deltaX: CssLength,
    deltaY: CssLength,
    x: UnitInterval,
    y: UnitInterval,
  }),
  Schema.Struct({
    type: Schema.Literal("key"),
    phase: Schema.Literals(["down", "up"]),
    key: Schema.String.check(Schema.isMaxLength(64)),
    code: Schema.String.check(Schema.isMaxLength(64)),
    text: Schema.optional(Schema.String.check(Schema.isMaxLength(64))),
    modifiers: Schema.optional(Schema.Array(BrowserFrameInputModifier)),
  }),
  Schema.Struct({
    type: Schema.Literal("text"),
    text: Schema.String.check(Schema.isMaxLength(4_000)),
  }),
]);
export type BrowserFrameInputEvent = typeof BrowserFrameInputEvent.Type;

/**
 * Client→hub input packet. `seq` is monotonic per lease (replay rejected),
 * `geometrySeq` must equal the geometry the input was authored against.
 */
export const BrowserFrameInputPacket = Schema.Struct({
  seq: PositiveInt,
  geometrySeq: NonNegativeInt,
  event: BrowserFrameInputEvent,
});
export type BrowserFrameInputPacket = typeof BrowserFrameInputPacket.Type;

export const BrowserFrameInputRejectReason = Schema.Literals([
  "stale-geometry",
  "expired",
  "rate-limited",
  "backpressured",
  "oversized",
  "replay",
  "closing",
  "malformed",
]);
export type BrowserFrameInputRejectReason = typeof BrowserFrameInputRejectReason.Type;

/** Lease close reasons shared by the hub and its clients. */
export const BrowserFrameInputCloseReason = Schema.Literals([
  "expired",
  "superseded",
  "replaced",
  "revoked",
  "closing",
]);
export type BrowserFrameInputCloseReason = typeof BrowserFrameInputCloseReason.Type;

/** Hub→client messages on the input socket. */
export const BrowserFrameInputNotice = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("bound"),
    leaseId: TrimmedNonEmptyString,
    geometrySeq: NonNegativeInt,
    expiresAt: Schema.Int.check(Schema.isGreaterThan(0)),
    /**
     * The lease's retained replay high-water mark at bind time. A client
     * whose socket reconnects under the same lease resumes its packet seq
     * numbering above this value — the hub's per-lease `highSeq` survives
     * socket replacement, so restarting at zero reads as replay.
     */
    highSeq: Schema.optional(NonNegativeInt),
    /**
     * Set when the superseded socket's held-input cleanup could not fully
     * settle before this bind — the guest may still carry released-state the
     * ledger could not confirm, so the caller can surface cleanup-incomplete.
     */
    cleanupIncomplete: Schema.optional(Schema.Boolean),
  }),
  /**
   * A same-lease socket bound under a ticket older than the newest accepted:
   * it may dispatch under the lease but owns nothing — no `bound` ownership
   * notice, no slot, no lease cleanup.
   */
  Schema.Struct({
    type: Schema.Literal("shadow"),
    leaseId: TrimmedNonEmptyString,
    geometrySeq: NonNegativeInt,
    expiresAt: Schema.Int.check(Schema.isGreaterThan(0)),
  }),
  Schema.Struct({
    type: Schema.Literal("geometry"),
    geometrySeq: NonNegativeInt,
  }),
  Schema.Struct({
    type: Schema.Literal("rejected"),
    seq: PositiveInt,
    reason: BrowserFrameInputRejectReason,
  }),
  /**
   * A geometry-bump held release failed while this socket stayed live — held
   * keys/buttons may still be physically down in the guest; the client may
   * re-press at the new geometry.
   */
  Schema.Struct({ type: Schema.Literal("held-release-failed") }),
]);
export type BrowserFrameInputNotice = typeof BrowserFrameInputNotice.Type;

/** Per-session entry served by `GET /api/browser-frames/sessions`. */
export const BrowserFrameSessionInfo = Schema.Struct({
  ...BrowserFrameSessionTuple.fields,
  engineGeneration: BrowserFrameEngineGeneration,
  viewport: Schema.NullOr(
    Schema.Struct({
      cssWidth: Schema.Int.check(Schema.isGreaterThan(0)),
      cssHeight: Schema.Int.check(Schema.isGreaterThan(0)),
    }),
  ),
  frame: Schema.Struct({
    width: NonNegativeInt,
    height: NonNegativeInt,
    fps: PositiveInt,
  }),
  geometrySeq: NonNegativeInt,
  streaming: Schema.Boolean,
});
export type BrowserFrameSessionInfo = typeof BrowserFrameSessionInfo.Type;

/** Result of `GET /sessions/<tabId>/config` (hub) and `/api/browser-frames/.../config`. */
export const BrowserFrameConfig = Schema.Struct({
  ...BrowserFrameSessionTuple.fields,
  engineGeneration: BrowserFrameEngineGeneration,
  viewport: Schema.Struct({
    cssWidth: Schema.Int.check(Schema.isGreaterThan(0)),
    cssHeight: Schema.Int.check(Schema.isGreaterThan(0)),
  }),
  zoomFactor: Schema.Number.check(Schema.isGreaterThan(0)),
  geometrySeq: NonNegativeInt,
});
export type BrowserFrameConfig = typeof BrowserFrameConfig.Type;

// ---------------------------------------------------------------------------
// WS-RPC payloads (app-client lease minting; plugin viewers use the contract)
// ---------------------------------------------------------------------------

export const BrowserFramesOpenInput = Schema.Struct({
  environmentId: EnvironmentId,
  threadId: ThreadId,
  serverEpoch: TrimmedNonEmptyString,
  tabId: PreviewTabId,
  engineGeneration: Schema.optional(BrowserFrameEngineGeneration),
});
export type BrowserFramesOpenInput = typeof BrowserFramesOpenInput.Type;

export const BrowserFramesOpenInputResult = Schema.Struct({
  leaseId: TrimmedNonEmptyString,
  inputTicket: TrimmedNonEmptyString,
  expiresAt: Schema.Int.check(Schema.isGreaterThan(0)),
});
export type BrowserFramesOpenInputResult = typeof BrowserFramesOpenInputResult.Type;

export const BrowserFramesCloseInput = Schema.Struct({
  environmentId: EnvironmentId,
  leaseId: TrimmedNonEmptyString,
});
export type BrowserFramesCloseInput = typeof BrowserFramesCloseInput.Type;

export class BrowserFramesError extends Schema.TaggedError<BrowserFramesError>()(
  "BrowserFramesError",
  {
    reason: Schema.Literals([
      "session-not-found",
      "engine-unavailable",
      "lease-not-found",
      "unauthorized",
    ]),
    message: Schema.String,
  },
) {}
