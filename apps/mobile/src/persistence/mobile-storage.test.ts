import { expect, it } from "@effect/vitest";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { vi } from "vite-plus/test";

const secureStore = vi.hoisted(() => new Map<string, string>());

vi.mock("expo-secure-store", () => ({
  getItemAsync: vi.fn((key: string) => Promise.resolve(secureStore.get(key) ?? null)),
  setItemAsync: vi.fn((key: string, value: string) => {
    secureStore.set(key, value);
    return Promise.resolve();
  }),
  deleteItemAsync: vi.fn((key: string) => {
    secureStore.delete(key);
    return Promise.resolve();
  }),
}));

vi.mock("react-native", () => ({
  Platform: { OS: "android" },
}));

import * as MobileSecureStorage from "./mobile-secure-storage";
import * as MobileStorage from "./mobile-storage";

const RETAINED_THREAD_KEY = "t3code.background-connection.retained-thread";

const makeStorage = MobileStorage.make().pipe(
  Effect.provideService(MobileSecureStorage.MobileSecureStorage, MobileSecureStorage.make),
);

it.effect("round-trips and clears the retained background thread", () =>
  Effect.gen(function* () {
    secureStore.clear();
    const storage = yield* makeStorage;
    const retained = {
      environmentId: EnvironmentId.make("environment-1"),
      threadId: ThreadId.make("thread-1"),
    };

    yield* storage.saveBackgroundConnectionRetainedThread(retained);
    expect(yield* storage.loadBackgroundConnectionRetainedThread).toEqual(retained);

    yield* storage.clearBackgroundConnectionRetainedThread;
    expect(yield* storage.loadBackgroundConnectionRetainedThread).toBeNull();
  }),
);

it.effect("removes malformed retained-thread storage", () =>
  Effect.gen(function* () {
    secureStore.clear();
    secureStore.set(RETAINED_THREAD_KEY, JSON.stringify({ environmentId: "environment-1" }));
    const storage = yield* makeStorage;

    expect(yield* storage.loadBackgroundConnectionRetainedThread).toBeNull();
    expect(secureStore.has(RETAINED_THREAD_KEY)).toBe(false);
  }),
);
