import { describe, expect, it } from "@effect/vitest";

import { isApplicationActiveWakeup, shouldResubscribeAfterWakeup } from "./wakeups.ts";

describe("connection wakeups", () => {
  it("recognizes preserved resumes as application activation", () => {
    expect(isApplicationActiveWakeup("application-active-preserved")).toBe(true);
  });

  it("does not resubscribe snapshots after a preserved resume", () => {
    expect(shouldResubscribeAfterWakeup("application-active-preserved")).toBe(false);
    expect(shouldResubscribeAfterWakeup("application-active-probe")).toBe(true);
  });
});
