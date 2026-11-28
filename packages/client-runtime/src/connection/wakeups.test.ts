import { describe, expect, it } from "vite-plus/test";
import {
  reachesConnectionSupervisor,
  resetsRetryBackoff,
  shouldRelistAccountAfterWakeup,
  shouldResubscribeAfterWakeup,
} from "./wakeups.ts";

describe("connection wakeups", () => {
  it("probes live sockets on brief mobile switches without resubscribing streams", () => {
    expect(reachesConnectionSupervisor("application-active-probe")).toBe(true);
    expect(resetsRetryBackoff("application-active-probe")).toBe(true);
    expect(shouldResubscribeAfterWakeup("application-active-probe")).toBe(false);
    expect(shouldRelistAccountAfterWakeup("application-active-probe")).toBe(false);
  });

  it("resubscribes streams on desktop foreground and long mobile resumes", () => {
    expect(shouldResubscribeAfterWakeup("application-active")).toBe(true);
    expect(shouldResubscribeAfterWakeup("application-active-long")).toBe(true);
    expect(shouldResubscribeAfterWakeup("application-focused")).toBe(false);
    expect(shouldResubscribeAfterWakeup("network-changed")).toBe(false);
  });
});
