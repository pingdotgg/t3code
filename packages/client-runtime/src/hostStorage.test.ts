import type { HostStorageResult } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";
import { describe, expect, it } from "vite-plus/test";

import { getHostStoragePresentation } from "./hostStorage.ts";

const snapshot: HostStorageResult = {
  sampledAt: 1_789_000_000_000,
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

  it("treats unavailable storage as unknown", () => {
    expect(getHostStoragePresentation(AsyncResult.success({ ...snapshot, storage: null }))).toEqual(
      { status: "unavailable" },
    );
  });

  it("does not show the previous capacity while refreshing", () => {
    expect(getHostStoragePresentation(AsyncResult.initial())).toEqual({ status: "loading" });
    expect(getHostStoragePresentation(AsyncResult.waiting(AsyncResult.success(snapshot)))).toEqual({
      status: "loading",
    });
  });

  it("shows unavailable after disconnection or an older server rejects the storage RPC", () => {
    expect(
      getHostStoragePresentation(
        AsyncResult.failure(Cause.fail(new Error("Disconnected")), {
          previousSuccess: Option.some(AsyncResult.success(snapshot)),
        }),
      ),
    ).toEqual({ status: "unavailable" });
  });
});
