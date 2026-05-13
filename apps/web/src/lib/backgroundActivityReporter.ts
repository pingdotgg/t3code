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
    listener();
  }
}

function stableScopeKey(environmentId: EnvironmentId, scope: BackgroundScope): string {
  const prefix = `${environmentId}:`;
  switch (scope.type) {
    case "server-config":
    case "diagnostics":
      return `${prefix}${scope.type}`;
    case "provider-status":
      return scope.instanceId
        ? `${prefix}${scope.type}:${scope.instanceId}`
        : `${prefix}${scope.type}`;
    case "vcs-status":
    case "git-refs":
      return `${prefix}${scope.type}:${scope.cwd}`;
    case "thread":
      return `${prefix}${scope.type}:${scope.threadId}`;
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

function createActivityReport(environmentId: EnvironmentId): ClientActivityReportInput {
  return {
    environmentId,
    clientId: getClientId(),
    clientKind: resolveClientKind(),
    visible: document.visibilityState === "visible",
    focused: document.hasFocus(),
    recentlyInteracted: document.hasFocus(),
    appState: document.visibilityState === "visible" ? "active" : "background",
    scopes: [
      ...BASELINE_SCOPES,
      ...[...retainedScopes.values()]
        .filter((entry) => entry.environmentId === environmentId)
        .map((entry) => entry.scope),
    ],
    ttlMs: LEASE_TTL_MS,
    observedAt: DateTime.makeUnsafe(new Date().toISOString()),
  };
}

function scopeForSubscription(
  observation: EnvironmentRpcSubscriptionObservation,
): BackgroundScope | null {
  if (observation.method !== WS_METHODS.subscribeVcsStatus) {
    return null;
  }
  const input = observation.input as { readonly cwd?: unknown };
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

export const backgroundActivityObserverLayer = Layer.succeed(
  EnvironmentRpcSubscriptionObserver,
  EnvironmentRpcSubscriptionObserver.of({
    observe: (observation) => {
      const scope = scopeForSubscription(observation);
      if (scope === null) {
        return Effect.succeed(Effect.void);
      }
      return Effect.sync(() =>
        Effect.sync(retainBackgroundScope(observation.environmentId as EnvironmentId, scope)),
      );
    },
  }),
);

export const backgroundActivityReporterLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    if (typeof window === "undefined" || typeof document === "undefined") {
      return;
    }

    const registry = yield* EnvironmentRegistry;
    const reportRequests = yield* Queue.sliding<void>(1);
    const requestReport = () => Queue.offerUnsafe(reportRequests, undefined);

    const report = Effect.gen(function* () {
      const entries = yield* SubscriptionRef.get(registry.entries);
      yield* Effect.forEach(
        entries.keys(),
        (environmentId) =>
          registry
            .run(
              environmentId,
              request(WS_METHODS.serverReportClientActivity, createActivityReport(environmentId)),
            )
            .pipe(Effect.ignore),
        { concurrency: "unbounded", discard: true },
      );
    }).pipe(Effect.withSpan("web.backgroundActivity.report"));

    yield* Effect.acquireRelease(
      Effect.sync(() => {
        retainedScopeListeners.add(requestReport);
        document.addEventListener("visibilitychange", requestReport);
        window.addEventListener("focus", requestReport);
        window.addEventListener("blur", requestReport);
        window.addEventListener("online", requestReport);
      }),
      () =>
        Effect.sync(() => {
          retainedScopeListeners.delete(requestReport);
          document.removeEventListener("visibilitychange", requestReport);
          window.removeEventListener("focus", requestReport);
          window.removeEventListener("blur", requestReport);
          window.removeEventListener("online", requestReport);
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
    yield* report.pipe(
      Effect.repeat(Schedule.spaced(`${REPORT_INTERVAL_MS} millis`)),
      Effect.forkScoped,
    );

    requestReport();
  }),
);
