import { afterEach, describe, expect, it } from "vite-plus/test";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";

import {
  __resetThreadAlertsForTests,
  clearThreadAlert,
  markThreadAlert,
  readThreadAlert,
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

describe("threadAlertStore", () => {
  afterEach(() => {
    __resetThreadAlertsForTests();
  });

  it("has no highlight until something happens", () => {
    expect(readThreadAlert(THREAD_A)).toBeNull();
  });

  it("marks and clears a thread", () => {
    markThreadAlert(THREAD_A, "completed");
    expect(readThreadAlert(THREAD_A)).toBe("completed");

    clearThreadAlert(THREAD_A);
    expect(readThreadAlert(THREAD_A)).toBeNull();
  });

  it("keeps threads independent, including across environments", () => {
    markThreadAlert(THREAD_A, "completed");
    markThreadAlert(THREAD_B, "failed");
    markThreadAlert(THREAD_A_OTHER_ENV, "failed");

    expect(readThreadAlert(THREAD_A)).toBe("completed");
    expect(readThreadAlert(THREAD_B)).toBe("failed");
    expect(readThreadAlert(THREAD_A_OTHER_ENV)).toBe("failed");

    clearThreadAlert(THREAD_A);
    expect(readThreadAlert(THREAD_B)).toBe("failed");
    expect(readThreadAlert(THREAD_A_OTHER_ENV)).toBe("failed");
  });

  it("lets a failure outrank a completion the user has not seen yet", () => {
    markThreadAlert(THREAD_A, "completed");
    markThreadAlert(THREAD_A, "failed");
    expect(readThreadAlert(THREAD_A)).toBe("failed");

    // And does not let a later completion mask that failure.
    markThreadAlert(THREAD_A, "completed");
    expect(readThreadAlert(THREAD_A)).toBe("failed");
  });

  it("re-marks after the user has seen and cleared it", () => {
    markThreadAlert(THREAD_A, "failed");
    clearThreadAlert(THREAD_A);
    markThreadAlert(THREAD_A, "completed");

    expect(readThreadAlert(THREAD_A)).toBe("completed");
  });

  it("ignores clearing a thread that was never marked", () => {
    expect(() => clearThreadAlert(THREAD_A)).not.toThrow();
    expect(readThreadAlert(THREAD_A)).toBeNull();
  });
});
