import { afterEach, describe, expect, it } from "vite-plus/test";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";

import {
  __resetThreadAlertsForTests,
  clearThreadAlert,
  isThreadAlertExpired,
  markThreadAlert,
  markThreadAlertsFocused,
  pruneExpiredThreadAlerts,
  readThreadAlert,
  readThreadAlerts,
  THREAD_ALERT_FOCUSED_TTL_MS,
  THREAD_ALERT_MAX_TTL_MS,
} from "./threadAlertStore";

const THREAD_A = {
  environmentId: "env-1" as EnvironmentId,
  threadId: "thread-1" as ThreadId,
};
const THREAD_B = {
  environmentId: "env-1" as EnvironmentId,
  threadId: "thread-2" as ThreadId,
};
/** Same thread id, different environment: the two must not collide. */
const THREAD_A_OTHER_ENV = {
  environmentId: "env-2" as EnvironmentId,
  threadId: "thread-1" as ThreadId,
};

const T0 = 1_000_000;
const UNFOCUSED = { nowMs: T0, windowFocused: false } as const;

describe("threadAlertStore", () => {
  afterEach(() => {
    __resetThreadAlertsForTests();
  });

  it("has no highlight until something happens", () => {
    expect(readThreadAlert(THREAD_A)).toBeNull();
  });

  it("marks and clears a thread", () => {
    markThreadAlert(THREAD_A, "completed", UNFOCUSED);
    expect(readThreadAlert(THREAD_A)).toBe("completed");

    clearThreadAlert(THREAD_A);
    expect(readThreadAlert(THREAD_A)).toBeNull();
  });

  it("keeps threads independent, including across environments", () => {
    markThreadAlert(THREAD_A, "completed", UNFOCUSED);
    markThreadAlert(THREAD_B, "failed", UNFOCUSED);
    markThreadAlert(THREAD_A_OTHER_ENV, "failed", UNFOCUSED);

    expect(readThreadAlert(THREAD_A)).toBe("completed");
    expect(readThreadAlert(THREAD_B)).toBe("failed");
    expect(readThreadAlert(THREAD_A_OTHER_ENV)).toBe("failed");

    clearThreadAlert(THREAD_A);
    expect(readThreadAlert(THREAD_B)).toBe("failed");
    expect(readThreadAlert(THREAD_A_OTHER_ENV)).toBe("failed");
  });

  it("lets a failure outrank a completion the user has not seen yet", () => {
    markThreadAlert(THREAD_A, "completed", UNFOCUSED);
    markThreadAlert(THREAD_A, "failed", UNFOCUSED);
    expect(readThreadAlert(THREAD_A)).toBe("failed");

    markThreadAlert(THREAD_A, "completed", UNFOCUSED);
    expect(readThreadAlert(THREAD_A)).toBe("failed");
  });

  it("re-marks after the user has seen and cleared it", () => {
    markThreadAlert(THREAD_A, "failed", UNFOCUSED);
    clearThreadAlert(THREAD_A);
    markThreadAlert(THREAD_A, "completed", UNFOCUSED);

    expect(readThreadAlert(THREAD_A)).toBe("completed");
  });

  it("ignores clearing a thread that was never marked", () => {
    expect(() => clearThreadAlert(THREAD_A)).not.toThrow();
    expect(readThreadAlert(THREAD_A)).toBeNull();
  });

  describe("expiry", () => {
    it("holds indefinitely while the window has never been focused", () => {
      const alert = { kind: "completed" as const, markedAtMs: T0, focusedAtMs: null };

      expect(isThreadAlertExpired(alert, T0 + THREAD_ALERT_MAX_TTL_MS - 1)).toBe(false);
    });

    it("expires at the hard ceiling even without focus", () => {
      const alert = { kind: "completed" as const, markedAtMs: T0, focusedAtMs: null };

      expect(isThreadAlertExpired(alert, T0 + THREAD_ALERT_MAX_TTL_MS)).toBe(true);
    });

    it("expires shortly after the window gains focus", () => {
      const alert = { kind: "completed" as const, markedAtMs: T0, focusedAtMs: T0 + 500 };

      expect(isThreadAlertExpired(alert, T0 + 500 + THREAD_ALERT_FOCUSED_TTL_MS - 1)).toBe(false);
      expect(isThreadAlertExpired(alert, T0 + 500 + THREAD_ALERT_FOCUSED_TTL_MS)).toBe(true);
    });

    it("starts the focused countdown immediately when marked while focused", () => {
      markThreadAlert(THREAD_A, "completed", { nowMs: T0, windowFocused: true });

      expect(
        readThreadAlerts()[`${THREAD_A.environmentId}:${THREAD_A.threadId}`]?.focusedAtMs,
      ).toBe(T0);
    });

    it("starts the countdown when focus arrives later", () => {
      markThreadAlert(THREAD_A, "completed", UNFOCUSED);
      markThreadAlertsFocused(T0 + 1_000);

      const key = `${THREAD_A.environmentId}:${THREAD_A.threadId}`;
      expect(readThreadAlerts()[key]?.focusedAtMs).toBe(T0 + 1_000);
    });

    it("does not push the deadline out when focus is regained repeatedly", () => {
      markThreadAlert(THREAD_A, "completed", UNFOCUSED);
      markThreadAlertsFocused(T0 + 1_000);
      // Clicking around, re-focusing the window, switching Spaces back and forth.
      markThreadAlertsFocused(T0 + 1_500);
      markThreadAlertsFocused(T0 + 2_000);

      const key = `${THREAD_A.environmentId}:${THREAD_A.threadId}`;
      expect(readThreadAlerts()[key]?.focusedAtMs).toBe(T0 + 1_000);
    });

    it("prunes only the alerts that are actually expired", () => {
      markThreadAlert(THREAD_A, "completed", { nowMs: T0, windowFocused: true });
      markThreadAlert(THREAD_B, "failed", { nowMs: T0 + 2_500, windowFocused: true });

      pruneExpiredThreadAlerts(T0 + THREAD_ALERT_FOCUSED_TTL_MS);

      expect(readThreadAlert(THREAD_A)).toBeNull();
      expect(readThreadAlert(THREAD_B)).toBe("failed");
    });

    it("never lets a highlight outlive the ceiling, focused or not", () => {
      markThreadAlert(THREAD_A, "completed", UNFOCUSED);

      pruneExpiredThreadAlerts(T0 + THREAD_ALERT_MAX_TTL_MS);
      expect(readThreadAlert(THREAD_A)).toBeNull();
    });

    it("leaves everything alone when nothing has expired", () => {
      markThreadAlert(THREAD_A, "completed", UNFOCUSED);

      pruneExpiredThreadAlerts(T0 + 100);
      expect(readThreadAlert(THREAD_A)).toBe("completed");
    });
  });
});
