import type { EnvironmentConnectAuthState } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { shouldRetryDesktopConnectAuthState } from "./connectAuthState";

const authState = (
  overrides: Partial<EnvironmentConnectAuthState> = {},
): EnvironmentConnectAuthState => ({
  authorized: false,
  pendingLogin: false,
  authorizationUrl: null,
  accountId: null,
  identity: null,
  ...overrides,
});

describe("desktop Connect auth state retry", () => {
  it("retries before the first auth state response arrives", () => {
    expect(shouldRetryDesktopConnectAuthState(null)).toBe(true);
  });

  it("retries an authorized legacy credential until its account id is backfilled", () => {
    expect(shouldRetryDesktopConnectAuthState(authState({ authorized: true }))).toBe(true);
  });

  it("stops retrying once the state is stable", () => {
    expect(shouldRetryDesktopConnectAuthState(authState())).toBe(false);
    expect(
      shouldRetryDesktopConnectAuthState(authState({ authorized: true, accountId: "user-123" })),
    ).toBe(false);
  });
});
