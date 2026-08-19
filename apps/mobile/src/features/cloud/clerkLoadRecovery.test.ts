import { describe, expect, it } from "vite-plus/test";

import {
  CLERK_LOAD_MAX_AUTO_REMOUNTS,
  CLERK_LOAD_TIMEOUT_MS,
  clerkAccountRowLabel,
  initialClerkLoadRecoveryState,
  reduceClerkLoadRecovery,
  shouldAutoRemountClerk,
  shouldMarkClerkLoadTimedOut,
} from "./clerkLoadRecovery";

describe("shouldAutoRemountClerk", () => {
  const pending = {
    autoRemountCount: 0,
    elapsedMs: CLERK_LOAD_TIMEOUT_MS,
    isActive: true,
    isLoaded: false,
  };

  it("remounts a foreground load that never settles", () => {
    expect(shouldAutoRemountClerk(pending)).toBe(true);
  });

  it("waits until the timeout elapses", () => {
    expect(shouldAutoRemountClerk({ ...pending, elapsedMs: CLERK_LOAD_TIMEOUT_MS - 1 })).toBe(
      false,
    );
  });

  it("does not remount in the background", () => {
    expect(shouldAutoRemountClerk({ ...pending, isActive: false })).toBe(false);
  });

  it("does not remount after Clerk loads", () => {
    expect(shouldAutoRemountClerk({ ...pending, isLoaded: true })).toBe(false);
  });

  it("caps automatic remounts", () => {
    expect(
      shouldAutoRemountClerk({
        ...pending,
        autoRemountCount: CLERK_LOAD_MAX_AUTO_REMOUNTS,
      }),
    ).toBe(false);
  });
});

describe("shouldMarkClerkLoadTimedOut", () => {
  it("keeps Retry after a capped remount still hangs", () => {
    expect(
      shouldMarkClerkLoadTimedOut({
        autoRemountCount: CLERK_LOAD_MAX_AUTO_REMOUNTS,
        elapsedMs: CLERK_LOAD_TIMEOUT_MS,
        isActive: true,
        isLoaded: false,
      }),
    ).toBe(true);
  });

  it("does not time out while automatic remounts remain", () => {
    expect(
      shouldMarkClerkLoadTimedOut({
        autoRemountCount: 0,
        elapsedMs: CLERK_LOAD_TIMEOUT_MS,
        isActive: true,
        isLoaded: false,
      }),
    ).toBe(false);
  });
});

describe("reduceClerkLoadRecovery", () => {
  it("auto remounts until the cap, then stays on Retry", () => {
    let state = initialClerkLoadRecoveryState;
    for (let index = 0; index < CLERK_LOAD_MAX_AUTO_REMOUNTS; index += 1) {
      state = reduceClerkLoadRecovery(state, {
        type: "timeout",
        isActive: true,
        isLoaded: false,
      });
    }
    expect(state).toEqual({
      autoRemountCount: CLERK_LOAD_MAX_AUTO_REMOUNTS,
      generation: CLERK_LOAD_MAX_AUTO_REMOUNTS,
      timedOut: false,
    });

    state = reduceClerkLoadRecovery(state, {
      type: "timeout",
      isActive: true,
      isLoaded: false,
    });
    expect(state.timedOut).toBe(true);
    expect(state.generation).toBe(CLERK_LOAD_MAX_AUTO_REMOUNTS);
  });

  it("does not remount after Clerk loads before the timeout fires", () => {
    const next = reduceClerkLoadRecovery(initialClerkLoadRecoveryState, {
      type: "timeout",
      isActive: true,
      isLoaded: true,
    });
    expect(next).toBe(initialClerkLoadRecoveryState);
  });

  it("manual remount does not increment the auto cap and can time out again", () => {
    let state = {
      autoRemountCount: CLERK_LOAD_MAX_AUTO_REMOUNTS,
      generation: CLERK_LOAD_MAX_AUTO_REMOUNTS,
      timedOut: true,
    };
    state = reduceClerkLoadRecovery(state, { type: "manual-remount" });
    expect(state).toEqual({
      autoRemountCount: CLERK_LOAD_MAX_AUTO_REMOUNTS,
      generation: CLERK_LOAD_MAX_AUTO_REMOUNTS + 1,
      timedOut: false,
    });

    state = reduceClerkLoadRecovery(state, {
      type: "timeout",
      isActive: true,
      isLoaded: false,
    });
    expect(state.timedOut).toBe(true);
    expect(state.generation).toBe(CLERK_LOAD_MAX_AUTO_REMOUNTS + 1);
  });
});

describe("clerkAccountRowLabel", () => {
  it("shows Checking until Clerk loads", () => {
    expect(
      clerkAccountRowLabel({
        email: undefined,
        isLoaded: false,
        isSignedIn: false,
        loadTimedOut: false,
      }),
    ).toBe("Checking");
  });

  it("offers Retry after a hung load", () => {
    expect(
      clerkAccountRowLabel({
        email: undefined,
        isLoaded: false,
        isSignedIn: false,
        loadTimedOut: true,
      }),
    ).toBe("Retry");
  });

  it("shows Sign in when loaded and signed out", () => {
    expect(
      clerkAccountRowLabel({
        email: undefined,
        isLoaded: true,
        isSignedIn: false,
        loadTimedOut: false,
      }),
    ).toBe("Sign in");
  });

  it("prefers the account email when signed in", () => {
    expect(
      clerkAccountRowLabel({
        email: "c@mwolson.org",
        isLoaded: true,
        isSignedIn: true,
        loadTimedOut: false,
      }),
    ).toBe("c@mwolson.org");
  });
});
