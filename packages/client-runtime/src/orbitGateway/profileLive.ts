// @effect-diagnostics globalTimers:off -- The subscription owns its check and retry timers, covered with fake-time tests.
/**
 * Follows the active Orbit profile: one private Reverb subscription for the channel `/me` names.
 * A notice only starts a read through the reconciler; HTTP stays the authority. Reads also run
 * when a subscription goes live, on `reconcile()`, and every `ORBIT_PROFILE_CHECK_MS`.
 */
import * as Schema from "effect/Schema";

import { OrbitGatewayError, type OrbitGatewayTransport } from "./client.ts";
import {
  createProfileReconciler,
  type ProfileBinding,
  type ProfileChangeNotice,
} from "./profileReconcile.ts";
import {
  createOrbitRealtimeSubscription,
  realtimeObject,
  type OrbitRealtimeSocket,
} from "./realtimeSubscription.ts";

const CONN_PROFILE_EVENT = "conn.profile.updated";
/**
 * The low-frequency version check against dropped broadcasts. Each check reads `/me`, which also
 * renews the channel key well before its 15-minute end (the Gateway renews keys older than 5).
 */
export const ORBIT_PROFILE_CHECK_MS = 2 * 60_000;
const RETRY_MIN_MS = 5_000;
const RETRY_MAX_MS = 5 * 60_000;

/** A notice from the event payload `{profile_id, version}`, or null for anything else. */
export function orbitProfileNotice(event: string, data: unknown): ProfileChangeNotice | null {
  if (event !== CONN_PROFILE_EVENT) return null;
  const payload = realtimeObject(data);
  const profileId = payload?.profile_id;
  const version = payload?.version;
  return typeof profileId === "number" && typeof version === "number"
    ? { profileId, version }
    : null;
}

export interface OrbitProfileLivePorts {
  readonly transport: OrbitGatewayTransport;
  /** The local scope (for example the provider), or null while profile sync is off. */
  readonly scope: () => string | null;
  /**
   * The existing authoritative refresh. Resolves to the binding it applied. Calls `observe` with
   * the channel as soon as `/me` answers, so a rotation is followed even when a later step fails.
   * Must not apply anything once `isCurrent()` is false.
   */
  readonly refresh: (
    isCurrent: () => boolean,
    observe: (channel: string | null) => void,
  ) => Promise<ProfileBinding | null>;
  readonly onError?: (error: unknown) => void;
  readonly socket?: (url: string) => OrbitRealtimeSocket;
  readonly checkIntervalMs?: number;
}

interface Followed {
  readonly channel: string;
  readonly scope: string;
  readonly stop: () => void;
}

const isOrbitGatewayError = Schema.is(OrbitGatewayError);

/** A Gateway answer that means this device may no longer read the profile (or Conn is off). */
function accessWithdrawn(error: unknown): boolean {
  return (
    isOrbitGatewayError(error) &&
    (error.status === 401 ||
      error.status === 403 ||
      error.status === 404 ||
      error.code === "extension.disabled")
  );
}

