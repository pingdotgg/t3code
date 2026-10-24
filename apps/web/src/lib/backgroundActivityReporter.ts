import { EnvironmentRegistry } from "@t3tools/client-runtime/connection";
import {
  EnvironmentRpcSubscriptionObserver,
  request,
  type EnvironmentRpcSubscriptionObservation,
} from "@t3tools/client-runtime/rpc";
import {
  type BackgroundScope,
  type ClientActivityReportInput,
  type EnvironmentId,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import { randomUUID } from "./utils";

const CLIENT_ID_STORAGE_KEY = "t3.backgroundActivity.clientId";
const REPORT_INTERVAL_MS = 25_000;
const LEASE_TTL_MS = 45_000;
const RECENT_INTERACTION_WINDOW_MS = LEASE_TTL_MS;
const BASELINE_SCOPES: ReadonlyArray<BackgroundScope> = [{ type: "provider-status" }];

interface RetainedScope {
  readonly environmentId: EnvironmentId;
  readonly scope: BackgroundScope;
  refCount: number;
}

const retainedScopes = new Map<string, RetainedScope>();
const retainedScopeListeners = new Set<() => void>();

function notifyRetainedScopesChanged(): void {
  for (const listener of retainedScopeListeners) {
    try {
      listener();
    } catch {}
  }
}

function stableScopeKey(environmentId: EnvironmentId, scope: BackgroundScope): string {
  switch (scope.type) {
    case "server-config":
    case "diagnostics":
      return JSON.stringify([environmentId, scope.type]);
    case "provider-status":
      return JSON.stringify([environmentId, scope.type, scope.instanceId ?? null]);
    case "vcs-status":
    case "git-refs":
      return JSON.stringify([environmentId, scope.type, scope.cwd]);
    case "thread":
      return JSON.stringify([environmentId, scope.type, scope.threadId]);
  }
}

function getClientId(): string {
  try {
    const existing = window.localStorage.getItem(CLIENT_ID_STORAGE_KEY);
    if (existing) return existing;
    const next = randomUUID();
    window.localStorage.setItem(CLIENT_ID_STORAGE_KEY, next);
    return next;
  } catch {
    return "ephemeral-browser-client";
  }
}

function resolveClientKind(): ClientActivityReportInput["clientKind"] {
  return window.desktopBridge ? "desktop-renderer" : "web";
}

function wasRecentlyInteracted(lastInteractionAtMs: number, observedAtMs: number): boolean {
  return (
    lastInteractionAtMs <= observedAtMs &&
    observedAtMs - lastInteractionAtMs <= RECENT_INTERACTION_WINDOW_MS
  );
}

// Registered by the mounted notification coordinator.
let canNotifyOutsideWindow = () => false;

export function registerCanNotifyOutsideWindow(check: () => boolean): () => void {
  canNotifyOutsideWindow = check;
  return () => {
    if (canNotifyOutsideWindow === check) canNotifyOutsideWindow = () => false;
  };
}

// Presence silences the phone, so it only counts from a client that can alert
// the person itself: a focused window, or one able to alert outside it.
export function resolveUserIdleMs(input: {
  readonly visible: boolean;
  readonly focused: boolean;
  readonly canNotify: boolean;
  /** `undefined` without a working desktop idle clock, `null` while the computer is locked or asleep. */
  readonly systemIdleMs: number | null | undefined;
  /** `undefined` until this page has seen input. */
  readonly pageIdleMs: number | undefined;
}): number | undefined {
  const reachable = (input.visible && input.focused) || input.canNotify;
  if (!reachable || input.systemIdleMs === null) return undefined;
  const idleMs = input.systemIdleMs ?? input.pageIdleMs;
  return idleMs === undefined ? undefined : Math.max(0, idleMs);
}

const readSystemIdleMs = Effect.tryPromise(async () =>
  window.desktopBridge?.getUserIdleMs?.(),
).pipe(Effect.orElseSucceed(() => undefined));

function createActivityReport(
  environmentId: EnvironmentId,
  lastInteractionAtMs: number,
  observedAtMs: number,
  presence: {
    readonly visible: boolean;
    readonly focused: boolean;
    readonly userIdleMs: number | undefined;
  },
): ClientActivityReportInput {
  const scopes = [...BASELINE_SCOPES];
  for (const entry of retainedScopes.values()) {
    if (entry.environmentId === environmentId) {
      scopes.push(entry.scope);
    }
  }
  return {
    environmentId,
    clientId: getClientId(),
    clientKind: resolveClientKind(),
    visible: presence.visible,
    focused: presence.focused,
    recentlyInteracted: wasRecentlyInteracted(lastInteractionAtMs, observedAtMs),
    ...(presence.userIdleMs !== undefined ? { userIdleMs: presence.userIdleMs } : {}),
    appState: presence.visible ? "active" : "background",
    scopes,
    ttlMs: LEASE_TTL_MS,
    observedAt: DateTime.makeUnsafe(observedAtMs),
  };
}

function scopeForSubscription(
  observation: EnvironmentRpcSubscriptionObservation,
): BackgroundScope | null {
  if (observation.method === WS_METHODS.subscribeResourceTelemetry) {
    return { type: "diagnostics" };
  }
  if (observation.method !== WS_METHODS.subscribeVcsStatus) {
    return null;
  }
  const input = observation.input as { readonly cwd?: unknown; readonly includeRemote?: unknown };
  if (input.includeRemote === false) return null;
  return typeof input.cwd === "string" ? { type: "vcs-status", cwd: input.cwd } : null;
}

function retainBackgroundScope(environmentId: EnvironmentId, scope: BackgroundScope): () => void {
  const key = stableScopeKey(environmentId, scope);
  const existing = retainedScopes.get(key);
  if (existing) {
    existing.refCount += 1;
  } else {
    retainedScopes.set(key, { environmentId, scope, refCount: 1 });
    notifyRetainedScopesChanged();
  }

  return () => {
    const current = retainedScopes.get(key);
    if (!current) return;
    current.refCount -= 1;
    if (current.refCount <= 0) {
      retainedScopes.delete(key);
      notifyRetainedScopesChanged();
    }
  };
}

export function observeBackgroundActivitySubscription(
  observation: EnvironmentRpcSubscriptionObservation,
): Effect.Effect<Effect.Effect<void>> {
  const scope = scopeForSubscription(observation);
  if (scope === null) {
    return Effect.succeed(Effect.void);
  }
  return Effect.sync(() => {
    const release = retainBackgroundScope(observation.environmentId as EnvironmentId, scope);
    return Effect.sync(release);
  });
}

export function retainedBackgroundScopes(
  environmentId: EnvironmentId,
): ReadonlyArray<BackgroundScope> {
  return Array.from(retainedScopes.values(), (entry) =>
    entry.environmentId === environmentId ? entry.scope : null,
  ).filter((scope): scope is BackgroundScope => scope !== null);
}

export const layerObserver = Layer.succeed(
  EnvironmentRpcSubscriptionObserver,
  EnvironmentRpcSubscriptionObserver.of({
    observe: observeBackgroundActivitySubscription,
  }),
);

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    if (typeof window === "undefined" || typeof document === "undefined") {
      return;
    }

    const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
    const clock = yield* Clock.Clock;
    const reportRequests = yield* Queue.sliding<void>(1);
    const requestReport = () => Queue.offerUnsafe(reportRequests, undefined);
    let lastInteractionAtMs = clock.currentTimeMillisUnsafe();
    // Loading or restoring a tab is not input: presence waits for a real event.
    let lastInputAtMs: number | null = null;
    const recordInteraction = () => {
      const observedAtMs = clock.currentTimeMillisUnsafe();
      const wasRecent = wasRecentlyInteracted(lastInteractionAtMs, observedAtMs);
      lastInteractionAtMs = observedAtMs;
      lastInputAtMs = observedAtMs;
      if (!wasRecent) {
        requestReport();
      }
    };
    // Chromium fires motionless pointermoves when layout shifts under a resting
    // cursor, as on load or tab restore; only real movement is input.
    const recordPointerMove = (event: PointerEvent) => {
      if (event.movementX !== 0 || event.movementY !== 0) recordInteraction();
    };
    const passiveListenerOptions = { passive: true } as const;

    const report = Effect.gen(function* () {
      const observedAtMs = yield* Clock.currentTimeMillis;
      const visible = document.visibilityState === "visible";
      const focused = document.hasFocus();
      const userIdleMs = resolveUserIdleMs({
        visible,
        focused,
        canNotify: canNotifyOutsideWindow(),
        systemIdleMs: yield* readSystemIdleMs,
        pageIdleMs: lastInputAtMs === null ? undefined : observedAtMs - lastInputAtMs,
      });
      const entries = yield* SubscriptionRef.get(registry.entries);
      yield* Effect.forEach(
        entries.keys(),
        (environmentId) =>
          registry
            .run(
              environmentId,
              request(
                WS_METHODS.serverReportClientActivity,
                createActivityReport(environmentId, lastInteractionAtMs, observedAtMs, {
                  visible,
                  focused,
                  userIdleMs,
                }),
              ),
            )
            // Not `ignore`: tearing down an environment mid-request interrupts its report,
            // and an interrupt leaking out here would end the reporting loop for good.
            .pipe(Effect.ignoreCause),
        { concurrency: "unbounded", discard: true },
      );
    }).pipe(Effect.withSpan("web.backgroundActivity.report"));

    yield* Effect.acquireRelease(
      Effect.sync(() => window.desktopBridge?.onUserAwayChange?.(requestReport)),
      (unsubscribe) => Effect.sync(() => unsubscribe?.()),
    );
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        retainedScopeListeners.add(requestReport);
        document.addEventListener("visibilitychange", requestReport);
        window.addEventListener("focus", requestReport);
        window.addEventListener("blur", requestReport);
        window.addEventListener("online", requestReport);
        window.addEventListener("pointermove", recordPointerMove);
        window.addEventListener("keydown", recordInteraction);
        window.addEventListener("wheel", recordInteraction, passiveListenerOptions);
        window.addEventListener("touchstart", recordInteraction, passiveListenerOptions);
      }),
      () =>
        Effect.sync(() => {
          retainedScopeListeners.delete(requestReport);
          document.removeEventListener("visibilitychange", requestReport);
          window.removeEventListener("focus", requestReport);
          window.removeEventListener("blur", requestReport);
          window.removeEventListener("online", requestReport);
          window.removeEventListener("pointermove", recordPointerMove);
          window.removeEventListener("keydown", recordInteraction);
          window.removeEventListener("wheel", recordInteraction);
          window.removeEventListener("touchstart", recordInteraction);
        }),
    );

    yield* SubscriptionRef.changes(registry.entries).pipe(
      Stream.runForEach(() => Effect.sync(requestReport)),
      Effect.forkScoped,
    );
    yield* Stream.fromQueue(reportRequests).pipe(
      Stream.debounce("250 millis"),
      Stream.runForEach(() => report),
      Effect.forkScoped,
    );
    yield* Effect.sync(requestReport).pipe(
      Effect.repeat(Schedule.spaced(`${REPORT_INTERVAL_MS} millis`)),
      Effect.forkScoped,
    );
  }),
);
