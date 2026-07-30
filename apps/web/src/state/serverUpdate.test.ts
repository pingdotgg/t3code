import type { EnvironmentId } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  beginPendingServerUpdate,
  clearPendingServerUpdate,
  getPendingServerUpdateForTests,
  markPendingServerUpdateRestartAccepted,
  resetPendingServerUpdatesForTests,
  SERVER_UPDATE_PENDING_EXPIRY_MS,
} from "./serverUpdate";

const environmentId = "environment-1" as EnvironmentId;

describe("serverUpdate", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetPendingServerUpdatesForTests();
  });

  afterEach(() => {
    resetPendingServerUpdatesForTests();
    vi.useRealTimers();
  });

  it("keeps the latest update pending until its safety deadline", () => {
    const attempt = beginPendingServerUpdate(environmentId, "0.0.29");

    expect(getPendingServerUpdateForTests(environmentId)).toEqual({
      attempt,
      targetVersion: "0.0.29",
    });

    vi.advanceTimersByTime(SERVER_UPDATE_PENDING_EXPIRY_MS);
    expect(getPendingServerUpdateForTests(environmentId)).toBeNull();
  });

  it("starts a fresh deadline after restart is accepted", () => {
    const attempt = beginPendingServerUpdate(environmentId, "0.0.29");
    vi.advanceTimersByTime(SERVER_UPDATE_PENDING_EXPIRY_MS - 1);

    markPendingServerUpdateRestartAccepted(environmentId, attempt);
    vi.advanceTimersByTime(SERVER_UPDATE_PENDING_EXPIRY_MS - 1);
    expect(getPendingServerUpdateForTests(environmentId)).not.toBeNull();

    vi.advanceTimersByTime(1);
    expect(getPendingServerUpdateForTests(environmentId)).toBeNull();
  });

  it("does not let an older attempt clear a newer retry", () => {
    const firstAttempt = beginPendingServerUpdate(environmentId, "0.0.29");
    const retryAttempt = beginPendingServerUpdate(environmentId, "0.0.29");

    clearPendingServerUpdate(environmentId, firstAttempt);
    expect(getPendingServerUpdateForTests(environmentId)?.attempt).toBe(retryAttempt);
  });
});
