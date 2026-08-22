import { describe, expect, it } from "vite-plus/test";

import { connectorLeaseCanBeRevoked, connectorSessionIsCurrent } from "./connectorLease.ts";

describe("connectorLeaseCanBeRevoked", () => {
  it("accepts a matching lease and an already absent connector", () => {
    expect(connectorLeaseCanBeRevoked("lease-1", "lease-1")).toBe(true);
    expect(connectorLeaseCanBeRevoked(undefined, "lease-1")).toBe(true);
  });

  it("rejects a stale lease", () => {
    expect(connectorLeaseCanBeRevoked("lease-new", "lease-old")).toBe(false);
  });

  it("allows an explicit unconditional administrative revoke", () => {
    expect(connectorLeaseCanBeRevoked("lease-1", undefined)).toBe(true);
  });
});

describe("connectorSessionIsCurrent", () => {
  it("restores only the active session for the configured lease", () => {
    expect(
      connectorSessionIsCurrent(
        "lease-1",
        { leaseId: "lease-1", sessionId: "session-new" },
        { leaseId: "lease-1", sessionId: "session-new" },
      ),
    ).toBe(true);
    expect(
      connectorSessionIsCurrent(
        "lease-1",
        { leaseId: "lease-1", sessionId: "session-new" },
        { leaseId: "lease-1", sessionId: "session-old" },
      ),
    ).toBe(false);
  });

  it("rejects sessions from a superseded or unconfigured lease", () => {
    const session = { leaseId: "lease-old", sessionId: "session-1" };
    expect(connectorSessionIsCurrent("lease-new", session, session)).toBe(false);
    expect(connectorSessionIsCurrent(undefined, session, session)).toBe(false);
    expect(connectorSessionIsCurrent("lease-old", undefined, session)).toBe(false);
  });
});
