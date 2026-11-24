import type { OrbitGatewayTransport } from "./client.ts";
import {
  createOrbitRealtimeSubscription,
  realtimeObject,
  type OrbitRealtimeSocket,
} from "./realtimeSubscription.ts";

/** Orbit's own clients read a subscribed Operation this often, for an event Reverb lost. */
export const OPERATION_LIVE_REREAD_MS = 15_000;
/** The slow read while the socket is down; each one also tries to subscribe again. */
export const OPERATION_OFFLINE_POLL_MS = 10_000;

/**
 * The `operation.updated` notices of one Operation over the Gateway's Reverb
 * (`private-operation.{id}`). The HTTP read stays the truth: a notice only says when to read.
 */
export interface OrbitOperationNotices {
  /**
   * Resolves at a notice newer than `afterSequence` (null takes any), at each (re)subscribe, or
   * at `stop`. A notice that came since the last call counts.
   */
  readonly next: (afterSequence: number | null) => Promise<void>;
  /** Drops the wait of `next` that ended another way, so a later notice stays for the next call. */
  readonly abandonWait: () => void;
  readonly live: () => boolean;
  /** Tries to subscribe again when the socket is down. */
  readonly reconnect: () => void;
  readonly stop: () => void;
}

export function noticeSequence(data: unknown): number | null {
  const envelope = realtimeObject(data);
  const sequence = realtimeObject(envelope?.data)?.sequence ?? envelope?.sequence;
  return typeof sequence === "number" && Number.isFinite(sequence) ? sequence : null;
}

export function followOrbitOperationNotices(input: {
  transport: OrbitGatewayTransport;
  operationId: number;
  socket?: (url: string) => OrbitRealtimeSocket;
}): OrbitOperationNotices {
  let stopped = false;
  let live = false;
  /** Unconsumed: a resubscribe (null) or the newest event sequence. */
  let pending: { sequence: number | null } | null = null;
  let waiter: { after: number | null; wake: () => void } | null = null;

  const notify = (sequence: number | null) => {
    // A resubscribe asks for a read whatever the caller has read: no sequence may replace it.
    pending =
      pending?.sequence === null || sequence === null
        ? { sequence: null }
        : { sequence: pending === null ? sequence : Math.max(pending.sequence, sequence) };
    if (waiter !== null && isNewer(pending.sequence, waiter.after)) {
      pending = null;
      const { wake } = waiter;
      waiter = null;
      wake();
    }
  };
  const subscription = createOrbitRealtimeSubscription({
    transport: input.transport,
    discoveryPath: "/realtime",
    authPath: "/broadcasting/auth",
    root: true,
    channel: `private-operation.${input.operationId}`,
    onStatus: (status) => {
      const wasLive = live;
      live = status === "live";
      // Notices sent before the subscribe went nowhere: read once now, as on a reconnect. A lost
      // socket also ends the wait, so the next one reads and subscribes again without delay.
      if (live || wasLive) notify(null);
    },
    onEvent: (event, data) => {
      if (event === "operation.updated") notify(noticeSequence(data));
    },
    ...(input.socket ? { socket: input.socket } : {}),
  });
  void subscription.connect();

  return {
    next: (afterSequence) => {
      if (stopped) return Promise.resolve();
      const ready = pending !== null && isNewer(pending.sequence, afterSequence);
      pending = null;
      if (ready) return Promise.resolve();
      return new Promise<void>((resolve) => {
        waiter = { after: afterSequence, wake: resolve };
      });
    },
    abandonWait: () => {
      waiter = null;
    },
    live: () => live,
    reconnect: () => {
      if (!stopped && !live) void subscription.connect();
    },
    stop: () => {
      stopped = true;
      subscription.stop();
      const current = waiter;
      waiter = null;
      current?.wake();
    },
  };
}

/**
 * The wait before the next read of an Operation. With notices: the next one, or the slow
 * fallback read (15 s live, 10 s while the socket is down; such a wait first resubscribes). Without:
 * the caller's poll wait. Never longer than `maxMs`.
 */
export async function waitForOperationRead(input: {
  readonly notices: OrbitOperationNotices | null;
  readonly sequence: number | null;
  readonly pollMs: number;
  readonly maxMs: number;
  readonly sleep: (ms: number) => Promise<void>;
}): Promise<void> {
  const maxMs = Math.max(input.maxMs, 0);
  const notices = input.notices;
  if (notices === null) return input.sleep(Math.min(input.pollMs, maxMs));
  const live = notices.live();
  if (!live) notices.reconnect();
  const fallback = live ? OPERATION_LIVE_REREAD_MS : OPERATION_OFFLINE_POLL_MS;
  let noticed = false;
  await Promise.race([
    notices.next(input.sequence).then(() => {
      noticed = true;
    }),
    input.sleep(Math.min(fallback, maxMs)).then(() => {
      // A sleep that ends after a notice belongs to a wait that is over.
      if (noticed) return;
      notices.abandonWait();
    }),
  ]);
}

function isNewer(sequence: number | null, after: number | null): boolean {
  return sequence === null || after === null || sequence > after;
}
