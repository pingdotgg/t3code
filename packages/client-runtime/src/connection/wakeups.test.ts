import { describe, expect, it } from "@effect/vitest";

import { isApplicationActiveWakeup, shouldResubscribeAfterWakeup } from "./wakeups.ts";

describe("connection wakeups", () => {
  it("probes preserved resumes without restarting subscriptions", () => {
    expect(isApplicationActiveWakeup("application-active-preserved")).toBe(true);
    expect(shouldResubscribeAfterWakeup("application-active-preserved")).toBe(false);
  });
});
