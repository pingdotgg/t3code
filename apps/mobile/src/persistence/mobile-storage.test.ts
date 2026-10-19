import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { beforeEach, vi } from "vite-plus/test";

const { values, getItemAsync, setItemAsync, uuidv4 } = vi.hoisted(() => {
  const values = new Map<string, string>();
  return {
    values,
    getItemAsync: vi.fn(async (key: string) => {
      const value = values.get(key) ?? null;
      await Promise.resolve();
      return value;
    }),
    setItemAsync: vi.fn(async (key: string, value: string) => {
      values.set(key, value);
    }),
    uuidv4: vi.fn(),
  };
});

vi.mock("expo-secure-store", () => ({ getItemAsync, setItemAsync }));
vi.mock("expo-crypto", () => ({ randomUUID: uuidv4 }));

import "../lib/uuid";

import * as MobileSecureStorage from "./mobile-secure-storage";
import * as MobileStorage from "./mobile-storage";

const deviceIdKey = "t3code.agent-awareness.device-id";
const makeStorage = MobileStorage.make().pipe(Effect.provide(MobileSecureStorage.layer));

beforeEach(() => {
  values.clear();
  getItemAsync.mockClear();
  setItemAsync.mockClear();
  uuidv4.mockReset();
  let generated = 0;
  uuidv4.mockImplementation(() => `generated-device-${++generated}`);
});

describe("mobile device identity", () => {
  it.effect("concurrent first-use callers share one persisted device identity", () =>
    Effect.gen(function* () {
      const storage = yield* makeStorage;
      const deviceIds = yield* Effect.all(
        [storage.loadOrCreateAgentAwarenessDeviceId, storage.loadOrCreateAgentAwarenessDeviceId],
        { concurrency: "unbounded" },
      );

      expect(deviceIds).toEqual(["generated-device-1", "generated-device-1"]);
      expect(yield* storage.loadAgentAwarenessDeviceId).toBe(deviceIds[0]);
      expect(values.get(deviceIdKey)).toBe(deviceIds[0]);
      expect(uuidv4).toHaveBeenCalledTimes(1);
      expect(setItemAsync).toHaveBeenCalledTimes(1);
    }),
  );

  it.effect("reuses an existing device identity without generating or writing", () =>
    Effect.gen(function* () {
      values.set(deviceIdKey, "existing-device");
      const storage = yield* makeStorage;

      expect(yield* storage.loadOrCreateAgentAwarenessDeviceId).toBe("existing-device");
      expect(uuidv4).not.toHaveBeenCalled();
      expect(setItemAsync).not.toHaveBeenCalled();
    }),
  );

  it.effect("retries a failed first write without retaining an unpersisted identity", () =>
    Effect.gen(function* () {
      setItemAsync.mockRejectedValueOnce(new Error("Secure storage unavailable"));
      const storage = yield* makeStorage;
      const first = yield* Effect.result(storage.loadOrCreateAgentAwarenessDeviceId);

      expect(first).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "MobileSecureStorageError", operation: "write", key: deviceIdKey },
      });
      expect(yield* storage.loadAgentAwarenessDeviceId).toBeNull();
      expect(yield* storage.loadOrCreateAgentAwarenessDeviceId).toBe("generated-device-2");
      expect(yield* storage.loadAgentAwarenessDeviceId).toBe("generated-device-2");
      expect(uuidv4).toHaveBeenCalledTimes(2);
    }),
  );
});
