import type { HostResourcesSnapshot } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";
import { describe, expect, it } from "vite-plus/test";

import { getHostStoragePresentation } from "./hostStorage.ts";

const snapshot: HostResourcesSnapshot = {
  sampledAt: 1_789_000_000_000,
  cpuUtilization: 0.1,
  cpuCount: 8,
  availableMemoryBytes: 8 * 1024 ** 3,
  totalMemoryBytes: 16 * 1024 ** 3,
  storage: { totalBytes: 457 * 1024 ** 3, availableBytes: 254 * 1024 ** 3 },
};

describe("host storage presentation", () => {
  it("formats the available capacity and keeps the server's reading time", () => {
    expect(getHostStoragePresentation(AsyncResult.success(snapshot))).toEqual({
      status: "available",
      label: "254 GiB available of 457 GiB",
      availablePercent: (254 / 457) * 100,
      sampledAt: snapshot.sampledAt,
    });
  });

  it("shows a full disk as zero available, not unknown", () => {
    expect(
      getHostStoragePresentation(
        AsyncResult.success({
          ...snapshot,
          storage: { totalBytes: 2 * 1024 ** 4, availableBytes: 0 },
        }),
      ),
    ).toMatchObject({
      status: "available",
      label: "0 B available of 2 TiB",
      availablePercent: 0,
    });
  });

  it.each([null, undefined])("treats %s storage as unavailable", (storage) => {
    const { storage: _storage, ...legacySnapshot } = snapshot;
    expect(
      getHostStoragePresentation(
        AsyncResult.success(storage === undefined ? legacySnapshot : { ...snapshot, storage }),
      ),
    ).toEqual({ status: "unavailable" });
  });

  it("does not show the previous capacity while refreshing", () => {
    expect(getHostStoragePresentation(AsyncResult.initial())).toEqual({ status: "loading" });
    expect(getHostStoragePresentation(AsyncResult.waiting(AsyncResult.success(snapshot)))).toEqual({
      status: "loading",
    });
  });

  it("does not show a cached reading after a failed request", () => {
    expect(
      getHostStoragePresentation(
        AsyncResult.failure(Cause.fail(new Error("Disconnected")), {
          previousSuccess: Option.some(AsyncResult.success(snapshot)),
        }),
      ),
    ).toEqual({ status: "unavailable" });
  });
});
