import { describe, expect, it } from "@effect/vitest";
import * as Option from "effect/Option";

import { EMPTY_SHELL_STATE, shellStreamHealth } from "./shell.ts";
import {
  EMPTY_ENVIRONMENT_THREAD_STATE,
  environmentThreadStreamHealth,
  type EnvironmentThreadState,
} from "./threadState.ts";

const threadState = (overrides: Partial<EnvironmentThreadState>): EnvironmentThreadState => ({
  ...EMPTY_ENVIRONMENT_THREAD_STATE,
  ...overrides,
});

describe("environmentThreadStreamHealth", () => {
  it("reports live only for the live status", () => {
    expect(environmentThreadStreamHealth(threadState({ status: "live" }))).toBe("live");
  });

  it("reports connecting for tracked-but-unerrored states that are not yet live", () => {
    expect(environmentThreadStreamHealth(threadState({ status: "synchronizing" }))).toBe(
      "connecting",
    );
    expect(environmentThreadStreamHealth(EMPTY_ENVIRONMENT_THREAD_STATE)).toBe("connecting");
    // Opening a working thread from cache is the common pre-attach state.
    expect(environmentThreadStreamHealth(threadState({ status: "cached" }))).toBe("connecting");
  });

  it("distinguishes a mid-session drop from a cold start via wasLive", () => {
    // Attached earlier this session, then dropped: detached, not connecting.
    expect(
      environmentThreadStreamHealth(threadState({ status: "synchronizing", wasLive: true })),
    ).toBe("detached");
    expect(environmentThreadStreamHealth(threadState({ status: "cached", wasLive: true }))).toBe(
      "detached",
    );
    // The latch never demotes an active live stream.
    expect(environmentThreadStreamHealth(threadState({ status: "live", wasLive: true }))).toBe(
      "live",
    );
  });

  it("reports detached whenever an error is tracked and the stream is not live", () => {
    expect(
      environmentThreadStreamHealth(threadState({ status: "cached", error: Option.some("boom") })),
    ).toBe("detached");
    expect(
      environmentThreadStreamHealth(
        threadState({ status: "synchronizing", error: Option.some("boom") }),
      ),
    ).toBe("detached");
    expect(
      environmentThreadStreamHealth(threadState({ status: "empty", error: Option.some("boom") })),
    ).toBe("detached");
    // Error precedence over live pins the branch order.
    expect(
      environmentThreadStreamHealth(threadState({ status: "live", error: Option.some("boom") })),
    ).toBe("detached");
  });

  it("reports deleted regardless of error state", () => {
    expect(environmentThreadStreamHealth(threadState({ status: "deleted" }))).toBe("deleted");
  });
});

describe("shellStreamHealth", () => {
  it("is live only for the live status", () => {
    expect(shellStreamHealth({ ...EMPTY_SHELL_STATE, status: "live", wasLive: true })).toBe("live");
  });

  it("reads connecting before the first attach", () => {
    expect(shellStreamHealth(EMPTY_SHELL_STATE)).toBe("connecting");
    expect(shellStreamHealth({ ...EMPTY_SHELL_STATE, status: "synchronizing" })).toBe("connecting");
    expect(shellStreamHealth({ ...EMPTY_SHELL_STATE, status: "cached" })).toBe("connecting");
  });

  it("reads detached after an attach drops", () => {
    expect(shellStreamHealth({ ...EMPTY_SHELL_STATE, status: "cached", wasLive: true })).toBe(
      "detached",
    );
    expect(
      shellStreamHealth({ ...EMPTY_SHELL_STATE, status: "synchronizing", wasLive: true }),
    ).toBe("detached");
  });
});