export function createOrbitProfileLive(ports: OrbitProfileLivePorts) {
  const checkMs = ports.checkIntervalMs ?? ORBIT_PROFILE_CHECK_MS;
  let active = false;
  let disposed = false;
  let lastScope: string | null = null;
  let followed: Followed | null = null;
  let checkTimer: ReturnType<typeof setTimeout> | undefined;
  let readRetry: ReturnType<typeof setTimeout> | undefined;
  let socketRetry: ReturnType<typeof setTimeout> | undefined;
  let readRetryMs = RETRY_MIN_MS;
  let socketRetryMs = RETRY_MIN_MS;

  const scope = (): string | null => (active && !disposed ? ports.scope() : null);

  const unfollow = (): void => {
    const previous = followed;
    followed = null;
    previous?.stop();
  };

  /** Subscribes to `channel` in the current scope, replacing any other subscription. */
  const follow = (channel: string | null): void => {
    const current = scope();
    if (channel === null || current === null) {
      unfollow();
      // The contract re-reads discovery at each compare also while unbound; nothing subscribes.
      if (channel === null && current !== null) {
        void ports
          .transport({ method: "GET", path: "/realtime", timeoutMs: 10_000 })
          .catch(() => {});
      }
      return;
    }
    if (followed?.channel === channel && followed.scope === current) return;
    unfollow();
    let entry: Followed | null = null;
    const subscription = createOrbitRealtimeSubscription({
      transport: ports.transport,
      discoveryPath: "/realtime",
      authPath: "/broadcasting/auth",
      channel,
      onStatus: (status) => {
        if (followed !== entry) return;
        if (status === "live") {
          socketRetryMs = RETRY_MIN_MS;
          // Notices sent between the last read and the subscribe went nowhere: read once now.
          void reconciler.reconcile();
          return;
        }
        // Dropped, refused or no Reverb: read again later, which subscribes again.
        unfollow();
        clearTimeout(socketRetry);
        socketRetry = setTimeout(() => {
          socketRetry = undefined;
          void reconcile();
        }, socketRetryMs);
        socketRetryMs = Math.min(socketRetryMs * 2, RETRY_MAX_MS);
      },
      onEvent: (event, data) => {
        // Only the current subscription in its own scope reaches the reconciler.
        if (followed !== entry || scope() !== current) return;
        const notice = orbitProfileNotice(event, data);
        if (notice) void reconciler.notify(notice);
      },
      ...(ports.socket ? { socket: ports.socket } : {}),
    });
    entry = { channel, scope: current, stop: subscription.stop };
    followed = entry;
    void subscription.connect();
  };

  const reconciler = createProfileReconciler({
    scope,
    refresh: async (isCurrent) => {
      let binding: ProfileBinding | null;
      let observed = false;
      const observe = (channel: string | null): void => {
        if (!isCurrent()) return;
        observed = true;
        follow(channel);
      };
      try {
        binding = await ports.refresh(isCurrent, observe);
      } catch (error) {
        if (isCurrent() && accessWithdrawn(error)) unfollow();
        throw error;
      }
      if (isCurrent()) {
        readRetryMs = RETRY_MIN_MS;
        clearTimeout(readRetry);
        readRetry = undefined;
        // The adapter already followed what this read's `/me` named.
        if (!observed) follow(binding?.channel ?? null);
      }
      return binding;
    },
    onError: (error) => {
      ports.onError?.(error);
      if (readRetry !== undefined || scope() === null) return;
      readRetry = setTimeout(() => {
        readRetry = undefined;
        void reconcile();
      }, readRetryMs);
      readRetryMs = Math.min(readRetryMs * 2, RETRY_MAX_MS);
    },
  });

  /** Drops the subscription and in-flight reads when the scope changed since the last look. */
  /** A new binding or scope starts its own retry sequence. */
  const resetRetries = (): void => {
    clearTimeout(readRetry);
    clearTimeout(socketRetry);
    readRetry = socketRetry = undefined;
    readRetryMs = socketRetryMs = RETRY_MIN_MS;
  };

  const checkScope = (): string | null => {
    const current = scope();
    if (current !== lastScope) {
      lastScope = current;
      reconciler.invalidate();
      unfollow();
      resetRetries();
    }
    return current;
  };

  function reconcile(): Promise<void> {
    if (checkScope() === null) return Promise.resolve();
    return reconciler.reconcile();
  }

  const scheduleCheck = (): void => {
    clearTimeout(checkTimer);
    checkTimer = setTimeout(() => {
      checkTimer = undefined;
      if (!active || disposed) return;
      void reconcile();
      scheduleCheck();
    }, checkMs);
  };

  const halt = (): void => {
    clearTimeout(checkTimer);
    checkTimer = undefined;
    resetRetries();
    checkScope();
  };

  return {
    /** Starts following (app in front, window open) and reads at once. */
    resume(): Promise<void> {
      if (disposed) return Promise.resolve();
      active = true;
      scheduleCheck();
      return reconcile();
    },
    /** Stops the socket and the timers (app in the background); in-flight reads become obsolete. */
    pause(): void {
      active = false;
      halt();
    },
    /** One authoritative read: foreground, focus, network back, a local scope change. */
    reconcile,
    /**
     * Before this device rebinds its profile: the old channel and any read in flight must not
     * apply to the new binding. The next read subscribes to the channel `/me` names then.
     */
    invalidate(): void {
      reconciler.invalidate();
      unfollow();
      resetRetries();
    },
    /** The channel followed now, for diagnostics and tests. */
    channel(): string | null {
      return followed?.channel ?? null;
    },
    dispose(): void {
      disposed = true;
      active = false;
      halt();
      reconciler.dispose();
    },
  };
}

export type OrbitProfileLive = ReturnType<typeof createOrbitProfileLive>;
