import { describe, expect, it } from "vite-plus/test";

import { threadEnvironmentActivationAction } from "./threadEnvironmentActivation";

describe("threadEnvironmentActivationAction", () => {
  it("enables a disabled environment", () => {
    expect(threadEnvironmentActivationAction(false)).toBe("enable");
  });

  it("retries an enabled environment independently from connection phase", () => {
    expect(threadEnvironmentActivationAction(true)).toBe("retry");
  });
});
