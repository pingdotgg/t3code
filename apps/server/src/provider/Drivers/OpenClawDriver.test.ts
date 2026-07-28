import { describe, expect, it } from "vite-plus/test";

import { BUILT_IN_DRIVERS } from "../builtInDrivers.ts";
import { OpenClawDriver } from "./OpenClawDriver.ts";

describe("OpenClawDriver", () => {
  it("is a discoverable built-in ACP provider", () => {
    expect(BUILT_IN_DRIVERS).toContain(OpenClawDriver);
    expect(OpenClawDriver.driverKind).toBe("openclaw");
    expect(OpenClawDriver.metadata).toEqual({
      displayName: "OpenClaw",
      supportsMultipleInstances: true,
    });
  });
});
