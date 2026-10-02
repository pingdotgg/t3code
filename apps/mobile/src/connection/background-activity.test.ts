import { EnvironmentId, WS_METHODS } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { vi } from "vite-plus/test";

vi.mock("react-native", () => ({
  AppState: {
    currentState: "active",
    addEventListener: () => ({ remove: () => undefined }),
  },
}));

vi.mock("expo-secure-store", () => ({
  deleteItemAsync: vi.fn(),
  getItemAsync: vi.fn(),
  setItemAsync: vi.fn(),
}));

import {
  AVAILABLE_CONNECTION_STATE,
  type ConnectionCatalogEntry,
  EnvironmentNotRegisteredError,
  EnvironmentRegistry,
  type NetworkStatus,
  type SupervisorConnectionState,
} from "@t3tools/client-runtime/connection";

import * as MobileStorage from "../persistence/mobile-storage";
import { mobileBackgroundActivityReporterLayer } from "./background-activity";
import {
  onRetainedMobileBackgroundScopesChange,
  observeMobileBackgroundActivitySubscription,
  retainedMobileBackgroundScopes,
} from "./background-activity-scopes";

describe("mobile background activity", () => {
  it.effect("retains VCS demand only while the mobile subscription is active", () =>
    Effect.gen(function* () {
      const environmentId = EnvironmentId.make("mobile-environment");
      const release = yield* observeMobileBackgroundActivitySubscription({
        environmentId,
        method: WS_METHODS.subscribeVcsStatus,
        input: { cwd: "/workspace" },
      });

      expect(retainedMobileBackgroundScopes(environmentId)).toEqual([
        { type: "vcs-status", cwd: "/workspace" },
      ]);

      yield* release;
      expect(retainedMobileBackgroundScopes(environmentId)).toEqual([]);
    }),
  );

  it.effect("keeps delimiter-containing environment and scope values distinct", () =>
    Effect.gen(function* () {
      const firstEnvironmentId = EnvironmentId.make("a");
      const secondEnvironmentId = EnvironmentId.make("a:vcs-status:b");
      const releaseFirst = yield* observeMobileBackgroundActivitySubscription({
        environmentId: firstEnvironmentId,
        method: WS_METHODS.subscribeVcsStatus,
        input: { cwd: "b:vcs-status:c" },
      });
      const releaseSecond = yield* observeMobileBackgroundActivitySubscription({
        environmentId: secondEnvironmentId,
        method: WS_METHODS.subscribeVcsStatus,
        input: { cwd: "c" },
      });

      expect(retainedMobileBackgroundScopes(firstEnvironmentId)).toEqual([
        { type: "vcs-status", cwd: "b:vcs-status:c" },
      ]);
      expect(retainedMobileBackgroundScopes(secondEnvironmentId)).toEqual([
        { type: "vcs-status", cwd: "c" },
      ]);

      yield* Effect.all([releaseFirst, releaseSecond]);
    }),
  );

  it.effect("returns a release handle when a retained-scope listener throws", () =>
    Effect.gen(function* () {
      const environmentId = EnvironmentId.make("throwing-listener-environment");
      const removeListener = onRetainedMobileBackgroundScopesChange(() => {
        throw new Error("listener failed");
      });

      const release = yield* observeMobileBackgroundActivitySubscription({
        environmentId,
        method: WS_METHODS.subscribeVcsStatus,
        input: { cwd: "/workspace" },
      });
      expect(retainedMobileBackgroundScopes(environmentId)).toEqual([
        { type: "vcs-status", cwd: "/workspace" },
      ]);

      yield* release;
      expect(retainedMobileBackgroundScopes(environmentId)).toEqual([]);
      removeListener();
    }),
  );

  // Live so the reporter's 250ms debounce runs for real. Each assertion waits on
  // a report receipt, bounded well under the 25s fallback interval that would
  // otherwise hide a missing reconnect report behind a slow pass.
  it.live("re-reports activity when an environment reaches a new connected generation", () =>
    Effect.gen(function* () {
      const environmentId = EnvironmentId.make("reconnecting-environment");
      const connectionState = yield* SubscriptionRef.make<SupervisorConnectionState>({
        ...AVAILABLE_CONNECTION_STATE,
        desired: true,
        phase: "connecting",
      });
      const reports = yield* Ref.make(0);
      const whileConnecting = yield* Deferred.make<void>();
      const whenConnected = yield* Deferred.make<void>();
      const awaitReport = (report: Deferred.Deferred<void>) =>
        Deferred.await(report).pipe(
          Effect.timeoutOrElse({
            duration: "5 seconds",
            orElse: () => Effect.die(new Error("The reporter never sent the expected report.")),
          }),
        );
      // The reporter only reads the keys, never the entry itself.
      const entries = yield* SubscriptionRef.make<
        ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>
      >(new Map([[environmentId, {} as ConnectionCatalogEntry]]));
      // Plain state, so the mock cannot synthesize it the way it does methods.
      const networkStatus = yield* SubscriptionRef.make<NetworkStatus>("online");

      yield* Layer.build(
        mobileBackgroundActivityReporterLayer.pipe(
          Layer.provide(
            Layer.merge(
              Layer.mock(EnvironmentRegistry)({
                entries,
                networkStatus,
                stateChanges: () => SubscriptionRef.changes(connectionState),
                run: (environmentId) =>
                  Ref.updateAndGet(reports, (count) => count + 1).pipe(
                    Effect.flatMap((count) =>
                      Deferred.succeed(count === 1 ? whileConnecting : whenConnected, undefined),
                    ),
                    // No session exists to produce the real response. The
                    // reporter ignores a sent report and a missing one alike.
                    Effect.andThen(
                      Effect.fail(new EnvironmentNotRegisteredError({ environmentId })),
                    ),
                  ),
              }),
              Layer.mock(MobileStorage.MobileStorage)({
                loadOrCreateAgentAwarenessDeviceId: Effect.succeed("device-1"),
              }),
            ),
          ),
        ),
      );

      yield* awaitReport(whileConnecting);
      expect(yield* Ref.get(reports)).toBe(1);

      const connected: SupervisorConnectionState = {
        ...AVAILABLE_CONNECTION_STATE,
        desired: true,
        phase: "connected",
        attempt: 1,
        generation: 1,
      };
      yield* SubscriptionRef.set(connectionState, connected);
      yield* awaitReport(whenConnected);
      expect(yield* Ref.get(reports)).toBe(2);
    }),
  );
});
