import { describe, expect, it } from "vite-plus/test";
import type { EnvironmentId } from "@t3tools/contracts";

import { usageAvailability } from "./usageAvailability";

const mac = {
  environmentId: "mac" as EnvironmentId,
  label: "MacBook Pro",
  summary: {},
};
const newer = {
  environmentId: mac.environmentId,
  direction: "clientBehind" as const,
  contractVersion: 7,
};

describe("usageAvailability", () => {
  it("replaces all-incompatible totals with app-update instructions", () => {
    const result = usageAvailability([mac], [newer]);
    expect(result.hasCompatibleSummary).toBe(false);
    expect(result.notices[0]?.message).toContain("Update this app");
    expect(result.notices[0]?.message).toContain(mac.label);
  });

  it("directs users to the server when the server is too old", () => {
    const result = usageAvailability(
      [mac],
      [{ ...newer, direction: "serverBehind", contractVersion: 3 }],
    );
    expect(result.notices[0]?.message).toContain("Update the T3 Code server on MacBook Pro");
  });

  it("retains compatible summaries, including genuine zero usage", () => {
    expect(usageAvailability([mac], []).hasCompatibleSummary).toBe(true);
    const other = { ...mac, environmentId: "other" as EnvironmentId };
    expect(usageAvailability([mac, other], [newer]).hasCompatibleSummary).toBe(true);
    expect(
      usageAvailability([mac, { ...other, summary: null }], [newer]).hasCompatibleSummary,
    ).toBe(false);
  });

  it("reports failed requests without guessing a version mismatch", () => {
    const result = usageAvailability([{ ...mac, summary: null, error: "failed" }], []);
    expect(result.hasCompatibleSummary).toBe(false);
    expect(result.canRetry).toBe(true);
    expect(result.notices[0]?.message).toContain("Could not load usage from MacBook Pro");
    expect(result.notices[0]?.message).not.toContain("Update");
  });

  it("labels cached data as stale after a failed refresh", () => {
    const result = usageAvailability([{ ...mac, error: "failed" }], []);
    expect(result.hasCompatibleSummary).toBe(true);
    expect(result.notices[0]?.message).toContain("saved usage");
  });

  it("retains healthy totals and reports the failed environment", () => {
    const result = usageAvailability(
      [
        mac,
        {
          ...mac,
          environmentId: "other" as EnvironmentId,
          label: "Other",
          summary: null,
          error: "failed",
        },
      ],
      [],
    );
    expect(result.hasCompatibleSummary).toBe(true);
    expect(result.notices[0]?.message).toContain("Other");
    expect(result.coverageMessage).toContain("exclude unavailable environments");
  });

  it("does not silently omit an environment still loading", () => {
    const result = usageAvailability(
      [mac, { ...mac, environmentId: "other" as EnvironmentId, summary: null }],
      [],
    );
    expect(result.notices[0]?.message).toContain("Waiting for usage");
    expect(result.canRetry).toBe(false);
  });

  it("shows connection guidance without retry for a disconnected environment", () => {
    const result = usageAvailability([{ ...mac, summary: null, isConnected: false }], []);
    expect(result.hasCompatibleSummary).toBe(false);
    expect(result.canRetry).toBe(false);
    expect(result.notices[0]?.message).toContain("Connect to MacBook Pro");
  });

  it("clears notices once the versions are compatible", () => {
    expect(usageAvailability([mac], []).notices).toEqual([]);
  });
});
