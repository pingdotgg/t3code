import { EnvironmentRegistry } from "@t3tools/client-runtime/connection";
import { EnvironmentId, WS_METHODS } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as TestClock from "effect/testing/TestClock";
import { vi } from "vite-plus/test";

const appState = vi.hoisted(() => {
  const state: { current: string; listener: ((next: string) => void) | undefined } = {
    current: "active",
    listener: undefined,
  };
  return state;
});

vi.mock("react-native", () => ({
  AppState: {
    get currentState() {
      return appState.current;
    },
    addEventListener: (_event: string, listener: (next: string) => void) => {
      appState.listener = listener;
      return { remove: () => (appState.listener = undefined) };
    },
  },
}));

vi.mock("expo-secure-store", () => ({
  deleteItemAsync: vi.fn(),
  getItemAsync: vi.fn(),
  setItemAsync: vi.fn(),
}));

import * as MobileSecureStorage from "../persistence/mobile-secure-storage";
import * as MobileStorage from "../persistence/mobile-storage";
import { layerReporter } from "./background-activity";
import {
  onRetainedMobileBackgroundScopesChange,
  observeMobileBackgroundActivitySubscription,
  retainedMobileBackgroundScopes,
} from "./background-activity-scopes";

function setup() {
  appState.current = "active";
  appState.listener = undefined;
}

function changeAppState(next: string) {
  appState.current = next;
  appState.listener?.(next);
}

describe("mobile background activity", () => {
  it.effect("retains VCS demand only while the mobile subscription is active", () =>
    Effect.gen(function* () {
      const environmentId = EnvironmentId.make("mobile-environment");
      const releasePassive = yield* observeMobileBackgroundActivitySubscription({
        environmentId,
        method: WS_METHODS.subscribeVcsStatus,
        input: { cwd: "/workspace", includeRemote: false },
      });
      expect(retainedMobileBackgroundScopes(environmentId)).toEqual([]);
      const release = yield* observeMobileBackgroundActivitySubscription({
        environmentId,
        method: WS_METHODS.subscribeVcsStatus,
        input: { cwd: "/workspace" },
      });

      expect(retainedMobileBackgroundScopes(environmentId)).toEqual([
        { type: "vcs-status", cwd: "/workspace" },
      ]);

      yield* releasePassive;
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

  it.effect("reports on state changes but skips periodic reports while backgrounded", () =>
    Effect.gen(function* () {
      setup();
      const entries = yield* SubscriptionRef.make(
        new Map([[EnvironmentId.make("environment-reporter-test"), {}]]),
      );
      let calls = 0;
      const registry = EnvironmentRegistry.EnvironmentRegistry.of({
        entries,
        run: () => {
          calls += 1;
          return Effect.void;
        },
      } as unknown as EnvironmentRegistry.EnvironmentRegistry["Service"]);
      const secureStorage = MobileSecureStorage.MobileSecureStorage.of({
        getItem: () => Effect.succeed("device"),
        setItem: () => Effect.void,
        removeItem: () => Effect.void,
      });

      yield* Layer.build(
        layerReporter.pipe(
          Layer.provide(MobileStorage.layer),
          Layer.provide(Layer.succeed(MobileSecureStorage.MobileSecureStorage, secureStorage)),
          Layer.provide(Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, registry)),
        ),
      );
      yield* TestClock.adjust("1 second");
      expect(calls).toBe(1);

      changeAppState("background");
      yield* TestClock.adjust("1 second");
      expect(calls).toBe(2);

      yield* TestClock.adjust("60 seconds");
      expect(calls).toBe(2);

      changeAppState("active");
      yield* TestClock.adjust("1 second");
      expect(calls).toBe(3);

      yield* TestClock.adjust("25 seconds");
      expect(calls).toBe(4);

      changeAppState("inactive");
      yield* TestClock.adjust("1 second");
      expect(calls).toBe(5);

      yield* TestClock.adjust("25 seconds");
      expect(calls).toBe(6);
    }),
  );
});
