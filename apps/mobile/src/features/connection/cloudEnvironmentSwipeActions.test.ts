import { describe, expect, it } from "vite-plus/test";

import { canDeregisterCloudEnvironment } from "./cloudEnvironmentSwipeActions";

describe("mobile T3 Connect host swipe actions", () => {
  it.each(["available", "offline", "reconnecting", "error"] as const)(
    "allows deregistration while a host is %s",
    (phase) => {
      expect(canDeregisterCloudEnvironment(phase)).toBe(true);
    },
  );

  it.each(["connected", "connecting"] as const)(
    "does not allow deregistration while a host is %s",
    (phase) => {
      expect(canDeregisterCloudEnvironment(phase)).toBe(false);
    },
  );
});
