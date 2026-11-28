import { EnvironmentRegistry } from "@t3tools/client-runtime/connection";
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
import { AppState } from "react-native";

import {
  isAndroidBatterySaverEnabled,
  subscribeAndroidBatterySaver,
} from "../lib/androidBatterySaver";
import { readAndroidPowerSaveMode, subscribeAndroidPowerSaveMode } from "../native/androidPower";
import * as MobileStorage from "../persistence/mobile-storage";
import {
  observeMobileBackgroundActivitySubscription,
  onRetainedMobileBackgroundScopesChange,
  retainedMobileBackgroundScopes,
} from "./background-activity-scopes";

const REPORT_INTERVAL_MS = 25_000;
// Shorter than the interval, so a report that never settles cannot hold up the next one.
const REPORT_TIMEOUT_MS = 15_000;
const LEASE_TTL_MS = 45_000;
const BASELINE_SCOPES: ReadonlyArray<BackgroundScope> = [{ type: "provider-status" }];

function normalizeAppState(
  state: string | null | undefined,
): NonNullable<ClientActivityReportInput["appState"]> {
  if (state === "active" || state === "inactive" || state === "background") return state;
  return "unknown";
}

// Control Center, alerts, and the app switcher leave the app on screen as `inactive`.
/** Omitted unless Battery Saver is on in Labs, so hosts keep treating the phone as unknown. */
function reportedLowPowerMode(
  batterySaverEnabled: boolean,
  powerSaveMode: boolean | null,
): Pick<ClientActivityReportInput, "lowPowerMode"> {
  if (!batterySaverEnabled) return {};
  return { lowPowerMode: powerSaveMode === null ? "unknown" : powerSaveMode ? "true" : "false" };
}

function isForeground(state: string | null | undefined): boolean {
  return state === "active" || state === "inactive";
}

export const layerObserver = Layer.succeed(
  EnvironmentRpcSubscriptionObserver,
  EnvironmentRpcSubscriptionObserver.of({
    observe: observeMobileBackgroundActivitySubscription,
  }),
);

export const layerReporter = Layer.effectDiscard(
  Effect.gen(function* () {
    const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
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
      const foreground = isForeground(appState);
      // Read at report time: Android drops power-saver broadcasts to a cached app.
      const lowPowerMode = reportedLowPowerMode(
        isAndroidBatterySaverEnabled(),
        readAndroidPowerSaveMode(),
      );
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
                visible: foreground,
                focused: foreground,
                recentlyInteracted: foreground,
                appState: normalizeAppState(appState),
                ...lowPowerMode,
                scopes: [
                  ...BASELINE_SCOPES,
                  ...retainedMobileBackgroundScopes(environmentId as EnvironmentId),
                ],
                ttlMs: LEASE_TTL_MS,
                observedAt: DateTime.makeUnsafe(observedAtMs),
              }),
            )
            // Not `ignore`: tearing down an environment mid-request interrupts its report,
            // and an interrupt leaking out here would end the reporting loop for good.
            // The timeout covers a live connection that never answers, which would stall it.
            .pipe(Effect.timeout(`${REPORT_TIMEOUT_MS} millis`), Effect.ignoreCause),
        { concurrency: "unbounded", discard: true },
      );
    }).pipe(Effect.withSpan("mobile.backgroundActivity.report"));

    yield* Effect.acquireRelease(
      Effect.sync(() => {
        const removeScopeListener = onRetainedMobileBackgroundScopesChange(requestReport);
        const removeBatterySaverListener = subscribeAndroidBatterySaver(requestReport);
        const removePowerSaveListener = subscribeAndroidPowerSaveMode(requestReport);
        const subscription = AppState.addEventListener("change", (nextState) => {
          const changed = isForeground(appState) !== isForeground(nextState);
          appState = nextState;
          if (changed) requestReport();
        });
        return {
          remove: () => {
            removeScopeListener();
            removeBatterySaverListener();
            removePowerSaveListener();
            subscription.remove();
          },
        };
      }),
      (listeners) => Effect.sync(() => listeners.remove()),
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
    yield* Effect.sync(() => {
      if (isForeground(appState)) requestReport();
    }).pipe(Effect.repeat(Schedule.spaced(`${REPORT_INTERVAL_MS} millis`)), Effect.forkScoped);
  }),
);
