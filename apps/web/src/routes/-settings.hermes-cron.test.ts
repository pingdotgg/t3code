import { describe, expect, it } from "vite-plus/test";

import {
  T3_WORK_GATEWAY_DRIVERS,
  T3_WORK_SETTINGS_SCROLL_CLASS_NAME,
} from "./settings.hermes-cron";

describe("T3 Work settings route", () => {
  it("owns scrolling inside the height-constrained settings outlet", () => {
    expect(T3_WORK_SETTINGS_SCROLL_CLASS_NAME).toContain("min-h-0");
    expect(T3_WORK_SETTINGS_SCROLL_CLASS_NAME).toContain("flex-1");
    expect(T3_WORK_SETTINGS_SCROLL_CLASS_NAME).toContain("overflow-y-auto");
  });

  it("places OpenClaw immediately after Hermes in the Agent gateways list", () => {
    expect(T3_WORK_GATEWAY_DRIVERS).toEqual(["hermes", "openclaw"]);
  });
});
