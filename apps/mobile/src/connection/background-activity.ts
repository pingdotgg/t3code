import { EnvironmentRegistry, EnvironmentSupervisor } from "@t3tools/client-runtime/connection";
import { EnvironmentRpcSubscriptionObserver, request } from "@t3tools/client-runtime/rpc";
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
import { AppState, type AppStateStatus } from "react-native";

import * as MobileStorage from "../persistence/mobile-storage";
import {
  observeMobileBackgroundActivitySubscription,
  onRetainedMobileBackgroundScopesChange,
  retainedMobileBackgroundScopes,
} from "./background-activity-scopes";

const REPORT_INTERVAL_MS = 25_000;
const LEASE_TTL_MS = 45_000;
const BASELINE_SCOPES: ReadonlyArray<BackgroundScope> = [{ type: "provider-status" }];

function normalizeAppState(
  state: AppStateStatus,
): NonNullable<ClientActivityReportInput["appState"]> {
  if (state === "active" || state === "inactive" || state === "background") return state;
  return "unknown";
}

export const mobileBackgroundActivityObserverLayer = Layer.succeed(
  EnvironmentRpcSubscriptionObserver,
  EnvironmentRpcSubscriptionObserver.of({
    observe: observeMobileBackgroundActivitySubscription,
  }),
);

export const mobileBackgroundActivityReporterLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const registry = yield* EnvironmentRegistry;
    const storage = yield* MobileStorage.MobileStorage;
    const clientId = yield* storage.loadOrCreateAgentAwarenessDeviceId.pipe(
      Effect.map((deviceId) => `mobile-${deviceId}`),
      Effect.orElseSucceed(() => "ephemeral-mobile-client"),
    );
    const reportRequests = yield* Queue.sliding<void>(1);
    const requestReport = () => Queue.offerUnsafe(reportRequests, undefined);
    let appState = AppState.currentState;

    const report = Effect.gen(function* () {
      const observedAtMs = yield* Clock.currentTimeMillis;
      const active = appState === "active";
      const entries = yield* SubscriptionRef.get(registry.entries);
      yield* Effect.forEach(
        entries.keys(),
        (environmentId) =>
          registry
            .run(
              environmentId,
              request(WS_METHODS.serverReportClientActivity, {
                environmentId: environmentId as EnvironmentId,
                clientId,
                clientKind: "mobile",
                visible: active,
                focused: active,
                recentlyInteracted: active,
                appState: normalizeAppState(appState),
                scopes: [
                  ...BASELINE_SCOPES,
                  ...retainedMobileBackgroundScopes(environmentId as EnvironmentId),
                ],
                ttlMs: LEASE_TTL_MS,
                observedAt: DateTime.makeUnsafe(observedAtMs),
              }),
            )
            .pipe(Effect.ignore),
        { concurrency: "unbounded", discard: true },
      );
    }).pipe(Effect.withSpan("mobile.backgroundActivity.report"));

    yield* Effect.acquireRelease(
      Effect.sync(() => {
        const removeScopeListener = onRetainedMobileBackgroundScopesChange(requestReport);
        const subscription = AppState.addEventListener("change", (nextState) => {
          appState = nextState;
          requestReport();
        });
        return { removeScopeListener, subscription };
      }),
      ({ removeScopeListener, subscription }) =>
        Effect.sync(() => {
          removeScopeListener();
          subscription.remove();
        }),
    );
    yield* SubscriptionRef.changes(registry.entries).pipe(
      Stream.runForEach(() => Effect.sync(requestReport)),
      Effect.forkScoped,
    );
    // Re-report on every newly connected session generation. The AppState
    // report races the reconnect (the RPC fails while the socket is down and
    // is ignored), so without this the server's lease can lag a resume by up
    // to REPORT_INTERVAL_MS, keeping provider/VCS work paused. The generation
    // dedup lives inside the per-supervisor stream because a replacement
    // supervisor restarts generations; switchMap (default concurrency)
    // interrupts the previous subscription set on environment changes.
    const connectedGenerations = (environmentId: EnvironmentId) =>
      registry.followStream(
        environmentId,
        Stream.unwrap(
          Effect.map(EnvironmentSupervisor, (supervisor) =>
            SubscriptionRef.changes(supervisor.state).pipe(
              Stream.filter((state) => state.phase === "connected"),
              Stream.map((state) => state.generation),
              Stream.changes,
            ),
          ),
        ),
      );
    yield* Stream.concat(
      Stream.fromEffect(SubscriptionRef.get(registry.entries)),
      SubscriptionRef.changes(registry.entries),
    ).pipe(
      Stream.map((entries) => [...entries.keys()].sort()),
      Stream.changesWith((a, b) => a.length === b.length && a.every((id, i) => id === b[i])),
      Stream.switchMap((environmentIds) =>
        Stream.mergeAll(environmentIds.map(connectedGenerations), {
          concurrency: "unbounded",
        }),
      ),
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
